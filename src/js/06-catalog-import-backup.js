  // 06-catalog-import-backup.js — Exercise manager, classifiers, CSV import, backup & restore
  // =========================================================================
  // Exercise manager (Exercises tab)
  //
  // Search-first: a Fitbod import can push this list past 100 rows, each
  // with two selects and three buttons, which is heavy to keep permanently
  // visible on a phone. Every row shows just its name, a muscle chip and any
  // set preference indicators; tapping a row reveals the muscle/equipment
  // selects and pin/like/dislike buttons underneath it.
  // =========================================================================
  // Delegated actions for #exercise-manager-list, wired once on the
  // container (see delegate() in 03-helpers.js) rather than the five
  // querySelectorAll(...).forEach(...) passes this used to run on every
  // repaint. Wired at the top of renderExerciseManager(), before the
  // early-return for an empty filter result, so the listener is attached
  // even when the filter currently matches nothing.
  const EXERCISE_MANAGER_CHANGE_ACTIONS = {
    'set-muscle': async (el) => {
      const exerciseId = Number(el.dataset.exid);
      const ex = await getRecord('exercises', exerciseId);
      if (!ex) return;
      ex.primaryMuscle = el.value;
      // Stamped so syncDefaultExercises() stops managing this row — without
      // it, editing a BUILT-IN exercise appeared to work, persisted for the
      // session, and was silently reverted on the next page load.
      ex.userEdited = true;
      await putRecord('exercises', ex);
      await populateExerciseSelect();
    },
    'set-equipment': async (el) => {
      const exerciseId = Number(el.dataset.exid);
      const ex = await getRecord('exercises', exerciseId);
      if (!ex) return;
      ex.equipment = el.value;
      ex.userEdited = true;   // see the muscle handler above
      await putRecord('exercises', ex);
      // Equipment decides this exercise's increment floor, so the
      // suggestion shown in Log and Plan is now stale.
      await refreshLogAndHistory();
      await refreshPlanTab();
    },
  };
  // Which row(s) are expanded, same pattern as `expandedExercises` in
  // 09-workout.js — a plain module-level Set survives the re-render a
  // preference change triggers, so opening a row to fix its muscle and then
  // tapping Pin doesn't snap it shut again.
  const expandedExerciseRows = new Set();
  const EXERCISE_MANAGER_CLICK_ACTIONS = {
    'expand-exercise': async (el) => {
      const exerciseId = Number(el.dataset.exid);
      if (expandedExerciseRows.has(exerciseId)) {
        expandedExerciseRows.delete(exerciseId);
      } else {
        // One row open at a time keeps a filtered list from growing a long
        // trail of stale expansions as you search your way around it.
        expandedExerciseRows.clear();
        expandedExerciseRows.add(exerciseId);
      }
      await renderExerciseManager();
    },
    'pin': async (el) => {
      const exerciseId = Number(el.dataset.exid);
      const pref = await getExercisePref(exerciseId);
      const willPin = !(pref && pref.pinned);
      await setExercisePref(exerciseId, { pinned: willPin, disliked: willPin ? false : (pref ? pref.disliked : false) });
      await renderExerciseManager();
    },
    'like': async (el) => {
      const exerciseId = Number(el.dataset.exid);
      const pref = await getExercisePref(exerciseId);
      const willLike = !(pref && pref.liked);
      await setExercisePref(exerciseId, { liked: willLike, disliked: false });
      await renderExerciseManager();
    },
    'dislike': async (el) => {
      const exerciseId = Number(el.dataset.exid);
      const pref = await getExercisePref(exerciseId);
      const willDislike = !(pref && pref.disliked);
      await setExercisePref(exerciseId, { disliked: willDislike, liked: false, pinned: willDislike ? false : (pref ? pref.pinned : false) });
      await renderExerciseManager();
    },
  };

  async function renderExerciseManager() {
    const exercises = await getAllRecords('exercises');
    const prefs = await getAllRecords('exercisePrefs');
    const prefsById = Object.fromEntries(prefs.map(p => [p.exerciseId, p]));
    const musclesById = Object.fromEntries(MUSCLES.map(m => [m.id, m]));
    const container = document.getElementById('exercise-manager-list');
    delegate(container, 'change', EXERCISE_MANAGER_CHANGE_ACTIONS);
    delegate(container, 'click', EXERCISE_MANAGER_CLICK_ACTIONS);

    const countEl = document.getElementById('exercise-count-hint');
    if (countEl) {
      const customCount = exercises.filter(ex => ex.custom).length;
      countEl.textContent = `${exercises.length} exercise${exercises.length === 1 ? '' : 's'} · ${customCount} custom`;
    }

    // Matched the same way the History search matches an exercise name —
    // nameKey(), not a bare toLowerCase() — so "Pull-Up" finds "Pull Up".
    const filter = (document.getElementById('exercise-filter').value || '').trim();
    const filterKey = nameKey(filter);
    const visible = filterKey ? exercises.filter(ex => nameKey(ex.name).includes(filterKey)) : exercises;
    if (visible.length === 0) {
      container.innerHTML = `<div class="ex-row" style="cursor:default;"><span class="ex-row-name" style="color:var(--text-faint); font-weight:400;">No exercises match "${esc(filter)}".</span></div>`;
      return;
    }
    container.innerHTML = visible.sort((a, b) => a.name.localeCompare(b.name)).map(ex => {
      const pref = prefsById[ex.id] || { pinned: false, liked: false, disliked: false };
      const muscleName = (musclesById[ex.primaryMuscle] || { name: 'Unclassified' }).name;
      const expanded = expandedExerciseRows.has(ex.id);
      return `
        <div class="ex-row" data-exid="${ex.id}" data-action="expand-exercise">
          <span class="ex-row-name">${esc(ex.name)}</span>
          <span class="ex-row-chips">
            <span class="sugg-tag">${esc(muscleName)}</span>
            ${pref.pinned ? '<span class="ex-row-indicator" title="Pinned">📌</span>' : ''}
            ${pref.liked ? '<span class="ex-row-indicator" title="Liked">👍</span>' : ''}
            ${pref.disliked ? '<span class="ex-row-indicator" title="Disliked">👎</span>' : ''}
          </span>
        </div>
        <div class="ex-row-details${expanded ? ' expanded' : ''}">
          <select class="ex-muscle-select" data-exid="${ex.id}" data-action="set-muscle">
            ${MUSCLES.map(m => `<option value="${m.id}" ${m.id === ex.primaryMuscle ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select>
          <select class="ex-equip-select" data-exid="${ex.id}" data-action="set-equipment" title="Equipment — sets the smallest weight jump this exercise can advance by">
            ${EQUIPMENT.map(q => `<option value="${q.id}" ${q.id === exerciseEquipment(ex) ? 'selected' : ''}>${esc(q.name)}</option>`).join('')}
          </select>
          <button class="pref-btn pin-btn ${pref.pinned ? 'active' : ''}" data-exid="${ex.id}" data-action="pin" title="Pin — always include this exercise whenever its muscle is trained in a generated plan">📌</button>
          <button class="pref-btn like-btn ${pref.liked ? 'active' : ''}" data-exid="${ex.id}" data-action="like" title="Like — AI prefers including this exercise">👍</button>
          <button class="pref-btn dislike-btn ${pref.disliked ? 'active' : ''}" data-exid="${ex.id}" data-action="dislike" title="Dislike — never suggested by AI">👎</button>
        </div>
      `;
    }).join('');
  }

  document.getElementById('exercise-filter').addEventListener('input', () => { renderExerciseManager(); });

  document.getElementById('new-exercise-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-ex-name').value.trim();
    const muscle = document.getElementById('new-ex-muscle').value;
    if (!name) return;
    // nameKey() is THE key for name matching (see its comment above) — block
    // a near-miss duplicate rather than forking the exercise's history in two.
    const existing = (await getAllRecords('exercises')).find(ex => nameKey(ex.name) === nameKey(name));
    if (existing) { toast(`"${existing.name}" already exists`, 'err'); return; }
    await addRecord('exercises', { name, primaryMuscle: muscle, secondaryMuscles: [], equipment: classifyEquipmentFromName(name), custom: true });
    document.getElementById('new-exercise-form').reset();
    await renderExerciseManager();
    await populateExerciseSelect();
    toast(`Added ${name}`);
  });

  // =========================================================================
  // CSV import (Fitbod export)
  //
  // Fitbod's export is one row per completed set, with the whole session
  // sharing one timestamp (not per-set) — confirmed by inspecting a real
  // export: every row in a session shows the exact same Date value. That
  // makes grouping straightforward: group rows by the LOCAL calendar date
  // derived from that timestamp (not the raw string), which both
  // reconstructs sessions and naturally merges same-day sessions into this
  // app's one-workout-per-day model if that ever happens.
  //
  // Weight(kg) is the per-implement weight; `multiplier` (confirmed via
  // real data: 2.0 for dumbbells/some cables, 1.0 for barbell/machine/single
  // cable, 0.0 for bodyweight/assisted/stretch work) scales it to total
  // load: effective weight = Weight(kg) * multiplier. Floating-point noise
  // in the source (it's clearly lb-based data round-tripped through a kg
  // conversion, e.g. 54.431084445645396 kg is exactly 120 lb) gets rounded
  // to 2 decimals on import.
  //
  // Preview-then-confirm rather than importing on file select: this is a
  // one-time bulk write potentially touching hundreds of records, worth
  // seeing a summary before committing.
  // =========================================================================
  let pendingImport = null;

  // Guess a primary muscle from an exercise name. A Fitbod CSV carries no
  // muscle data at all, so the name is the only signal available.
  //
  // FIRST MATCH WINS, so the list runs specific -> generic and the order is
  // load-bearing. The ones that actually bite:
  //   - rear delts before chest, or /\bfly\b/ claims "Rear Delt Fly"
  //   - calves first, or a "raise" rule claims "Calf Raise"
  //   - triceps before chest, or /bench press/ claims "Close-Grip Bench Press"
  //   - shoulders before chest, or /push-?up/ claims "Pike Push Up"
  //   - hamstrings before glutes, or /\bglute/ claims "Glute Ham Raise"
  //   - upper back before lats, or /pull-?up/ claims "Scap Pull Up"
  //   - the bare /\bcurl\b/ = biceps fallback sits dead last, after leg curls,
  //     wrist curls, reverse curls and Jefferson curls have been claimed
  //
  // A miss returns 'unclassified' rather than a guess. That is deliberate: an
  // obviously empty muscle field on the Exercises tab is cheaper to
  // fix than a set silently credited to the wrong muscle in the weekly-sets
  // chart, where nothing looks wrong. Pure cardio (bike, treadmill, row erg)
  // correctly falls through -- it isn't resistance work and shouldn't score.
  // Same first-match-wins shape as the muscle classifier, and the same policy:
  // guess from the name, fall back to a neutral bucket rather than a wrong
  // confident answer. Order matters for the usual reason — "Machine Bench
  // Press" must reach the machine rule before /bench press/ claims it for
  // barbell, and "Dumbbell Bench Press" before either.
  function classifyEquipmentFromName(name) {
    const n = name.toLowerCase();
    const rules = [
      [/assisted/, 'assisted'],
      [/\bcable\b|\brope\b|pull[\s-]?down|face pull|cross[\s-]?over|pallof|push[\s-]?down|pressdown/, 'cable'],
      [/machine|smith|pec deck|hammerstrength|hammer strength|\bsled\b|leg press|hack squat|leg extension|leg curl|hamstrings? curl|\bstack\b|reverse pec|chest[\s-]?supported|seated calf/, 'machine'],
      [/dumbbell|\bdb\b|goblet|arnold|zottman|hammer curl|farmer|concentration curl|spider curl|kickback|lateral raise|side raise|front raise|rear delt|reverse fly|rear fly|split squat/, 'dumbbell'],
      [/push[\s-]?up|pull[\s-]?up|chin[\s-]?up|\bdips?\b|plank|hanging|inverted row|nordic|superman|dead bug|bird dog|russian twist|mountain climber|\bl[\s-]?sit\b|dragon flag|toes[\s-]?to[\s-]?bar|copenhagen|ab wheel|roll[\s-]?out|sit[\s-]?up|crunch|glute bridge|wall sit|back extension|hyper ?extension|reverse hyper|lunge|step[\s-]?up|\btrx\b|suspension|\brings?\b|knee raise|leg raise/, 'bodyweight'],
      [/barbell|\bbb\b|deadlift|squat|bench press|overhead press|military press|push press|\bz press\b|good morning|shrug|rack pull|romanian|stiff-?legged|close[\s-]?grip|skull ?crusher|preacher|upright row|hip thrust|landmine|t[\s-]?bar|clean|snatch|\bpress\b|\brow\b|\bcurl\b|\braise\b|\bfly\b|extension/, 'barbell']
    ];
    for (const [re, equip] of rules) if (re.test(n)) return equip;
    return 'other';
  }

  function classifyMuscleFromName(name) {
    const n = name.toLowerCase();
    const rules = [
      // ---- Lower body ----
      [/\bcalf|calves|toe press/, 'calves'],
      [/leg curl|hamstring|ham curl|stiff-?legged? deadlift|romanian deadlift|\brdl\b|good morning|nordic|glute ham|\bghr\b/, 'hamstrings'],
      [/squat|leg press|leg extension|knee extension|lunge|step[\s-]?up|sissy|\bquad|bulgarian|\bhack\b|wall sit/, 'quads'],
      [/hip thrust|glute bridge|hip extension|\bglute|abduct|outer thigh|hip kickback|donkey kick|frog pump|\bbridge\b|kettlebell swing|\bkb swing/, 'glutes'],
      [/hip flexor|adduct|inner thigh|copenhagen|\bgroin\b/, 'adductors'],
      [/deadlift/, 'hamstrings'],

      // ---- Shoulders (before chest: /\bfly\b/ and /push-?up/ are greedy) ----
      [/rear delt|face pull|reverse fly|reverse pec|rear fly|deltoid fly|bent[\s-]?over (?:reverse|lateral)|prone y|\by raise|\bt raise|\bw raise/, 'rear_delts'],
      [/lateral raise|side raise|lat raise|upright row|\bl[\s-]?fly\b/, 'side_delts'],
      [/overhead press|shoulder press|military press|arnold press|push press|pike push|landmine press|front raise|\bohp\b|\bz press\b/, 'front_delts'],

      // ---- Arms (triceps before chest: close-grip bench, bench dip) ----
      [/tricep|skull ?crusher|push[\s-]?down|pressdown|close[\s-]?grip bench|bench dip|french press|\bjm press\b|overhead extension|kickback/, 'triceps'],

      // ---- Chest ----
      [/bench press|chest press|dumbbell press|\bdb press|incline press|decline press|\bfly\b|\bflye\b|pec deck|\bpec\b|cross[\s-]?over|push[\s-]?up|\bdips?\b|floor press|svend/, 'chest'],

      // ---- Back ----
      [/shrug|\btraps?\b|upper back|rack pull|\bscap|high pull/, 'upper_back'],
      [/pull[\s-]?down|pull[\s-]?up|chin[\s-]?up|\brow\b|\blats?\b|pullover|archer pull|straight[\s-]?arm/, 'lats'],

      // ---- Arms, continued ----
      [/bicep|preacher|hammer curl|concentration curl|spider curl|drag curl|incline curl/, 'biceps'],
      [/forearm|wrist curl|wrist extension|reverse curl|farmer|\bgrip\b|zottman|\bulnar|radial deviation/, 'forearms'],

      // ---- Core ----
      [/crunch|\babs?\b|plank|dead bug|bird dog|sit[\s-]?up|leg raise|knee raise|knee tuck|cat cow|pallof|roll[\s-]?out|ab wheel|hollow|russian twist|wood ?chop|mountain climber|toes[\s-]?to[\s-]?bar|\bl[\s-]?sit\b|side bend|oblique|\bcore\b|windshield|dragon flag/, 'abs'],
      [/back extension|hyper ?extension|lower back|superman|reverse hyper|jefferson curl|\bghd\b/, 'lower_back'],

      // ---- Last resort ----
      [/\bcurl\b/, 'biceps']
    ];
    for (const [re, muscle] of rules) if (re.test(n)) return muscle;
    return 'unclassified';
  }

  // Quote-aware field splitting.
  //
  // Fitbod's own export doesn't quote anything, which is why a bare
  // split(',') survived this long. But a file that has been through a
  // spreadsheet on the way here WILL quote any field containing a comma, and
  // that failed in the worst possible way: `"Row, Machine"` splits into MORE
  // columns than the header, so it sails straight past the too-few-columns
  // guard below and shifts every field after it by one — reps read from the
  // weight column, weight from isWarmup, silently, for the whole file.
  //
  // Handles doubled "" escapes. A quoted field containing a literal NEWLINE is
  // still out of scope (the text is split into lines first); no exporter in
  // play here produces one, and the row-length guard rejects the fragments.
  function splitCsvLine(line) {
    const out = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c !== '"') { cur += c; continue; }
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  function parseFitbodCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) throw new Error('CSV appears to be empty.');
    const header = splitCsvLine(lines[0]).map(h => h.trim());
    const col = {
      date: header.indexOf('Date'),
      exercise: header.indexOf('Exercise'),
      reps: header.indexOf('Reps'),
      weight: header.indexOf('Weight(kg)'),
      isWarmup: header.indexOf('isWarmup'),
      multiplier: header.indexOf('multiplier')
    };
    if (col.date === -1 || col.exercise === -1 || col.reps === -1 || col.weight === -1) {
      throw new Error('This doesn’t look like a Fitbod export — expected columns (Date, Exercise, Reps, Weight(kg)) weren’t found.');
    }

    const byDate = new Map(); // localDate -> { ts, setCounter, exercises: Map<nameLower, {name, sets:[{ts,reps,weight}]}> }
    let skippedNoReps = 0, skippedWarmup = 0, skippedBadRow = 0, assistedSets = 0, badMultiplierSets = 0;
    // Only Date/Exercise/Reps/Weight(kg) are required (see the docs above and
    // the format-guard a few lines up); isWarmup and multiplier are optional
    // trailing columns that already degrade safely to defaults when read
    // out-of-bounds. A row is only genuinely malformed if it's too short to
    // hold a REQUIRED column — not merely shorter than the full header, which
    // rejected an otherwise-good row whenever a spreadsheet re-save trimmed a
    // trailing blank optional cell.
    const minCols = Math.max(col.date, col.exercise, col.reps, col.weight) + 1;

    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i]);
      if (cols.length < minCols) { skippedBadRow++; continue; }
      const name = (cols[col.exercise] || '').trim();
      const reps = parseInt(cols[col.reps], 10);
      if (!name || isNaN(reps) || reps <= 0) { skippedNoReps++; continue; }
      if (col.isWarmup >= 0 && (cols[col.isWarmup] || '').trim().toLowerCase() === 'true') { skippedWarmup++; continue; }

      const rawDate = (cols[col.date] || '').trim();
      const isoLike = rawDate.replace(' ', 'T').replace(/ ?\+0000$/, 'Z');
      const d = new Date(isoLike);
      if (isNaN(d.getTime())) { skippedBadRow++; continue; }
      const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

      const weightKg = parseFloat(cols[col.weight]);
      const rawMultiplier = col.multiplier >= 0 ? parseFloat(cols[col.multiplier]) : 1;
      // A blank/unparseable multiplier cell (column present, value isn't) is
      // silently defaulted to 1.0 rather than dropping the row — but silently
      // is the problem: for a dumbbell/dual-implement exercise that should
      // have been 2.0, a defaulted 1.0 HALVES the effective weight with
      // nothing in the summary to flag it. Count it like every other
      // skip/warning category so it surfaces there instead.
      if (col.multiplier >= 0 && isNaN(rawMultiplier)) badMultiplierSets++;
      const multiplier = isNaN(rawMultiplier) ? 1 : rawMultiplier;
      const w = isNaN(weightKg) ? 0 : weightKg;
      // multiplier 0 means "this load isn't on you". Two distinct cases in a
      // real export, cleanly separated by whether Weight(kg) is populated:
      //   w > 0  -> ASSISTED machine work (Assisted Pull Up / Dip). That
      //             weight is the assistance, so it's stored NEGATIVE — the
      //             app's convention for load taken off you. Multiplying it
      //             by 0 (the old behaviour) threw the number away and made
      //             every assisted set look like a bodyweight set at 0kg.
      //   w == 0 -> genuinely unloaded (stretches, Air Bike); those all carry
      //             reps 0 and are already skipped above.
      const effectiveWeight = (multiplier === 0 && w > 0)
        ? -Math.round(w * 100) / 100
        : Math.round(w * multiplier * 100) / 100;
      if (effectiveWeight < 0) assistedSets++;

      if (!byDate.has(localDate)) byDate.set(localDate, { ts: d.getTime(), setCounter: 0, exercises: new Map() });
      const dayEntry = byDate.get(localDate);
      dayEntry.ts = Math.min(dayEntry.ts, d.getTime());
      const key = nameKey(name);
      if (!dayEntry.exercises.has(key)) dayEntry.exercises.set(key, { name, sets: [] });
      // Fitbod stamps every set in a session with the same session-start
      // time, so a synthetic 1s-per-row increment (in original file order)
      // keeps sets orderable without relying on tied timestamps + sort
      // stability.
      dayEntry.exercises.get(key).sets.push({ ts: dayEntry.ts + dayEntry.setCounter * 1000, reps, weight: effectiveWeight });
      dayEntry.setCounter++;
    }

    return { byDate, skippedNoReps, skippedWarmup, skippedBadRow, assistedSets, badMultiplierSets };
  }

  document.getElementById('import-form').addEventListener('submit', (e) => e.preventDefault());

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const errBox = document.getElementById('import-error');
    const successBox = document.getElementById('import-success');
    const previewWrap = document.getElementById('import-preview');
    errBox.style.display = 'none';
    successBox.style.display = 'none';
    previewWrap.style.display = 'none';
    pendingImport = null;
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseFitbodCSV(text);
      const dates = [...parsed.byDate.keys()].sort();
      if (dates.length === 0) throw new Error('No importable sets found in this file (every row was skipped).');
      let totalSets = 0;
      const exerciseNames = new Set();
      parsed.byDate.forEach(d => d.exercises.forEach(ex => {
        totalSets += ex.sets.length;
        exerciseNames.add(ex.name.toLowerCase());
      }));

      pendingImport = parsed;
      const notes = [];
      if (parsed.skippedWarmup) notes.push(`${parsed.skippedWarmup} warmup set(s) excluded`);
      if (parsed.skippedNoReps) notes.push(`${parsed.skippedNoReps} row(s) skipped (no reps — likely cardio/duration-only entries)`);
      if (parsed.skippedBadRow) notes.push(`${parsed.skippedBadRow} malformed row(s) skipped`);
      if (parsed.assistedSets) notes.push(`${parsed.assistedSets} assisted set(s) detected and stored as negative weight`);
      if (parsed.badMultiplierSets) notes.push(`${parsed.badMultiplierSets} set(s) had a missing/unparseable multiplier and were assumed ×1.0 — verify dumbbell/dual-implement sets`);
      document.getElementById('import-preview-text').textContent =
        `Found ${totalSets} sets across ${dates.length} day(s), ${dates[0]} to ${dates[dates.length - 1]}, ` +
        `${exerciseNames.size} distinct exercise name(s).` +
        (notes.length ? ` ${notes.join('; ')}.` : '');
      previewWrap.style.display = 'block';
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  });

  document.getElementById('import-confirm-btn').addEventListener('click', async () => {
    if (!pendingImport) return;
    const btn = document.getElementById('import-confirm-btn');
    const errBox = document.getElementById('import-error');
    const successBox = document.getElementById('import-success');
    btn.disabled = true; btn.textContent = 'Importing…';
    errBox.style.display = 'none';
    try {
      const allExercises = await getAllRecords('exercises');
      const byNameLower = new Map(allExercises.map(e => [nameKey(e.name), e]));
      let newExerciseCount = 0, unclassifiedCount = 0, importedSets = 0, importedDays = 0;
      const replaceMode = document.getElementById('import-mode').value === 'replace';
      const clearedKeys = new Set();
      let replacedSets = 0;

      // One read for the whole import. This loop used to call
      // getWorkoutForDate() per date, which was a full store scan each time —
      // 33 scans for a 33-day export, and quadratic against a long history.
      const existingByDate = new Map((await getAllWorkouts()).map(w => [w.date, w]));
      for (const [localDate, dayEntry] of pendingImport.byDate) {
        let workout = existingByDate.get(localDate) || null;
        if (!workout) workout = { date: localDate, ts: dayEntry.ts, planId: null, dayIndex: null, dayName: null, exercises: [] };
        for (const [, exInfo] of dayEntry.exercises) {
          const key = nameKey(exInfo.name);
          let exRecord = byNameLower.get(key);
          if (!exRecord) {
            const primaryMuscle = classifyMuscleFromName(exInfo.name);
            if (primaryMuscle === 'unclassified') unclassifiedCount++;
            const newId = await addRecord('exercises', { name: exInfo.name, primaryMuscle, secondaryMuscles: [], equipment: classifyEquipmentFromName(exInfo.name), custom: true });
            exRecord = { id: newId, name: exInfo.name, primaryMuscle };
            byNameLower.set(key, exRecord);
            newExerciseCount++;
          }
          let workoutExEntry = workout.exercises.find(ex => ex.exerciseId === exRecord.id);
          if (!workoutExEntry) { workoutExEntry = { exerciseId: exRecord.id, sets: [] }; workout.exercises.push(workoutExEntry); }
          // Replace mode clears this exercise's existing sets on this day
          // before writing the file's, so re-importing a corrected export
          // doesn't double everything up. Scoped per exercise per day, so
          // anything logged in-app that the file doesn't mention survives.
          if (replaceMode && !clearedKeys.has(`${localDate}|${exRecord.id}`)) {
            replacedSets += workoutExEntry.sets.length;
            workoutExEntry.sets = [];
            clearedKeys.add(`${localDate}|${exRecord.id}`);
          }
          exInfo.sets.forEach(s => {
            workoutExEntry.sets.push({ ts: s.ts, type: 'standard', entries: [{ weight: s.weight, reps: s.reps }] });
            importedSets++;
          });
        }
        await putRecord('workouts', workout);
        importedDays++;
      }

      successBox.textContent = `Imported ${importedSets} sets across ${importedDays} day(s).` +
        (replacedSets ? ` Replaced ${replacedSets} previously imported set(s).` : '') +
        ` ${newExerciseCount} new exercise(s) created` +
        (unclassifiedCount ? `, ${unclassifiedCount} of which couldn’t be auto-classified — check the Exercises tab and reassign their muscle group.` : '.');
      successBox.style.display = 'block';
      pendingImport = null;
      document.getElementById('import-preview').style.display = 'none';
      document.getElementById('import-file').value = '';
      // The data is already committed at this point — everything below is
      // just repainting. Failing here must NOT be reported as "Import
      // failed", which is what happened before and sent the user hunting for
      // a data problem that didn't exist.
      try {
        await populateExerciseSelect();
        await renderExerciseManager();
        await refreshLogAndHistory();
        await refreshPlanTab();
      } catch (renderErr) {
        errBox.textContent = `Import succeeded, but refreshing the screen failed: ${renderErr.message}. Your data is saved — reload the page.`;
        errBox.style.display = 'block';
      }
    } catch (err) {
      errBox.textContent = `Import failed: ${err.message}`;
      errBox.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'Confirm Import';
    }
  });

  // =========================================================================
  // Backup & restore
  //
  // The one thing this app had no answer for. Everything lives in a single
  // browser profile's IndexedDB: "Clear browsing data" erases it without
  // ceremony, and Safari evicts unused site data after about seven days of
  // non-use — which for an app you might not open for a fortnight is a live
  // risk, not a theoretical one. A local-only design is a legitimate choice;
  // a local-only design with no way to get the data OUT is a trap.
  //
  // Deliberately a plain, versioned, human-readable JSON document rather than
  // anything clever. Three reasons: it survives this app (you can read your
  // own training history in a text editor in ten years), it is diffable, and
  // it is exactly the payload a cloud-storage sync would push and pull — so
  // adding Google Drive later is a transport on top of this, not a rewrite of
  // it. BACKUP_FORMAT_VERSION is what lets a future reader know what it is
  // looking at; `appDbVersion` records the schema the records were written
  // under, so a restore into a newer app can tell whether a migration is owed.
  // =========================================================================
  // Deliberately still 'ironlog-backup' after the app was renamed to
  // SplitCraft: this is the marker validateBackup() checks against every file
  // a user tries to restore, including ones exported years ago. Changing it
  // would make every backup already sitting in someone's cloud storage or
  // inbox unrestorable — this string crosses the origin boundary the app is
  // about to move across, so it has to keep meaning what it always meant.
  const BACKUP_FORMAT = 'ironlog-backup';
  const BACKUP_FORMAT_VERSION = 1;
  // Never exported. The whole point of the file is that it can be parked in
  // cloud storage or emailed to yourself, and a long-lived API key with
  // spending attached has no business travelling with it. Restore therefore
  // also never clobbers the key already on the device.
  //
  // `lastBackupAt` is excluded for a different reason: it describes THIS
  // device's own backup habit, not the training data, so it has no business
  // riding along as an ordinary setting either. Restore sets it deliberately
  // instead, from the restored FILE's own `exportedAt` — see the comment at
  // the restore-button handler below for why that's the honest value and a
  // blindly-carried-over one wouldn't be.
  // dropboxRefreshToken joins openrouterKey for the same reason: it's a
  // credential for a SEPARATE service, excluded so a file meant to be
  // emailed or dropped in cloud storage doesn't also hand over this app's
  // Dropbox access to whoever it's shared with. See the Dropbox subsystem
  // below for what the token can and can't reach.
  const BACKUP_EXCLUDED_SETTINGS = ['openrouterKey', 'lastBackupAt', 'dropboxRefreshToken'];

  // How long a backup gets to sit before the Settings reminder calls it
  // stale rather than just old. 30 days is long enough that someone backing
  // up every week or two never sees it, short enough to flag a device that's
  // gone genuinely forgotten before whatever finally clears its storage
  // does. Picked, not measured — there's no data on how long is "too long"
  // for a personal weight-training log, only a judgment that a month of
  // silence is worth a nudge.
  const BACKUP_STALE_DAYS = 30;

  // Paints the storage-mode line next to the backup section — see
  // requestPersistentStorage() in 02-storage.js for why the app asks for this
  // at all. Takes the ALREADY-COMPUTED request result rather than calling
  // requestPersistentStorage() itself: that call happens exactly once, from
  // init(), so reopening or re-rendering Settings never re-triggers the
  // persist() request. This function only ever displays what init() found.
  async function renderStorageStatus(status) {
    const el = document.getElementById('storage-status');
    if (!el) return;
    const line = (status && status.persisted)
      ? 'Storage: persistent — the browser will not evict this data automatically.'
      : 'Storage: best-effort — export a backup regularly.';
    // estimate() is independent of persist()/persisted() (see
    // getStorageEstimate()'s comment) and safe to call fresh on every render.
    const estimate = await getStorageEstimate();
    el.textContent = estimate
      ? `${line} (${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} quota used)`
      : line;
  }

  // Human-scale byte formatting for the line above — the raw numbers
  // navigator.storage.estimate() returns ("1234567 of 60000000000") mean
  // nothing to someone deciding whether to trust the browser with their data.
  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = n, i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  }

  // Human-scale phrasing for the "Last backup" line below storage-status.
  // Day-granularity only — "3 hours ago" would just invite treating a backup
  // made this morning as somehow different from one made last night, which
  // isn't a distinction this reminder needs to make.
  function formatBackupAge(ts) {
    if (!ts) return 'No backup yet';
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0) return 'Last backup: today';
    if (days === 1) return 'Last backup: 1 day ago';
    return `Last backup: ${days} days ago`;
  }

  // Paints the "Last backup" line. The stale/never-backed-up case gets a
  // color change via the `.stale` class — not a border, a card, or anything
  // that reads as a warning dialog. A forgotten backup deserves noticing,
  // not alarm; this app doesn't do red banners for something that isn't an
  // error. Called on load and again right after every backup or restore
  // completes, so the line is never stale itself.
  async function renderBackupFreshness() {
    const el = document.getElementById('backup-freshness');
    if (!el) return;
    const ts = await getSetting('lastBackupAt', null);
    const stale = !ts || (Date.now() - ts) >= BACKUP_STALE_DAYS * 86400000;
    el.textContent = formatBackupAge(ts);
    el.classList.toggle('stale', stale);
  }

  async function buildBackup() {
    const [workouts, exercises, exercisePrefs, plans] = await Promise.all([
      getAllWorkouts(),
      getAllRecords('exercises'),
      getAllRecords('exercisePrefs'),
      getAllRecords('plans')
    ]);
    // Settings is a key/value store; flatten it to a plain object so the file
    // reads as settings rather than as a list of two-field records.
    //
    // The two storage backends hand this back in DIFFERENT shapes, which is a
    // wrinkle nothing else in the app had to care about: IndexedDB's getAll()
    // returns an array of {key, value} records, while the in-memory fallback
    // keeps `memory.settings` as a plain object because that is what every
    // other caller wants. Export is the one place that reads the whole store
    // at once, so it is the one place that has to handle both — and the
    // fallback path is exactly the case where a backup matters MOST, since
    // that data dies on reload otherwise.
    const settingRows = await getAllRecords('settings');
    const settings = {};
    const keep = (key, value) => {
      if (key && !BACKUP_EXCLUDED_SETTINGS.includes(key)) settings[key] = value;
    };
    if (Array.isArray(settingRows)) settingRows.forEach(r => { if (r) keep(r.key, r.value); });
    else Object.entries(settingRows || {}).forEach(([k, v]) => keep(k, v));
    const totalSets = workouts.reduce(
      (a, w) => a + w.exercises.reduce((b, ex) => b + ex.sets.length, 0), 0);
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      appDbVersion: DB_VERSION,
      exportedAt: new Date().toISOString(),
      counts: { workouts: workouts.length, sets: totalSets, exercises: exercises.length, plans: plans.length },
      note: 'SplitCraft backup. The OpenRouter API key is deliberately not included.',
      data: { workouts, exercises, exercisePrefs: exercisePrefs || [], plans, settings }
    };
  }

  // =========================================================================
  // Encrypted backups — OPTIONAL passphrase protection on top of buildBackup()
  //
  // Plaintext stays the default and always will: the whole point of the
  // format above is that it survives this app (readable in a text editor in
  // ten years), and mandatory encryption would take that away from everyone
  // to protect the minority who want it. This is an alternate envelope a
  // user opts into per-export, not a replacement for the plain one.
  //
  // WebCrypto only, no libraries: PBKDF2/SHA-256 at PBKDF2_ITERATIONS (chosen
  // to be slow enough on 2024-era hardware — a few hundred ms to a couple of
  // seconds on a phone — to make brute-forcing a short passphrase expensive,
  // per OWASP's current PBKDF2-SHA256 guidance) derives a 256-bit AES-GCM
  // key from the passphrase and a fresh random salt; a fresh random IV goes
  // with every encryption. Salt and IV are NEVER reused — both are
  // regenerated from crypto.getRandomValues() on every single export, so two
  // backups of identical data still produce completely different ciphertext.
  //
  // What gets encrypted is the ENTIRE plaintext backup object (the same
  // object buildBackup() returns — format, version, counts, data, all of
  // it), not just the `data` section. That is what lets validateBackup()
  // decrypt-then-recurse into its ordinary, already-battle-tested validation
  // path below: the decrypted bytes are just another plaintext backup, so
  // every guarantee that path already gives (deep structural checks before
  // the destructive restore button is offered) applies unchanged to an
  // encrypted file too, without a second copy of that logic to keep in sync.
  // =========================================================================
  const PBKDF2_ITERATIONS = 600000;
  const PBKDF2_HASH = 'SHA-256';

  // Minimal base64 codec for shipping binary crypto output (salt, IV,
  // ciphertext) inside JSON. Deliberately not btoa/atob: those want a
  // "binary string" (one code unit per byte), and getting a Uint8Array into
  // that shape via String.fromCharCode(...bytes) spreads the whole buffer
  // across a single call's argument list — fine for a few bytes, a stack
  // overflow risk for a backup with years of history behind it. This walks
  // the bytes in fixed triplets instead, with no such limit.
  const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      const chunk = (b0 << 16) | ((b1 || 0) << 8) | (b2 || 0);
      out += B64_CHARS[(chunk >> 18) & 63] + B64_CHARS[(chunk >> 12) & 63]
        + (i + 1 < bytes.length ? B64_CHARS[(chunk >> 6) & 63] : '=')
        + (i + 2 < bytes.length ? B64_CHARS[chunk & 63] : '=');
    }
    return out;
  }
  function base64ToBytes(b64) {
    const out = [];
    let buffer = 0, bits = 0;
    for (const ch of String(b64 ?? '')) {
      const val = B64_CHARS.indexOf(ch);
      if (val === -1) continue; // skips '=' padding and any stray whitespace
      buffer = (buffer << 6) | val;
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 0xff); }
    }
    return new Uint8Array(out);
  }

  // Shared by encrypt and decrypt so the two sides can never drift on how the
  // key is derived — same passphrase + same salt + same iteration count must
  // always produce the same key, or a correct passphrase would fail to open
  // its own backup.
  async function deriveAesKey(passphrase, saltBytes, iterations) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: PBKDF2_HASH, salt: saltBytes, iterations },
      keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // Encrypts an arbitrary JS value (here, always the plaintext backup object)
  // under a passphrase. Returns just the crypto fields — the caller stitches
  // them onto the visible `format`/`version`/`encrypted` envelope, since this
  // function has no opinion on that shape.
  async function encryptBackupData(payload, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return {
      kdf: { name: 'PBKDF2', hash: PBKDF2_HASH, iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt) },
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
  }

  // The inverse. Every failure mode — wrong passphrase, corrupted/truncated
  // ciphertext, a tampered salt or IV — surfaces from AES-GCM as the same
  // generic `OperationError` (its authentication tag simply doesn't verify;
  // WebCrypto deliberately doesn't distinguish "wrong key" from "damaged
  // data", to avoid handing an attacker a decryption oracle). All of those
  // collapse to one friendly message here rather than leaking that raw error
  // to someone who just mistyped a passphrase.
  async function decryptBackupData(envelope, passphrase) {
    try {
      const salt = base64ToBytes(envelope.kdf.salt);
      const iv = base64ToBytes(envelope.iv);
      const ciphertext = base64ToBytes(envelope.ciphertext);
      const iterations = Number(envelope.kdf.iterations) || PBKDF2_ITERATIONS;
      const key = await deriveAesKey(passphrase, salt, iterations);
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return JSON.parse(new TextDecoder().decode(plainBuf));
    } catch (e) {
      throw new Error('That passphrase didn’t decrypt this backup.');
    }
  }

  // Builds the encrypted envelope for export. `format`/`version` are
  // duplicated here (rather than only living inside the ciphertext) so a
  // file can be identified as SplitCraft's and its `encrypted` flag read
  // without decrypting anything first — validateBackup() needs both before
  // it even knows to ask for a passphrase.
  async function buildEncryptedBackup(passphrase) {
    const backup = await buildBackup();
    const { kdf, iv, ciphertext } = await encryptBackupData(backup, passphrase);
    return { format: BACKUP_FORMAT, version: BACKUP_FORMAT_VERSION, encrypted: true, kdf, iv, ciphertext };
  }

  // Workouts only. The exercise catalog, prefs, plans and settings all
  // survive — that's what makes this safe to offer as a standalone control
  // rather than folding it into restore/factory-reset territory: it can only
  // ever cost you logged sets, never the setup around them.
  async function clearWorkoutHistory() {
    await clearStore('workouts');
    invalidateWorkoutsCache();
  }

  // Downloads a full backup before a destructive action, so a wipe you meant
  // and a wipe you mis-tapped aren't indistinguishable afterwards. The safety
  // net is the feature that already exists — buildBackup() — which is the
  // argument for having built export first.
  async function safetyBackup(label) {
    const backup = await buildBackup();
    downloadFile(`splitcraft-before-${label}-${todayStr()}.json`,
      JSON.stringify(backup, null, 2), 'application/json');
    // A real, complete backup just landed on the device same as the Export
    // button's — the staleness reminder has no business treating this one
    // as if it didn't count just because it was incidental to a delete.
    await recordBackupCompleted();
    return backup.counts;
  }

  function downloadFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a delay rather than immediately: some browsers haven't
    // finished reading the blob when click() returns, and a revoked URL then
    // downloads an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // The ONLY place lastBackupAt is written from a fresh export — called
  // after a download or a share has genuinely completed, never before. A
  // cancelled share sheet or a thrown error (a bad passphrase, encryption
  // failing) must never reach this: a backup you didn't actually get off
  // the device isn't a backup, and recording one anyway would make the
  // staleness reminder below lie.
  async function recordBackupCompleted() {
    await setSetting('lastBackupAt', Date.now());
    await renderBackupFreshness();
  }

  // Shared by the Download and Share buttons: reads and validates the two
  // passphrase fields, writing the reason to `status` and returning null on
  // failure. Checked before either button does anything expensive, so a typo
  // costs nothing instead of a wasted 600,000-round PBKDF2 run.
  function readExportPassphrase(status) {
    const p1 = document.getElementById('backup-export-passphrase').value;
    const p2 = document.getElementById('backup-export-passphrase-confirm').value;
    if (!p1) { status.textContent = 'Enter a passphrase to encrypt this backup.'; return null; }
    if (p1 !== p2) { status.textContent = 'Those two passphrases don’t match — re-enter them.'; return null; }
    return p1;
  }
  function clearExportPassphraseFields() {
    document.getElementById('backup-export-passphrase').value = '';
    document.getElementById('backup-export-passphrase-confirm').value = '';
  }

  // Builds the file to hand off, encrypted or not, without deciding HOW it
  // leaves the device. That split is what lets Download and Share reuse one
  // encryption path instead of the passphrase/PBKDF2 logic drifting into two
  // slightly different copies of it.
  async function buildExportPayload(encrypt, passphrase) {
    const stamp = todayStr();
    if (encrypt) {
      const envelope = await buildEncryptedBackup(passphrase);
      return {
        filename: `splitcraft-backup-${stamp}.enc.json`,
        text: JSON.stringify(envelope, null, 2),
        mime: 'application/json',
        statusText: `Exported an ENCRYPTED backup as splitcraft-backup-${stamp}.enc.json. `
          + `There is no way to recover this file without its passphrase — if it's lost, the backup is gone.`
      };
    }
    const backup = await buildBackup();
    return {
      filename: `splitcraft-backup-${stamp}.json`,
      text: JSON.stringify(backup, null, 2),
      mime: 'application/json',
      statusText: `Exported ${backup.counts.sets} sets across ${backup.counts.workouts} day(s), `
        + `${backup.counts.exercises} exercises and ${backup.counts.plans} plan(s), as splitcraft-backup-${stamp}.json.`
    };
  }

  // Marks a successful delivery: paints the status line, clears the
  // passphrase fields (nothing to gain from leaving a typed passphrase
  // sitting in the DOM once its file is gone), and records the timestamp
  // that feeds the staleness reminder.
  async function finishExport(statusText, encrypt) {
    document.getElementById('backup-export-status').textContent = statusText;
    if (encrypt) clearExportPassphraseFields();
    await recordBackupCompleted();
  }

  // Shows/hides the passphrase fields under the "Encrypt this backup"
  // checkbox, and disables the checkbox outright on a browser with no
  // WebCrypto (e.g. a non-secure origin, where `crypto.subtle` doesn't
  // exist) — caught here, up front, rather than as a confusing raw error
  // after someone has already typed a passphrase twice. Plain export is
  // completely unaffected either way.
  const encryptCheckbox = document.getElementById('backup-encrypt');
  if (encryptCheckbox) {
    if (!(typeof crypto !== 'undefined' && crypto.subtle)) {
      encryptCheckbox.disabled = true;
      encryptCheckbox.title = 'Encryption isn’t available in this browser (WebCrypto is unsupported or requires HTTPS).';
    }
    encryptCheckbox.addEventListener('change', () => {
      const fields = document.getElementById('backup-encrypt-fields');
      if (fields) fields.style.display = encryptCheckbox.checked ? 'block' : 'none';
    });
  }

  document.getElementById('backup-export-btn').addEventListener('click', async () => {
    const btn = document.getElementById('backup-export-btn');
    const status = document.getElementById('backup-export-status');
    status.textContent = '';
    const encrypt = !!(encryptCheckbox && encryptCheckbox.checked);
    let passphrase = null;
    if (encrypt) {
      passphrase = readExportPassphrase(status);
      if (passphrase === null) return;
    }
    btn.disabled = true;
    const originalLabel = btn.textContent;
    if (encrypt) btn.textContent = 'Encrypting…';   // 600k PBKDF2 rounds is not instant on a phone
    try {
      const { filename, text, mime, statusText } = await buildExportPayload(encrypt, passphrase);
      downloadFile(filename, text, mime);
      await finishExport(statusText, encrypt);
      toast('Backup downloaded');
    } catch (err) {
      status.textContent = `Export failed: ${err.message}`;
      reportUnexpected('Backup export', err);
    } finally {
      btn.disabled = false; btn.textContent = originalLabel;
    }
  });

  // Feature-detect Web Share API FILE support once, at load, with a
  // throwaway probe file rather than a real backup — the real one may need
  // 600,000 rounds of PBKDF2 to even exist, which is a poor price to pay just
  // to decide whether a button should be visible. canShare() has to be asked
  // WITH a file, not just checked for existence: a browser can implement
  // navigator.share() for plain text/links while refusing files outright,
  // and that gap is exactly what a boolean "share() exists" would miss.
  const canShareFiles = !!(typeof navigator !== 'undefined' && navigator.share && navigator.canShare
    && (() => {
      try { return navigator.canShare({ files: [new File(['x'], 'probe.json', { type: 'application/json' })] }); }
      catch (e) { return false; } // some browsers throw on an unsupported shape rather than returning false
    })());

  // "Share Backup" sits ALONGSIDE Download rather than replacing it, and is
  // simply absent (not disabled — absent) on anything that fails the probe
  // above. Two reasons: someone on a phone may still want the file to just
  // land in Downloads (to move it by cable, keep a local copy, whatever),
  // and canShare() at load time is a probe, not a guarantee — the real file
  // gets re-checked at share time below, with an unconditional fallback to
  // the plain download for when a browser's real answer differs from its
  // probe answer.
  const shareBtn = document.getElementById('backup-share-btn');
  if (shareBtn) {
    shareBtn.style.display = canShareFiles ? '' : 'none';
    shareBtn.addEventListener('click', async () => {
      const status = document.getElementById('backup-export-status');
      status.textContent = '';
      const encrypt = !!(encryptCheckbox && encryptCheckbox.checked);
      let passphrase = null;
      if (encrypt) {
        passphrase = readExportPassphrase(status);
        if (passphrase === null) return;
      }
      shareBtn.disabled = true;
      const originalLabel = shareBtn.textContent;
      if (encrypt) shareBtn.textContent = 'Encrypting…';
      try {
        const { filename, text, mime, statusText } = await buildExportPayload(encrypt, passphrase);
        const file = new File([text], filename, { type: mime });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: 'SplitCraft backup' });
            await finishExport(statusText, encrypt);
            toast('Backup shared');
          } catch (shareErr) {
            // Dismissing the share sheet is a normal outcome, not a failure —
            // and definitely not a backup: nothing left the device, so
            // lastBackupAt must not move and no error should be shown.
            if (shareErr && shareErr.name === 'AbortError') return;
            // Any other failure (no app registered for this file type, an
            // OS-level hiccup) still leaves a perfectly good file sitting in
            // memory — hand it over the boring way rather than stranding the
            // user with nothing after they asked to share it.
            downloadFile(filename, text, mime);
            await finishExport(statusText, encrypt);
            toast('Share failed — downloaded instead');
          }
        } else {
          // The real file failed the check the load-time probe passed (an
          // unusual size or extension some share targets reject) — fall back
          // exactly as if the browser had never advertised support.
          downloadFile(filename, text, mime);
          await finishExport(statusText, encrypt);
          toast('Backup downloaded');
        }
      } catch (err) {
        status.textContent = `Export failed: ${err.message}`;
        reportUnexpected('Backup export', err);
      } finally {
        shareBtn.disabled = false; shareBtn.textContent = originalLabel;
      }
    });
  }

  // =========================================================================
  // Cloud backup: Dropbox — optional, and additive to Download/Share above.
  //
  // "Backup delivery: share sheet over OAuth" in design-summary.md rejected
  // Drive OAuth and a GitHub-token backup outright: this app has no account
  // and no backend, so any credential it holds is one it has to request,
  // store, refresh, and eventually explain how to revoke. Dropbox is added
  // here anyway, as a THIRD option nobody is forced into, because its OAuth
  // shape is materially narrower than what was rejected:
  //
  //   - PKCE (RFC 7636) lets this public, secret-less static page run the
  //     whole flow itself — no server, anywhere, ever holds a client_secret.
  //   - `token_access_type=offline` still gets a PKCE client a refresh
  //     token, so what this app stores long-term is something it can rotate
  //     short-lived access tokens from, not one static all-purpose token.
  //   - The Dropbox app behind DROPBOX_CLIENT_ID is registered with "App
  //     folder" access, not "Full Dropbox": a leaked token can only ever
  //     reach the one folder this app made, never anything else already
  //     sitting in the user's Dropbox.
  //   - The refresh token never leaves this device via export — see
  //     BACKUP_EXCLUDED_SETTINGS above.
  //
  // DROPBOX_CLIENT_ID is a PKCE "App key," not a secret — Dropbox's own PKCE
  // guide has it shipped in public client-side code by design, same as a
  // Google OAuth client ID. It still needs registering before this works:
  // create a Scoped Access app in Dropbox's App Console, "App folder"
  // access, enable the files.content.write permission, add every URL this
  // app is actually served from (including the localhost dev URL from
  // tools/serve.mjs) as an OAuth 2 redirect URI, then paste the App key in.
  // =========================================================================
  const DROPBOX_CLIENT_ID = 'REPLACE_WITH_YOUR_DROPBOX_APP_KEY';
  const DROPBOX_SCOPE = 'files.content.write';
  const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
  const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const DROPBOX_UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
  const DROPBOX_REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';
  // sessionStorage, not a plain variable: the code_verifier has to survive a
  // full page navigation to dropbox.com and back, which discards anything
  // held only in memory.
  const DROPBOX_VERIFIER_KEY = 'splitcraft.dropbox.pkce_verifier';

  // In-memory only, never written to settings — re-derived from the refresh
  // token whenever needed, so disconnect has nothing to clean up here beyond
  // forgetting this one object.
  let dropboxAccessToken = null; // { token, expiresAt }

  function base64UrlFromBytes(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // 96 random bytes -> a 128-character base64url string: inside PKCE's
  // required 43-128 character range and using only the characters it allows.
  function generateDropboxVerifier() {
    return base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(96)));
  }

  async function sha256Base64Url(input) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return base64UrlFromBytes(new Uint8Array(digest));
  }

  // Whatever URL this page is actually running at, with no query or hash.
  // Dropbox compares this byte-for-byte against a registered redirect URI,
  // so it has to exactly match what the address bar shows BEFORE the
  // ?code=... the OAuth round trip appends to it.
  function dropboxRedirectUri() {
    return location.origin + location.pathname;
  }

  async function startDropboxConnect() {
    const verifier = generateDropboxVerifier();
    sessionStorage.setItem(DROPBOX_VERIFIER_KEY, verifier);
    const challenge = await sha256Base64Url(verifier);
    const params = new URLSearchParams({
      client_id: DROPBOX_CLIENT_ID,
      redirect_uri: dropboxRedirectUri(),
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      scope: DROPBOX_SCOPE,
    });
    location.href = `${DROPBOX_AUTHORIZE_URL}?${params.toString()}`;
  }

  // Exchanges a fresh authorization code for a refresh token, using the
  // verifier stashed before leaving for dropbox.com. No client_secret
  // anywhere in this call — that's the whole point of PKCE for a client that
  // has no way to keep one.
  async function exchangeDropboxCode(code, verifier) {
    const body = new URLSearchParams({
      code, grant_type: 'authorization_code', client_id: DROPBOX_CLIENT_ID,
      redirect_uri: dropboxRedirectUri(), code_verifier: verifier,
    });
    const res = await fetch(DROPBOX_TOKEN_URL, { method: 'POST', body });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.refresh_token) {
      throw new Error((json && (json.error_description || json.error)) || 'Dropbox didn’t return a token.');
    }
    return json;
  }

  // Handles a returning OAuth redirect. A load-time event, not a click —
  // called from init() (12-init.js), not wired to any button.
  async function handleDropboxRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const oauthError = params.get('error');
    if (!code && !oauthError) return;
    // Strip ?code=/?error= from the visible URL either way, so reloading the
    // page doesn't try to redeem the same code twice (Dropbox authorization
    // codes are single-use).
    history.replaceState(null, '', dropboxRedirectUri());
    const status = document.getElementById('dropbox-status');
    if (oauthError) {
      if (status) status.textContent = `Dropbox connection failed: ${params.get('error_description') || oauthError}`;
      return;
    }
    const verifier = sessionStorage.getItem(DROPBOX_VERIFIER_KEY);
    sessionStorage.removeItem(DROPBOX_VERIFIER_KEY);
    if (!verifier) {
      if (status) status.textContent = 'Dropbox connection failed: lost the PKCE verifier (was this tab reloaded mid-flow?).';
      return;
    }
    try {
      const json = await exchangeDropboxCode(code, verifier);
      await setSetting('dropboxRefreshToken', json.refresh_token);
      dropboxAccessToken = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 0) * 1000 };
      await renderDropboxStatus();
      toast('Dropbox connected');
    } catch (err) {
      if (status) status.textContent = `Dropbox connection failed: ${err.message}`;
      reportUnexpected('Dropbox OAuth exchange', err);
    }
  }

  // Returns a live access token, refreshing first if one is missing or
  // within 60 seconds of expiring. The margin exists so a token that's
  // technically still valid when this is called doesn't expire moments
  // later mid-upload — refreshing a little early costs nothing (refresh
  // tokens aren't consumed by use) and a failed upload from an
  // already-expired token would cost a retry.
  async function getDropboxAccessToken() {
    if (dropboxAccessToken && dropboxAccessToken.expiresAt - 60000 > Date.now()) {
      return dropboxAccessToken.token;
    }
    const refreshToken = await getSetting('dropboxRefreshToken', null);
    if (!refreshToken) throw new Error('Dropbox isn’t connected.');
    const body = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: DROPBOX_CLIENT_ID,
    });
    const res = await fetch(DROPBOX_TOKEN_URL, { method: 'POST', body });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.access_token) {
      // A refresh token can genuinely stop working — revoked from Dropbox's
      // own security settings, or this app's permissions changed. Forgetting
      // it here, rather than retrying forever, is what lets Settings notice
      // and offer to reconnect instead of failing the same way on every
      // future backup.
      await setSetting('dropboxRefreshToken', null);
      dropboxAccessToken = null;
      throw new Error('Dropbox needs to be reconnected.');
    }
    dropboxAccessToken = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 0) * 1000 };
    return json.access_token;
  }

  // Uploads via query-string auth (`authorization`/`arg` as URL params, plus
  // `reject_cors_preflight=true`) instead of the usual Authorization /
  // Dropbox-API-Arg HEADERS, and sends `text` as a bare string body so fetch
  // defaults its Content-Type to `text/plain;charset=UTF-8`. Both choices
  // keep this a CORS "simple request" — no custom headers, a safelisted
  // content type — so the browser sends it with no OPTIONS preflight, which
  // Dropbox's upload endpoint does not otherwise support for a browser
  // caller with no server of its own to route through.
  async function uploadToDropbox(filename, text) {
    const token = await getDropboxAccessToken();
    const arg = JSON.stringify({ path: `/${filename}`, mode: 'overwrite', mute: true });
    const params = new URLSearchParams({
      authorization: `Bearer ${token}`, arg, reject_cors_preflight: 'true',
    });
    const res = await fetch(`${DROPBOX_UPLOAD_URL}?${params.toString()}`, { method: 'POST', body: text });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Dropbox upload failed (${res.status}): ${errText.slice(0, 200) || res.statusText}`);
    }
  }

  async function disconnectDropbox() {
    const refreshToken = await getSetting('dropboxRefreshToken', null);
    await setSetting('dropboxRefreshToken', null);
    dropboxAccessToken = null;
    await renderDropboxStatus();
    // Best-effort: tells Dropbox to invalidate the token server-side, so a
    // copy that somehow leaked stops working too, not just this device's
    // reference to it. Disconnecting has already done what the user asked
    // either way, so a failed revoke call is swallowed rather than surfaced
    // as an error about a click that otherwise worked.
    if (refreshToken) {
      const body = new URLSearchParams({ token: refreshToken });
      fetch(DROPBOX_REVOKE_URL, { method: 'POST', body }).catch(() => {});
    }
  }

  async function renderDropboxStatus() {
    const btn = document.getElementById('backup-dropbox-btn');
    const disconnectBtn = document.getElementById('dropbox-disconnect-btn');
    const status = document.getElementById('dropbox-status');
    const connected = !!(await getSetting('dropboxRefreshToken', null));
    if (btn) btn.textContent = connected ? 'Back Up to Dropbox' : 'Connect Dropbox…';
    if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none';
    if (status && !status.textContent) {
      status.textContent = connected
        ? 'Connected — backups go to the SplitCraft app folder in your Dropbox.'
        : '';
    }
  }

  const dropboxBtn = document.getElementById('backup-dropbox-btn');
  if (dropboxBtn) {
    dropboxBtn.addEventListener('click', async () => {
      const connected = !!(await getSetting('dropboxRefreshToken', null));
      if (!connected) { await startDropboxConnect(); return; }
      const status = document.getElementById('backup-export-status');
      status.textContent = '';
      const encrypt = !!(encryptCheckbox && encryptCheckbox.checked);
      let passphrase = null;
      if (encrypt) {
        passphrase = readExportPassphrase(status);
        if (passphrase === null) return;
      }
      dropboxBtn.disabled = true;
      const originalLabel = dropboxBtn.textContent;
      if (encrypt) dropboxBtn.textContent = 'Encrypting…';
      try {
        const { filename, text, statusText } = await buildExportPayload(encrypt, passphrase);
        dropboxBtn.textContent = 'Uploading…';
        await uploadToDropbox(filename, text);
        await finishExport(`${statusText} Uploaded to Dropbox.`, encrypt);
        toast('Backed up to Dropbox');
      } catch (err) {
        status.textContent = `Dropbox backup failed: ${err.message}`;
        reportUnexpected('Dropbox backup', err);
      } finally {
        dropboxBtn.disabled = false; dropboxBtn.textContent = originalLabel;
        await renderDropboxStatus();
      }
    });
  }

  const dropboxDisconnectBtn = document.getElementById('dropbox-disconnect-btn');
  if (dropboxDisconnectBtn) {
    dropboxDisconnectBtn.addEventListener('click', async () => {
      await disconnectDropbox();
      toast('Dropbox disconnected');
    });
  }

  // Validated hard before anything is offered, because the confirm button that
  // follows destroys the device's data. A file that isn't one of ours must be
  // rejected here, not halfway through a restore.
  //
  // Async since an encrypted envelope (`encrypted: true`) has to be decrypted
  // before there's anything to validate — `passphrase` is only meaningful for
  // that branch and is ignored otherwise. Decrypting recurses into this same
  // function with the decrypted payload (which is itself a complete plaintext
  // backup object, see buildEncryptedBackup()'s comment), so every check
  // below runs unchanged on the decrypted data — an encrypted backup gets
  // exactly the same validation guarantees as a plaintext one, not a
  // parallel, easier-to-drift copy of them.
  async function validateBackup(parsed, passphrase) {
    if (!parsed || typeof parsed !== 'object') throw new Error('That file isn’t valid JSON.');
    if (parsed.format !== BACKUP_FORMAT) throw new Error('That doesn’t look like a SplitCraft backup (missing the format marker).');
    if (parsed.encrypted) {
      if (!(typeof crypto !== 'undefined' && crypto.subtle)) {
        throw new Error('This browser can’t decrypt backups (WebCrypto is unavailable).');
      }
      if (!passphrase) throw new Error('This backup is encrypted — enter its passphrase to continue.');
      const decrypted = await decryptBackupData(parsed, passphrase);
      return validateBackup(decrypted);
    }
    const backupVersion = Number(parsed.version);
    // NaN > N is always false, so a missing/garbled version field used to
    // sail straight past this guard instead of being rejected — the format
    // marker matched, so the destructive restore path below would proceed on
    // a file with no verifiable version at all. Reject that explicitly.
    if (!Number.isFinite(backupVersion)) {
      throw new Error('This backup has no valid version number (missing or non-numeric) and can’t be verified as safe to restore.');
    }
    if (backupVersion > BACKUP_FORMAT_VERSION) {
      throw new Error(`This backup was written by a newer version of SplitCraft (format ${parsed.version}, this app reads ${BACKUP_FORMAT_VERSION}). Update the app first.`);
    }
    const d = parsed.data;
    if (!d || typeof d !== 'object') throw new Error('Backup file has no data section.');
    for (const key of ['workouts', 'exercises', 'plans']) {
      if (!Array.isArray(d[key])) throw new Error(`Backup file is missing its "${key}" list.`);
    }
    if (d.exercisePrefs && !Array.isArray(d.exercisePrefs)) throw new Error('Backup file has a malformed "exercisePrefs" list.');
    if (d.settings && typeof d.settings !== 'object') throw new Error('Backup file has a malformed "settings" section.');

    // DEEP CHECK, and it earns its keep because of the ORDER restore runs in:
    // it clears every store and then writes. A file that passes a shallow
    // check and then turns out to contain a malformed set leaves you with your
    // own data already gone AND a render that throws on `entries[0].weight` —
    // the worst outcome this app can produce. Anything that will be walked by
    // a render path gets checked here, before the button that wipes is even
    // offered.
    const fail = (msg) => { throw new Error(`Backup file is damaged — ${msg}. Nothing has been changed.`); };
    d.workouts.forEach((w, i) => {
      const where = `workout ${i + 1}${w && w.date ? ` (${w.date})` : ''}`;
      if (!w || typeof w !== 'object') fail(`${where} is not a record`);
      if (typeof w.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w.date)) fail(`${where} has no valid date`);
      if (!Array.isArray(w.exercises)) fail(`${where} has no exercise list`);
      w.exercises.forEach((ex) => {
        if (!ex || typeof ex !== 'object') fail(`${where} contains an invalid exercise entry`);
        if (!Number.isFinite(Number(ex.exerciseId))) fail(`${where} has an exercise with no id`);
        if (!Array.isArray(ex.sets)) fail(`${where} has an exercise with no set list`);
        ex.sets.forEach((s) => {
          if (!s || !Array.isArray(s.entries) || s.entries.length === 0) {
            fail(`${where} has a set with no weight/reps entries`);
          }
          s.entries.forEach((en) => {
            if (!en || !Number.isFinite(Number(en.weight)) || !Number.isFinite(Number(en.reps))) {
              fail(`${where} has a set with a non-numeric weight or rep count`);
            }
          });
        });
      });
    });
    d.exercises.forEach((ex, i) => {
      if (!ex || typeof ex !== 'object') fail(`exercise ${i + 1} is not a record`);
      if (!Number.isFinite(Number(ex.id))) fail(`exercise ${i + 1} has no id`);
      if (typeof ex.name !== 'string' || !ex.name.trim()) fail(`exercise ${i + 1} has no name`);
    });
    d.plans.forEach((p, i) => {
      if (!p || !Array.isArray(p.days)) fail(`plan ${i + 1} has no days list`);
      p.days.forEach((day) => {
        if (!day || !Array.isArray(day.exercises)) fail(`plan ${i + 1} has a day with no exercise list`);
      });
    });
    return parsed;
  }

  // The restore itself, separated from the click that triggers it.
  //
  // Split out so it is directly testable: the interesting failure (ids being
  // reassigned, and every plan and workout reference dangling as a result)
  // lives in these fifteen lines, not in the button, and a test that reached
  // it only by reimplementing the same sequence would keep passing while the
  // real path rotted.
  //
  // Records are written back with their ORIGINAL ids. That is the whole reason
  // restore is replace-only: plans reference exercises by id and so do
  // workouts, so preserving ids keeps every cross-reference intact for free.
  // Merging two devices would mean remapping every id in both directions — a
  // different and much more dangerous feature.
  async function applyRestore(d) {
    await clearStore('workouts');
    await clearStore('exercises');
    await clearStore('exercisePrefs');
    await clearStore('plans');
    // restorePut, not putRecord — see restorePut() for why that difference is
    // load-bearing. Exercises first, so the rows that plans and workouts point
    // at exist before the things pointing at them.
    for (const rec of d.exercises) await restorePut('exercises', rec);
    for (const rec of d.workouts) await restorePut('workouts', rec);
    for (const rec of d.plans) await restorePut('plans', rec);
    for (const rec of (d.exercisePrefs || [])) {
      if (rec && rec.exerciseId != null) await setExercisePref(rec.exerciseId, rec);
    }
    for (const [key, value] of Object.entries(d.settings || {})) {
      if (!BACKUP_EXCLUDED_SETTINGS.includes(key)) await setSetting(key, value);
    }
    invalidateWorkoutsCache();
    invalidateSwapOptions();
  }

  let pendingRestore = null;
  // Holds the raw, still-encrypted envelope between "a file was picked" and
  // "a passphrase was submitted" — there is nothing to validate or preview
  // before that, since the only person who can produce the plaintext is
  // whoever knows the passphrase.
  let pendingEncryptedRaw = null;

  // Both the plaintext path (immediately below) and the encrypted path (the
  // decrypt button's handler, further down) end up here once they have an
  // actual, validated plaintext backup object — one place building "what
  // this restore will replace" instead of two copies drifting apart.
  async function showRestorePreview(parsed) {
    pendingRestore = parsed;
    // Both sides of the trade shown together. "Replace all data" means
    // nothing without knowing what is currently there to lose.
    const current = await buildBackup();
    const inc = parsed.counts || {};
    // File content is untrusted and inc.sets gets interpolated into innerHTML below;
    // coerce to a number so a crafted string can't inject markup.
    const rawIncSets = Number(inc.sets);
    const incSets = Number.isFinite(rawIncSets) ? rawIncSets : parsed.data.workouts.reduce(
      (a, w) => a + (w.exercises || []).reduce((b, ex) => b + (ex.sets || []).length, 0), 0);
    const when = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString() : 'an unknown date';
    document.getElementById('backup-preview-text').innerHTML =
      `Backup taken <strong>${esc(when)}</strong>.<br>`
      + `Restoring replaces <strong>${current.counts.workouts} day(s) / ${current.counts.sets} sets</strong> `
      + `currently on this device with <strong>${parsed.data.workouts.length} day(s) / ${incSets} sets</strong> from the file`
      + `, and swaps ${current.counts.exercises} exercises and ${current.counts.plans} plan(s) for `
      + `${parsed.data.exercises.length} and ${parsed.data.plans.length}. `
      + `Your API key is left as it is. <strong>This cannot be undone</strong> — export the current data first if you might want it back.`;
    document.getElementById('backup-preview').style.display = 'block';
  }

  document.getElementById('backup-file').addEventListener('change', async (e) => {
    const errBox = document.getElementById('backup-error');
    const okBox = document.getElementById('backup-success');
    const preview = document.getElementById('backup-preview');
    const decryptPrompt = document.getElementById('backup-decrypt-prompt');
    errBox.style.display = 'none';
    okBox.style.display = 'none';
    preview.style.display = 'none';
    decryptPrompt.style.display = 'none';
    pendingRestore = null;
    pendingEncryptedRaw = null;
    const file = e.target.files[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      // An encrypted envelope has no `data` section to preview and nothing
      // validateBackup() can check yet — only a passphrase unlocks either.
      // Hold the raw envelope and ask for one instead of failing here.
      if (raw && raw.format === BACKUP_FORMAT && raw.encrypted) {
        pendingEncryptedRaw = raw;
        document.getElementById('backup-restore-passphrase').value = '';
        decryptPrompt.style.display = 'block';
        return;
      }
      await showRestorePreview(await validateBackup(raw));
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  });

  document.getElementById('backup-decrypt-btn').addEventListener('click', async () => {
    if (!pendingEncryptedRaw) return;
    const btn = document.getElementById('backup-decrypt-btn');
    const errBox = document.getElementById('backup-error');
    const passphrase = document.getElementById('backup-restore-passphrase').value;
    errBox.style.display = 'none';
    btn.disabled = true;
    const restoreLabel = btn.textContent;
    btn.textContent = 'Decrypting…';   // 600k PBKDF2 rounds — a real pause on a phone
    try {
      const parsed = await validateBackup(pendingEncryptedRaw, passphrase);
      document.getElementById('backup-decrypt-prompt').style.display = 'none';
      await showRestorePreview(parsed);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = restoreLabel;
    }
  });

  document.getElementById('backup-restore-btn').addEventListener('click', async () => {
    if (!pendingRestore) return;
    const btn = document.getElementById('backup-restore-btn');
    const errBox = document.getElementById('backup-error');
    const okBox = document.getElementById('backup-success');
    errBox.style.display = 'none';
    if (typeof confirm === 'function' && !confirm('Replace ALL data on this device with the contents of this backup? This cannot be undone.')) return;
    btn.disabled = true; btn.textContent = 'Restoring…';
    try {
      const d = pendingRestore.data;
      // Read before applyRestore()/the null-out below — this is the restored
      // FILE's own timestamp, not a setting living inside `d`, so it has to
      // come off the outer parsed object while it's still around.
      const restoredExportedAt = pendingRestore.exportedAt;
      await applyRestore(d);

      okBox.textContent = `Restored ${d.workouts.length} day(s), ${d.exercises.length} exercises and ${d.plans.length} plan(s). Your API key was left unchanged.`;
      okBox.style.display = 'block';
      pendingRestore = null;
      // lastBackupAt is excluded from the ordinary settings restore above
      // (see BACKUP_EXCLUDED_SETTINGS) and set here instead, to the FILE's
      // own exportedAt rather than to "now": restoring proves a backup
      // exists as of that date, because the file just proved it, but using
      // the current moment would overstate freshness — restoring a
      // nine-month-old file doesn't mean nine months of risk just vanished.
      // Missing/garbled on an old or hand-edited file: leave whatever this
      // device already had rather than guess.
      const restoredAt = Date.parse(restoredExportedAt);
      if (Number.isFinite(restoredAt)) await setSetting('lastBackupAt', restoredAt);
      await renderBackupFreshness();
      document.getElementById('backup-preview').style.display = 'none';
      document.getElementById('backup-file').value = '';
      // Same split as the CSV importer: the data is committed by this point,
      // so a repaint failure must not be reported as a failed restore.
      try {
        await loadSettingsIntoForm();
        await populateExerciseSelect();
        await renderExerciseManager();
        await refreshLogAndHistory();
        await refreshPlanTab();
      } catch (renderErr) {
        errBox.textContent = `Restore succeeded, but refreshing the screen failed: ${renderErr.message}. Your data is saved — reload the page.`;
        errBox.style.display = 'block';
      }
      toast('Backup restored');
    } catch (err) {
      errBox.textContent = `Restore failed: ${err.message}. Some data may have been written — reload and check before retrying.`;
      errBox.style.display = 'block';
      reportUnexpected('Backup restore', err);
    } finally {
      btn.disabled = false; btn.textContent = 'Replace All Data';
    }
  });

  // Delete all workout history. Its own control rather than a step of
  // restore/factory-reset: it is the one destructive action a user might
  // actually want in the ordinary course of using the app (starting a
  // fresh training log without losing the exercise catalog, plans and
  // preferences built up around it), so it gets its own button and its own
  // confirm rather than living behind a file picker.
  document.getElementById('history-clear-btn').addEventListener('click', async () => {
    const btn = document.getElementById('history-clear-btn');
    btn.disabled = true;
    try {
      const counts = (await buildBackup()).counts;
      if (counts.workouts === 0) { toast('No workout history to delete'); return; }
      if (typeof confirm === 'function'
        && !confirm(`Delete ALL ${counts.workouts} logged day(s) / ${counts.sets} sets?\n\nExercises, plans and settings are kept. This cannot be undone.`)) return;
      if (document.getElementById('history-clear-backup-first').checked) await safetyBackup('clear-history');
      await clearWorkoutHistory();
      await refreshLogAndHistory();
      await refreshPlanTab();
      toast(`Deleted ${counts.workouts} day(s) of history`);
    } catch (err) {
      reportUnexpected('Delete workout history', err);
    } finally {
      btn.disabled = false;
    }
  });
