  // 13-per-side-review.js — one-time (and on-demand) review that splits per-side history stored as combined weights
  // =========================================================================
  // Per-side history review
  //
  // `perSide` means every stored weight is ONE side's (see effectiveLoadKg(),
  // 08-progression.js), and the app doubles it into the real load. History
  // written before an exercise carried the flag doesn't follow that: a Fitbod
  // import stores the combined total of both dumbbells, and so do sets typed
  // in by following a suggestion built from those totals. Flip the flag on
  // such an exercise and every one of those numbers is read at twice its real
  // load — which is exactly what happened to the exercises the first
  // correction script flagged.
  //
  // So this finds every exercise that is, or should be, per side, works out
  // set by set which of its history is still combined, and ASKS before
  // changing anything: one screen, one checkbox per exercise. It runs by
  // itself once, on the first launch of the version that introduced it
  // (PER_SIDE_REVIEW_VERSION), and from the Exercises tab whenever wanted.
  //
  // How a set is judged, oldest first, against a running per-side reference:
  //   - marked `splitPerSide` -> already one side's (the importer or an
  //     earlier run of this review converted it): kept, and the reference.
  //   - Fitbod-imported (isImportedSet()) -> the combined total: split it.
  //   - logged in the app, within -25%/+35% of the reference -> already one
  //     side: kept. 1.6x-2.6x the reference -> combined: split. Anything else
  //     -> unclear: left as logged, and counted on the screen.
  //   - logged in the app before there's any reference (an exercise with no
  //     imported history) -> can't be judged from the numbers, so the screen
  //     asks how they were entered.
  // Splitting halves every positive entry of the set; assisted (negative)
  // entries are left alone.
  // =========================================================================
  const PER_SIDE_REVIEW_VERSION = 1;
  // One implement held in both hands, or across the hips: the logged number
  // is already the total, so these are never per side whatever their name.
  const SINGLE_IMPLEMENT_RE = /goblet|hip thrust|glute bridge|pullover|sumo|overhead (?:triceps? )?extension|single dumbbell/i;
  const CATALOG_PER_SIDE_KEYS = new Set(DEFAULT_EXERCISES.filter(d => d.perSide).map(d => nameKey(d.name)));

  function shouldBePerSide(exercise) {
    if (!exercise) return false;
    if (exercise.perSide) return true;
    if (CATALOG_PER_SIDE_KEYS.has(nameKey(exercise.name))) return true;
    return exerciseEquipment(exercise) === 'dumbbell' && !SINGLE_IMPLEMENT_RE.test(exercise.name || '');
  }

  // Written by the Fitbod importer: its timestamps are whole seconds (the
  // export's session time plus one second per row), and an imported day has
  // no session stamp. A set logged in the app carries a millisecond
  // Date.now(), and since the session auto-start every day with a set logged
  // in the app has startedAt.
  function isImportedSet(workout, set) {
    return !workout.startedAt && typeof set.ts === 'number' && set.ts % 1000 === 0;
  }

  // Returns one row per exercise that needs something done:
  // { exerciseId, name, flagged, split: [ref], ask: [ref], unclear, example }
  // where a ref is { workoutId, ts } and `example` is { from, to } in kg.
  function analyzePerSideHistory(exercises, workouts) {
    const setsByExercise = new Map();
    for (const w of workouts) {
      for (const entry of w.exercises || []) {
        if (!setsByExercise.has(entry.exerciseId)) setsByExercise.set(entry.exerciseId, []);
        for (const set of entry.sets || []) setsByExercise.get(entry.exerciseId).push({ workout: w, set });
      }
    }
    const rows = [];
    for (const ex of exercises) {
      if (!shouldBePerSide(ex)) continue;
      const sets = (setsByExercise.get(ex.id) || [])
        .filter(x => { const en = workingEntry(x.set); return en && en.weight > 0; })
        .sort((a, b) => (a.set.ts || 0) - (b.set.ts || 0));
      if (!sets.length) continue;
      const row = { exerciseId: ex.id, name: ex.name, flagged: !!ex.perSide, split: [], ask: [], unclear: 0, example: null };
      let ref = null;
      for (const { workout, set } of sets) {
        const w = workingEntry(set).weight;
        const at = { workoutId: workout.id, ts: set.ts };
        // Already converted to one side — by the importer or by an earlier
        // run of this review. Without this, an imported set still LOOKS
        // imported after being halved, and a second run halved it again.
        if (set.splitPerSide) { ref = w; continue; }
        if (isImportedSet(workout, set)) {
          row.split.push(at);
          if (!row.example) row.example = { from: w, to: w / 2 };
          ref = w / 2;
          continue;
        }
        if (ref == null) {
          // A flagged exercise has been showing "per side" under its weight
          // field, so a number typed against it is taken as one side's.
          if (row.flagged) ref = w; else row.ask.push(at);
          continue;
        }
        const ratio = w / ref;
        if (ratio >= 0.75 && ratio <= 1.35) ref = w;
        else if (ratio >= 1.6 && ratio <= 2.6) {
          row.split.push(at);
          if (!row.example) row.example = { from: w, to: w / 2 };
          ref = w / 2;
        } else row.unclear++;
      }
      if (!row.flagged || row.split.length) rows.push(row);
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  // `decisions` is { [exerciseId]: { checked, how } } — `how` is 'side' or
  // 'combined', and only matters for a row's `ask` sets. Re-reads the store
  // under the workout lock and finds each set by (workout id, ts), so a set
  // logged while the screen was open can't be mistaken for one it listed.
  // All writes go in one transaction (putRecordsAtomically()).
  async function applyPerSideReview(rows, decisions) {
    return withWorkoutLock(async () => {
      const byId = new Map((await getAllWorkouts()).map(w => [w.id, w]));
      const edited = new Map();
      const editable = (workoutId) => {
        if (!edited.has(workoutId) && byId.has(workoutId)) edited.set(workoutId, JSON.parse(JSON.stringify(byId.get(workoutId))));
        return edited.get(workoutId);
      };
      const exercisesToFlag = [];
      let setCount = 0, exerciseCount = 0;
      for (const row of rows) {
        const d = decisions[row.exerciseId];
        if (!d || !d.checked) continue;
        exerciseCount++;
        const targets = row.split.concat(d.how === 'combined' ? row.ask : []);
        for (const { workoutId, ts } of targets) {
          const w = editable(workoutId);
          const entry = w && w.exercises.find(e => e.exerciseId === row.exerciseId);
          const set = entry && entry.sets.find(s => s.ts === ts);
          if (!set || set.splitPerSide) continue;
          set.entries.forEach(en => { if (en.weight > 0) en.weight = Math.round((en.weight / 2) * 100) / 100; });
          // Marked, so no later run (or the importer) ever halves it again.
          set.splitPerSide = true;
          setCount++;
        }
        if (!row.flagged) {
          const ex = await getRecord('exercises', row.exerciseId);
          if (ex) exercisesToFlag.push({ ...ex, perSide: true });
        }
      }
      await putRecordsAtomically({ workouts: [...edited.values()], exercises: exercisesToFlag });
      return { sets: setCount, exercises: exerciseCount };
    });
  }

  // --- The screen -----------------------------------------------------------
  let perSideRows = [];

  function perSideRowHtml(row) {
    const n = row.split.length;
    const example = row.example ? ` (e.g. ${displayWeight(row.example.from)} → ${displayWeight(row.example.to)} ${weightUnit})` : '';
    const parts = [];
    if (row.flagged) parts.push(`Already per side, but ${n} older set${n === 1 ? ' is' : 's are'} the combined weight — halved${example}.`);
    else if (n) parts.push(`Turns on per side; ${n} set${n === 1 ? '' : 's'} stored as the combined weight — halved${example}.`);
    else if (!row.ask.length) parts.push('Turns on per side; the logged sets already look like one dumbbell’s weight.');
    else parts.push('Turns on per side.');
    if (row.unclear) parts.push(`${row.unclear} set${row.unclear === 1 ? '' : 's'} fit neither pattern and stay as logged.`);
    const ask = row.ask.length ? `
      <div class="perside-ask">${row.ask.length} set${row.ask.length === 1 ? '' : 's'} logged in the app, entered as:
        <label><input type="radio" name="perside-how-${row.exerciseId}" value="side" checked> one dumbbell</label>
        <label><input type="radio" name="perside-how-${row.exerciseId}" value="combined"> both combined</label>
      </div>` : '';
    return `
      <div class="perside-row">
        <label class="switch-row"><input type="checkbox" data-exid="${row.exerciseId}" checked><span>${esc(row.name)}</span></label>
        <div class="hint">${esc(parts.join(' '))}</div>${ask}
      </div>`;
  }

  function readPerSideDecisions() {
    const decisions = {};
    document.querySelectorAll('#perside-list input[type="checkbox"][data-exid]').forEach(box => {
      const id = Number(box.dataset.exid);
      const how = document.querySelector(`input[name="perside-how-${id}"]:checked`);
      decisions[id] = { checked: box.checked, how: how ? how.value : 'side' };
    });
    return decisions;
  }

  async function markPerSideReviewed() {
    await setSetting('perSideReviewVersion', PER_SIDE_REVIEW_VERSION);
  }

  // Returns true if the screen was shown. With nothing to fix, the automatic
  // run just records that it happened; an on-demand run says so.
  async function openPerSideReview({ automatic = false } = {}) {
    perSideRows = analyzePerSideHistory(await getAllRecords('exercises'), await getAllWorkouts());
    if (!perSideRows.length) {
      await markPerSideReviewed();
      if (!automatic) toast('Every per-side exercise is already stored one side’s worth');
      return false;
    }
    document.getElementById('perside-list').innerHTML = perSideRows.map(perSideRowHtml).join('');
    document.getElementById('perside-modal').hidden = false;
    return true;
  }

  async function maybeRunPerSideReview() {
    if ((Number(await getSetting('perSideReviewVersion', 0)) || 0) >= PER_SIDE_REVIEW_VERSION) return false;
    return openPerSideReview({ automatic: true });
  }

  async function closePerSideReview() {
    document.getElementById('perside-modal').hidden = true;
    await markPerSideReviewed();
  }

  document.getElementById('perside-skip').addEventListener('click', async () => {
    await closePerSideReview();
    toast('Left as is — run it any time from the Exercises tab');
  });
  document.getElementById('perside-close').addEventListener('click', closePerSideReview);
  document.getElementById('perside-review-btn').addEventListener('click', () => openPerSideReview());
  document.getElementById('perside-apply').addEventListener('click', async () => {
    const btn = document.getElementById('perside-apply');
    btn.disabled = true;
    try {
      const decisions = readPerSideDecisions();
      if (document.getElementById('perside-backup-first').checked) await safetyBackup('per-side-split');
      const result = await applyPerSideReview(perSideRows, decisions);
      await closePerSideReview();
      toast(`Split ${result.sets} set${result.sets === 1 ? '' : 's'} across ${result.exercises} exercise${result.exercises === 1 ? '' : 's'}`);
      invalidateExercisePicker();
      await renderExerciseManager();
      await refreshLogAndHistory();
      await refreshPlanTab();
    } catch (err) {
      reportUnexpected('Per-side split', err);
    } finally {
      btn.disabled = false;
    }
  });
