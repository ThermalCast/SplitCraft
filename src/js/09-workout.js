  // 09-workout.js — Workout tab — active workout render
  // The exercise picker's grouped list — identical for every picker on
  // screen (Swap, Plan-tab Swap, Add Exercise), so it is built at most ONCE
  // and shared. Rebuilding it is a full store read plus a sort, and a
  // session may open the picker several times without a single exercise
  // being added, edited or disliked in between.
  let exercisePickerCache = null;
  function invalidateExercisePicker() { exercisePickerCache = null; }
  function groupedExercisesForPicker() {
    if (!exercisePickerCache) exercisePickerCache = buildGroupedExercises();
    return exercisePickerCache;
  }
  // Grouped by muscle in MUSCLES' own declared order (chest, delts,
  // triceps, ... legs, core, unclassified) rather than alphabetically —
  // related muscles land near each other, which matters when browsing
  // rather than already knowing the exact name. Only muscles with at least
  // one available (non-disliked) exercise are included.
  async function buildGroupedExercises() {
    const exercises = await getAllRecords('exercises');
    const prefs = await getAllRecords('exercisePrefs');
    const dislikedIds = new Set(prefs.filter(p => p.disliked).map(p => p.exerciseId));
    const byMuscle = {};
    exercises.filter(e => !dislikedIds.has(e.id)).forEach(ex => {
      const mid = MUSCLES.some(m => m.id === ex.primaryMuscle) ? ex.primaryMuscle : 'unclassified';
      if (!byMuscle[mid]) byMuscle[mid] = [];
      byMuscle[mid].push(ex);
    });
    return MUSCLES.map(m => ({
      id: m.id, name: m.name,
      exercises: (byMuscle[m.id] || []).slice().sort((a, b) => a.name.localeCompare(b.name))
    })).filter(g => g.exercises.length > 0);
  }

  // =========================================================================
  // Exercise picker — a full-screen search-or-browse modal shared by every
  // "pick an exercise" moment in the app: the Workout tab's session-only
  // Swap, the Plan tab's permanent Swap, and Add Exercise. Generic on
  // purpose — the modal itself doesn't know or care what picking an
  // exercise MEANS to its caller, it just resolves `onSelect` with an
  // exerciseId and gets out of the way.
  // =========================================================================
  let exercisePickerOnSelect = null;
  let exercisePickerExcludeIds = new Set();
  // Which muscle groups are expanded, reset every time the picker opens —
  // unlike expandedExercises/openHistoryPanels elsewhere in this file, this
  // state has no reason to survive past a single picker visit.
  const expandedPickerGroups = new Set();

  async function openExercisePicker({ excludeIds, onSelect, title }) {
    exercisePickerOnSelect = onSelect;
    exercisePickerExcludeIds = excludeIds || new Set();
    expandedPickerGroups.clear();
    document.getElementById('exercise-picker-title').textContent = title || 'Choose an exercise';
    const search = document.getElementById('exercise-picker-search');
    search.value = '';
    document.getElementById('exercise-picker-custom').hidden = true;
    document.getElementById('picker-new-ex-name').value = '';
    await renderExercisePickerBody('');
    document.getElementById('exercise-picker-modal').hidden = false;
    search.focus();
  }
  function closeExercisePicker() {
    document.getElementById('exercise-picker-modal').hidden = true;
    exercisePickerOnSelect = null;
  }

  async function renderExercisePickerBody(query) {
    const body = document.getElementById('exercise-picker-body');
    const groups = await groupedExercisesForPicker();
    const q = query.trim().toLowerCase();
    let html;
    if (q) {
      // Searching flattens the muscle hierarchy — useful for browsing when
      // you don't know what you want, but just friction once you're typing
      // a name you already know.
      const matches = [];
      groups.forEach(g => g.exercises.forEach(ex => {
        if (!exercisePickerExcludeIds.has(ex.id) && ex.name.toLowerCase().includes(q)) matches.push(ex);
      }));
      matches.sort((a, b) => a.name.localeCompare(b.name));
      html = matches.length
        ? `<div class="picker-flat-list">${matches.map(ex =>
            `<button type="button" class="picker-ex-row" data-action="pick-exercise" data-exid="${ex.id}">${esc(ex.name)}</button>`
          ).join('')}</div>`
        : `<div class="empty">No exercises match "${esc(query.trim())}".</div>`;
    } else {
      html = groups.map(g => {
        const visible = g.exercises.filter(ex => !exercisePickerExcludeIds.has(ex.id));
        if (!visible.length) return '';
        const open = expandedPickerGroups.has(g.id);
        return `
          <div class="picker-muscle-group">
            <button type="button" class="picker-muscle-header" data-action="toggle-picker-group" data-muscle="${g.id}" aria-expanded="${open}">
              <span>${esc(g.name)}</span>
              <span class="picker-muscle-count">${visible.length}</span>
            </button>
            <div class="picker-muscle-list"${open ? '' : ' hidden'}>
              ${visible.map(ex => `<button type="button" class="picker-ex-row" data-action="pick-exercise" data-exid="${ex.id}">${esc(ex.name)}</button>`).join('')}
            </div>
          </div>`;
      }).join('');
    }
    body.innerHTML = html;
    delegate(body, 'click', EXERCISE_PICKER_ACTIONS);
  }

  const EXERCISE_PICKER_ACTIONS = {
    'pick-exercise': async (el) => {
      const exerciseId = Number(el.dataset.exid);
      const cb = exercisePickerOnSelect;
      closeExercisePicker();
      if (cb) await cb(exerciseId);
    },
    'toggle-picker-group': async (el) => {
      const id = el.dataset.muscle;
      if (expandedPickerGroups.has(id)) expandedPickerGroups.delete(id); else expandedPickerGroups.add(id);
      await renderExercisePickerBody(document.getElementById('exercise-picker-search').value);
    },
  };

  document.getElementById('exercise-picker-search').addEventListener('input', (e) => {
    renderExercisePickerBody(e.target.value);
  });
  document.getElementById('exercise-picker-close').addEventListener('click', closeExercisePicker);
  // Backdrop tap closes too — the modal IS its own backdrop (position:fixed,
  // inset:0, opaque bg), so this only fires for a tap that lands outside the
  // card, same pattern as the drop/myo and full-prompt modals below.
  document.getElementById('exercise-picker-modal').addEventListener('click', (e) => {
    if (e.target.id === 'exercise-picker-modal') closeExercisePicker();
  });
  document.getElementById('exercise-picker-add-new-toggle').addEventListener('click', () => {
    const panel = document.getElementById('exercise-picker-custom');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) document.getElementById('picker-new-ex-name').focus();
  });
  document.getElementById('picker-new-ex-save').addEventListener('click', async () => {
    const name = document.getElementById('picker-new-ex-name').value.trim();
    const muscle = document.getElementById('picker-new-ex-muscle').value;
    if (!name) return;
    // nameKey() is THE key for name matching (see its comment above) — reuse
    // an existing exercise instead of forking a near-miss duplicate that
    // would split that lift's history in two.
    const existing = (await getAllRecords('exercises')).find(ex => nameKey(ex.name) === nameKey(name));
    const id = existing ? existing.id : await addRecord('exercises', { name, primaryMuscle: muscle, secondaryMuscles: [], equipment: classifyEquipmentFromName(name), custom: true });
    invalidateExercisePicker();
    const cb = exercisePickerOnSelect;
    closeExercisePicker();
    if (cb) await cb(id);
  });

  // =========================================================================
  // Drop set / myo reps — logged against ONE exercise at a time, opened from
  // that exercise's own card (.drop-myo-toggle in renderActiveWorkout)
  // rather than a standalone form with its own exercise picker, since the
  // exercise is already known from whichever card was tapped.
  //
  // A drop set / myo cluster is a SEQUENCE of arbitrary weight×rep pairs
  // (e.g. 100×8 → 80×6 → 60×5), not just a start/end weight — that's the
  // actual data shape logSet() already stores (see 02-storage.js's schema
  // comment), and collapsing it to two endpoints would lose the ability to
  // record reps per stage or more than two drops. This reuses that shape
  // exactly, just entered here instead of a top-level form.
  // =========================================================================
  let dropMyoExerciseId = null;
  let dropMyoEntries = [{ weight: '', reps: '' }];

  function openDropMyoModal(exerciseId, exerciseName) {
    dropMyoExerciseId = exerciseId;
    dropMyoEntries = [{ weight: '', reps: '' }];
    document.getElementById('dropmyo-modal-title').textContent = `Log a drop set or myo reps — ${exerciseName}`;
    document.getElementById('dropmyo-type').value = 'drop';
    renderDropMyoRows();
    document.getElementById('dropmyo-modal').hidden = false;
  }
  function closeDropMyoModal() {
    document.getElementById('dropmyo-modal').hidden = true;
    dropMyoExerciseId = null;
  }

  // Click actions for #dropmyo-rows-container: remove one entry row, or flip
  // its weight's sign. Shares 'toggle-sign' with every other sign toggle.
  const DROPMYO_ROW_ACTIONS = {
    'remove-dropmyo-entry': (el) => { dropMyoEntries.splice(Number(el.dataset.idx), 1); renderDropMyoRows(); },
    'toggle-sign': TOGGLE_SIGN_ACTIONS['toggle-sign'],
  };
  const DROPMYO_ROW_INPUT_ACTIONS = {
    'sync-dropmyo-entry': (el) => {
      dropMyoEntries[Number(el.dataset.idx)][el.dataset.field] = el.value;
      if (el.dataset.field === 'weight') syncSignClass(el);
    },
  };

  function renderDropMyoRows() {
    const container = document.getElementById('dropmyo-rows-container');
    container.innerHTML = '';
    dropMyoEntries.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'entry-row';
      const negative = parseFloat(entry.weight) < 0;
      row.innerHTML = `
        <button type="button" class="sign-btn${negative ? ' negative' : ''}" data-action="toggle-sign" title="Toggle negative — for assisted reps, enter how much weight is taken off you">±</button>
        <input type="number" inputmode="decimal" step="0.5" placeholder="Weight (${weightUnit})" value="${entry.weight}" data-idx="${i}" data-field="weight" data-action="sync-dropmyo-entry">
        <input type="number" inputmode="numeric" step="1" min="1" placeholder="Reps" value="${entry.reps}" data-idx="${i}" data-field="reps" data-action="sync-dropmyo-entry" class="entry-reps">
        ${dropMyoEntries.length > 1 ? `<button type="button" class="rm" data-idx="${i}" data-action="remove-dropmyo-entry">×</button>` : ''}
      `;
      container.appendChild(row);
    });
    delegate(container, 'click', DROPMYO_ROW_ACTIONS);
    delegate(container, 'input', DROPMYO_ROW_INPUT_ACTIONS);
    const addBtn = document.getElementById('dropmyo-add-row-btn');
    const type = document.getElementById('dropmyo-type').value;
    addBtn.textContent = type === 'drop' ? '+ Add Drop' : '+ Add Myo Cluster';
  }

  document.getElementById('dropmyo-type').addEventListener('change', renderDropMyoRows);
  document.getElementById('dropmyo-add-row-btn').addEventListener('click', () => {
    dropMyoEntries.push({ weight: '', reps: '' });
    renderDropMyoRows();
  });
  document.getElementById('dropmyo-close').addEventListener('click', closeDropMyoModal);
  document.getElementById('dropmyo-modal').addEventListener('click', (e) => {
    if (e.target.id === 'dropmyo-modal') closeDropMyoModal();
  });
  document.getElementById('dropmyo-log-btn').addEventListener('click', async () => {
    if (dropMyoExerciseId == null) return;
    const exerciseId = dropMyoExerciseId;
    const type = document.getElementById('dropmyo-type').value;
    const entries = dropMyoEntries.map(en => ({ weight: toKg(parseFloat(en.weight)), reps: parseInt(en.reps, 10) }));
    if (entries.some(en => isNaN(en.weight) || isNaN(en.reps))) return;
    const workout = await logSet(exerciseId, type, entries, null);
    if (await getSetting('rirPromptEnabled', true)) {
      const logged = workout.exercises.find(e => e.exerciseId === exerciseId);
      if (logged) showRirPrompt({ workoutId: workout.id, exerciseId, setIndex: logged.sets.length - 1, setTs: logged.sets[logged.sets.length - 1].ts });
    }
    closeDropMyoModal();
    startRestTimer();
    await refreshLogAndHistory();
  });

  // Every previous session for one exercise, for the Log tab's per-exercise
  // History panel.
  //
  // The question this answers — "what did I do last time, and the time before
  // that?" — was only answerable by leaving the workout, switching to the
  // History tab, and scrolling. Mid-set, with a bar racked, that is not a
  // realistic ask. The suggestion line already says what to do next; this says
  // what you have been doing, which is what you check when the suggestion
  // looks wrong.
  //
  // Built from the workouts array the render already holds, so opening it
  // costs no store read.
  function exerciseHistoryHtml(exerciseId, workouts, exercise) {
    const rows = [];
    for (const w of workouts) {
      const entry = w.exercises.find(ex => ex.exerciseId === exerciseId);
      if (!entry || !entry.sets.length) continue;
      rows.push({ date: w.date, sets: entry.sets });
    }
    // Today's own sets are already on screen directly above this panel.
    const today = todayStr();
    const past = rows.filter(r => r.date !== today).sort((a, b) => b.date.localeCompare(a.date));
    if (!past.length) {
      return '<div class="ex-history-empty">No previous sessions for this exercise.</div>';
    }
    // Capped: this is a glance, not the History tab. Ten sessions is about
    // three months of a twice-weekly lift and comfortably more than anyone
    // reads standing at a rack.
    const CAP = 10;
    const shown = past.slice(0, CAP);
    const body = shown.map(r => {
      const d = new Date(r.date + 'T00:00:00');
      const when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const daysAgo = Math.round((Date.parse(today + 'T00:00:00') - Date.parse(r.date + 'T00:00:00')) / 86400000);
      const vol = r.sets.reduce((a, s) => a + setVolumeKg(s, exercise), 0);
      return `
        <div class="ex-history-row">
          <div class="ex-history-line1">
            <span class="ex-history-when">${esc(when)}<em>${daysAgo}d ago</em></span>
            <span class="ex-history-vol">${Math.round(fromKg(vol)).toLocaleString()}${esc(weightUnit)}</span>
          </div>
          <div class="ex-history-sets">${r.sets.map(s => `<span class="ex-history-chip">${esc(formatSetLine(s))}</span>`).join('')}</div>
        </div>`;
    }).join('');
    const more = past.length > CAP
      ? `<div class="ex-history-empty">${past.length - CAP} older session(s) not shown — see the History tab.</div>`
      : '';
    return body + more;
  }

  // Render-time context for the active-workout delegated actions below \u2014
  // the values their closures used to capture directly (plan, the day being
  // shown, the pre-loaded workouts/exercises lookups, today's date string).
  // Set at the top of every renderActiveWorkout() call, read by the actions
  // in WORKOUT_CLICK_ACTIONS/WORKOUT_CHANGE_ACTIONS/WORKOUT_INPUT_ACTIONS,
  // which are named top-level functions rather than closures and so have no
  // other way to reach them. Small per-set values (exercise id, set index,
  // stored kg, plan target, delta) travel on the markup as data-* instead \u2014
  // see the row/button attributes below.
  let activeWorkoutCtx = null;

  // Which exercise's History panel is open, keyed by the effective exercise
  // id \u2014 same pattern as expandedExercises (05-history.js) and for the same
  // reason: renderActiveWorkout() rebuilds this whole section's innerHTML
  // on every logged set, so without tracking it here a panel opened to
  // check "what did I do last time" on one exercise would snap shut the
  // moment a DIFFERENT exercise's set was logged. Swap has no equivalent
  // any more \u2014 it opens the full-screen exercise picker (a fixed top-level
  // element, not part of this re-rendered list) rather than an inline
  // picker that needed its own open-state tracked here.
  const openHistoryPanels = new Set();

  const WORKOUT_CLICK_ACTIONS = {
    'log-set': async (el) => {
      if (el.disabled) return;
      const group = el.closest('.exercise-group');
      if (!group) return;
      const wInput = group.querySelector('.plan-log-weight');
      const rInput = group.querySelector('.plan-log-reps');
      if (!wInput || !rInput) return;
      const exerciseId = Number(group.dataset.exid);
      const weight = parseFloat(wInput.value);
      const reps = parseInt(rInput.value, 10);
      if (isNaN(weight) || isNaN(reps)) return;
      // The prescribed count travels on the group, because the action has no
      // access to the per-exercise locals the render loop computed it from.
      const prescribed = Number(group.dataset.target) || 0;
      const { plan, dayIdx, day } = activeWorkoutCtx;
      // Held down for the whole write-and-repaint. withWorkoutLock() already
      // makes a double-tap safe for the DATA, but safe is not the same as
      // wanted: two taps a phone's-width apart, on a sweaty screen, would
      // otherwise bank two identical sets and the second has to be found and
      // deleted. The button is rebuilt by the refresh below, so this only
      // has to survive until then.
      el.disabled = true;
      try {
        const workout = await logSet(exerciseId, 'standard', [{ weight: toKg(weight), reps }], { planId: plan.id, dayIndex: dayIdx, dayName: day.name });
        // Ask only for the set whose answer is actually read (see "RIR is read
        // from the last set"), and only once it has happened. Decided from the
        // post-write count rather than from the row's position, so "did this
        // complete the prescription" is answered from the data.
        const logged = workout.exercises.find(e => e.exerciseId === exerciseId);
        const done = logged ? logged.sets.length : 0;
        // `logged &&` is load-bearing, not defensive noise: with an
        // unprescribed row (prescribed === 0) `done >= prescribed` is true
        // even when nothing was found, and this used to sail through and ask
        // about set index -1.
        if (logged && done >= prescribed && await getSetting('rirPromptEnabled', true)) {
          showRirPrompt({ workoutId: workout.id, exerciseId, setIndex: done - 1, setTs: logged.sets[done - 1].ts });
        }
        if (shouldRestAfter(done, prescribed)) startRestTimer(); else hideTimerSheet();
        revealNextOnRender = true;
        await refreshLogAndHistory();
      } finally {
        el.disabled = false;
      }
    },
    'toggle-exercise': async (el) => {
      const group = el.closest('.exercise-group');
      if (!group) return;
      const id = Number(group.dataset.exid);
      if (expandedExercises.has(id)) expandedExercises.delete(id); else expandedExercises.add(id);
      await refreshActiveWorkoutSection();
    },
    'delete-set': async (el) => {
      const today = activeWorkoutCtx.today;
      const w = await getWorkoutForDate(today);
      if (!w) return;
      const exerciseId = Number(el.dataset.exid);
      const removed = await deleteSet(w.id, exerciseId, Number(el.dataset.idx));
      await refreshLogAndHistory();
      if (removed) {
        toast('Set deleted', 'ok', { duration: 6000, action: { label: 'Undo', onClick: async () => {
          await restoreSet(today, exerciseId, removed);
          await refreshLogAndHistory();
        } } });
      }
    },
    'show-history': (el) => {
      const group = el.closest('.exercise-group');
      if (!group) return;
      const panel = group.querySelector('.ex-history');
      if (!panel) return;
      const id = Number(group.dataset.exid);
      const opening = panel.style.display !== 'block';
      // Rendered on first open, not on every repaint. Most exercises in a
      // session never have this opened, and building it for all of them
      // would add another pass over the whole workout history to the path
      // that already runs on every single logged set.
      if (opening && panel.dataset.rendered !== 'yes') {
        const { allWorkouts, exercisesById } = activeWorkoutCtx;
        panel.innerHTML = exerciseHistoryHtml(id, allWorkouts, exercisesById[id]);
        panel.dataset.rendered = 'yes';
      }
      panel.style.display = opening ? 'block' : 'none';
      el.setAttribute('aria-expanded', opening ? 'true' : 'false');
      // Tracked the same way expandedExercises tracks collapse state, so a
      // panel opened for THIS exercise survives the next set logged against
      // a DIFFERENT one — renderActiveWorkout() rebuilds the whole list on
      // every logged set, and without this the panel silently closed itself
      // mid-review.
      if (opening) openHistoryPanels.add(id); else openHistoryPanels.delete(id);
    },
    'swap-open': async (el) => {
      const group = el.closest('.exercise-group');
      if (!group) return;
      const origExerciseId = Number(group.dataset.origExid);
      const currentEffectiveId = Number(group.dataset.exid);
      await openExercisePicker({
        title: 'Swap for today',
        excludeIds: new Set([currentEffectiveId]),
        onSelect: async (newExerciseId) => {
          await setSessionSwap(origExerciseId, newExerciseId);
          await refreshActiveWorkoutSection();
        }
      });
    },
    'remove-extra': async (el) => {
      const group = el.closest('.exercise-group');
      if (!group) return;
      const exerciseId = Number(group.dataset.exid);
      await removeExtraExercise(exerciseId);
      await refreshActiveWorkoutSection();
    },
    'open-drop-myo': (el) => {
      const group = el.closest('.exercise-group');
      if (!group) return;
      const exerciseId = Number(group.dataset.exid);
      const rec = activeWorkoutCtx.exercisesById[exerciseId];
      openDropMyoModal(exerciseId, rec ? rec.name : 'this exercise');
    },
    'adjust-sets': async (el) => {
      const group = el.closest('.exercise-group');
      if (!group) return;
      const exerciseId = Number(group.dataset.exid);
      const planTarget = Number(el.dataset.planTarget);
      const delta = Number(el.dataset.delta);
      await adjustTodayTargetSets(exerciseId, planTarget, delta);
      await refreshActiveWorkoutSection();
    },
    'toggle-sign': TOGGLE_SIGN_ACTIONS['toggle-sign'],
  };
  // 'edit-set' change: commits an inline weight/reps edit on a logged
  // standard set — see "Editing a logged set" in the design summary.
  const WORKOUT_CHANGE_ACTIONS = {
    'edit-set': async (el) => {
      const row = el.closest('.plan-log-row');
      if (!row) return;
      const wInput = row.querySelector('.set-edit-weight');
      const rInput = row.querySelector('.set-edit-reps');
      if (!wInput || !rInput) return; // see the matching guard in refreshLogAndHistory
      const weight = parseFloat(wInput.value);
      const reps = parseInt(rInput.value, 10);
      if (isNaN(weight) || isNaN(reps)) return;
      const exerciseId = Number(row.dataset.exid);
      const setIndex = Number(row.dataset.idx);
      const originalKg = parseFloat(row.dataset.kg);
      const w = await getWorkoutForDate(activeWorkoutCtx.today);
      if (!w) return;
      await updateStandardSet(w.id, exerciseId, setIndex, weightToStore(weight, originalKg), reps);
      await refreshLogAndHistory();
    },
  };
  // Same reuse-the-data-action-value pattern as History's 'edit-set': the
  // 'input' event on a done row's weight input only ever needs the cosmetic
  // sign-class sync, never a write. 'sync-sign' covers the same sync for the
  // next-set row's weight input, which has no 'edit-set' change handler to
  // share the attribute with.
  const WORKOUT_INPUT_ACTIONS = {
    'edit-set': (el) => syncSignClass(el),
    'sync-sign': (el) => syncSignClass(el),
  };

  // The Log tab's "active workout" — this is where sets actually get logged
  // against today's plan day. Anything changed here (session-only swap,
  // today-only target-set override) is scoped to today's `workouts` record
  // only; it never touches the plan itself. Compare renderPlanDayOverview
  // above, which edits the plan record permanently.
  async function renderActiveWorkout(plan, dayIdx, workouts) {
    const day = plan.days[dayIdx];
    const container = document.getElementById('active-workout-list');
    container.innerHTML = '<div class="empty">Working out your next sets…</div>';
    const today = todayStr();
    // Shared exercise-picker list is rebuilt at most once for this render.
    invalidateExercisePicker();
    // Read the workout store ONCE for the whole render. Every exercise on the
    // day needs the full history for its progression suggestion, and
    // suggestForExercise() used to fetch and deserialise the entire store for
    // each one — so a 6-exercise day did 7 full scans (6 plus getWorkoutForDate)
    // where 1 would do. Cost per scan grows forever with training history,
    // which is exactly the kind of thing that is invisible at 30 days and
    // sluggish at three years.
    //
    // Reused from the caller when there is one: refreshLogAndHistory() has
    // already loaded exactly this array, and logging a set used to push the
    // whole store through four separate full scans (the history render, the
    // week counter, this, and the session-card lookup) before the screen
    // settled.
    const allWorkouts = workouts || await getAllWorkouts();
    // Read once for the whole render, same reason as the workouts above: the
    // loop needs each exercise's equipment class, and a getRecord per row
    // would be one store read per exercise per repaint.
    const exercisesById = Object.fromEntries((await getAllRecords('exercises')).map(e => [e.id, e]));
    // See the comment on activeWorkoutCtx's declaration above.
    activeWorkoutCtx = { plan, dayIdx, day, today, allWorkouts, exercisesById };
    const todayWorkout = allWorkouts.find(w => w.date === today) || null;

    // Builds one exercise-group card. `slot` mirrors a plan day's exercise
    // shape ({exerciseId, name, targetSets, repRangeMin, repRangeMax})
    // whether it actually came from the plan or from today's ad-hoc
    // extraExercises (Add Exercise) — the suggestion, set rows, history
    // panel and target-set adjustment all work identically either way.
    // `allowSwap` is false for an extra: there's no plan slot whose identity
    // needs preserving, so swapping one exercise for another isn't "same
    // slot, different movement" the way it is for a planned exercise — you'd
    // just remove it and add the one you meant. `allowRemove` offers that
    // undo, but only while nothing's logged yet (see removeExtraExerciseLocked).
    async function buildCard(slot, { allowSwap, allowRemove }) {
      const swappedId = allowSwap && todayWorkout && todayWorkout.exerciseSwaps ? todayWorkout.exerciseSwaps[slot.exerciseId] : undefined;
      const isSwapped = swappedId != null;
      const effectiveExerciseId = isSwapped ? swappedId : slot.exerciseId;
      let effectiveName = slot.name;
      if (isSwapped) {
        const swappedEx = exercisesById[swappedId];
        effectiveName = swappedEx ? swappedEx.name : slot.name;
      }
      const suggestion = await suggestForExercise(effectiveExerciseId, slot.repRangeMin, slot.repRangeMax, slot.targetSets, allWorkouts, exercisesById);
      const exEntry = todayWorkout ? todayWorkout.exercises.find(e => e.exerciseId === effectiveExerciseId) : null;
      const todaySets = exEntry ? exEntry.sets : [];
      const doneCount = todaySets.length;
      const overrideVal = todayWorkout && todayWorkout.targetOverrides ? todayWorkout.targetOverrides[effectiveExerciseId] : undefined;
      const effectiveTarget = overrideVal != null ? overrideVal : slot.targetSets;
      const isOverridden = overrideVal != null;
      const isComplete = doneCount >= effectiveTarget && effectiveTarget > 0;
      const isOpen = !isComplete || expandedExercises.has(effectiveExerciseId);
      // The +/- sign toggle only appears where a negative can legitimately be
      // entered. The sign is stored per SET (a negative weight is the
      // assistance), not as a flag on the exercise -- but the equipment class
      // IS on the exercise, so it can decide whether to offer the control.
      // Also shown if a logged value is already negative, so it can be undone.
      const equipClass = exerciseEquipment(exercisesById[effectiveExerciseId]);
      const allowNegative = equipClass === 'assisted'
        || todaySets.some(st => st.entries.some(en => en.weight < 0))
        || (suggestion.weight != null && suggestion.weight < 0);
      // Initial `.negative` class is baked in here rather than set by an
      // eager sync() call, since each usage below already knows the value
      // it's about to render.
      const signBtnHtml = (negative) => allowNegative
        ? `<button type="button" class="sign-btn${negative ? ' negative' : ''}" data-action="toggle-sign" title="Toggle negative — for assisted reps, enter how much weight is taken off you">±</button>`
        : '';
      // Only before anything's logged today -- once a set is on the board the
      // lifter is already warmed up, and the suggestion row below stops being
      // about the FIRST set of the exercise.
      const warmups = doneCount === 0 ? warmupSets(suggestion.weight, exercisesById[effectiveExerciseId]) : [];
      const totalRows = isComplete ? doneCount : Math.max(effectiveTarget, doneCount + 1);
      let setRowsHtml = '';
      for (let i = 0; i < totalRows; i++) {
        const setNum = i + 1;
        if (i < doneCount) {
          const s = todaySets[i];
          if (s.type === 'standard') {
            setRowsHtml += `
              <div class="plan-log-row done-set" data-exid="${effectiveExerciseId}" data-idx="${i}" data-kg="${s.entries[0].weight}">
                <span class="set-idx">${setNum}</span>
                ${signBtnHtml(s.entries[0].weight < 0)}
                <input type="number" inputmode="decimal" step="0.5" class="set-edit-weight" data-action="edit-set" aria-label="Weight" value="${displayWeight(s.entries[0].weight)}">
                <input type="number" inputmode="numeric" step="1" min="1" class="set-edit-reps" data-action="edit-set" aria-label="Reps" value="${s.entries[0].reps}">
                <button class="del" data-exid="${effectiveExerciseId}" data-idx="${i}" data-action="delete-set" title="Delete set">×</button>
              </div>
            `;
          } else {
            setRowsHtml += `
              <div class="set-row">
                <span class="set-idx">${setNum}</span>
                <span class="set-data">${esc(formatSetLine(s))}</span>
                <button class="del" data-exid="${effectiveExerciseId}" data-idx="${i}" data-action="delete-set" title="Delete set">×</button>
              </div>
            `;
          }
        } else if (i === doneCount) {
          const label = setNum > effectiveTarget ? `${setNum}+` : `${setNum}`;
          const wVal = suggestion.weight != null ? displayWeight(suggestion.weight) : '';
          const rVal = suggestion.reps != null ? suggestion.reps : '';
          setRowsHtml += `
            <div class="plan-log-row next-set">
              <span class="set-idx">${label}</span>
              ${signBtnHtml(suggestion.weight != null && suggestion.weight < 0)}
              <input type="number" inputmode="decimal" step="0.5" placeholder="${weightUnit}" aria-label="Weight in ${weightUnit}" class="plan-log-weight" data-action="sync-sign" value="${wVal}">
              <input type="number" inputmode="numeric" step="1" min="1" placeholder="reps" aria-label="Reps" class="plan-log-reps" value="${rVal}">
              <button type="button" class="log-btn" data-action="log-set">Log</button>
            </div>
          `;
        } else {
          setRowsHtml += `
            <div class="set-row pending">
              <span class="set-idx">${setNum}</span>
              <span class="set-data">to come</span>
            </div>
          `;
        }
      }
      // Finished exercises collapse to a one-line summary and stay exactly
      // where they are in the list. They used to keep their full height, so
      // the only way to reach the next exercise was to scroll past a wall of
      // completed rows -- and every log rebuilt the list under you.
      //
      // `expandedExercises` survives the re-render, so re-opening one to fix
      // a mis-logged set doesn't snap shut on the next refresh. `openHistoryPanels`
      // does the same for the History panel -- see their declaration up top.
      const setSummary = todaySets.map(st => formatSetLine(st)).join(` · `);
      const historyOpen = openHistoryPanels.has(effectiveExerciseId);
      const canRemove = allowRemove && doneCount === 0;
      const secondaryBtn = isComplete
        ? `<button type="button" class="ex-toggle" data-action="toggle-exercise" aria-expanded="${isOpen}" aria-label="${isOpen ? 'Collapse' : 'Expand'} ${esc(effectiveName)}" title="${isOpen ? 'Collapse' : 'Expand to edit'}">${isOpen ? '⌃' : '⌄'}</button>`
        : allowSwap
          ? `<button type="button" class="swap-btn" data-action="swap-open">Swap</button>`
          : canRemove
            ? `<button type="button" class="remove-ex-btn" data-action="remove-extra" title="Remove — nothing logged yet">Remove</button>`
            : '';
      return `
        <div class="exercise-group${isComplete ? ' complete' : ''}${isOpen ? '' : ' collapsed'}" data-exid="${effectiveExerciseId}" data-orig-exid="${slot.exerciseId}" data-target="${effectiveTarget}">
          <div class="ex-name">
            <span>${isComplete ? '<span class="ex-tick">✓</span> ' : ''}${esc(effectiveName)}${isSwapped ? ` <span class="override-note">swapped today</span>` : ''}${!allowSwap ? ` <span class="override-note">added today</span>` : ''}</span>
            <span class="ex-actions">
              <button type="button" class="hist-btn" data-action="show-history" aria-expanded="${historyOpen}" aria-label="Previous sessions of ${esc(effectiveName)}" title="Previous sessions">History</button>
              ${secondaryBtn}
            </span>
          </div>
          ${isComplete && !isOpen ? `<div class="meta-row ex-digest">${esc(setSummary)}</div>` : ''}
          <div class="ex-history"${historyOpen ? ' style="display:block" data-rendered="yes"' : ''}>${historyOpen ? exerciseHistoryHtml(effectiveExerciseId, allWorkouts, exercisesById[effectiveExerciseId]) : ''}</div>
          <div class="meta-row">
            <button type="button" class="today-set-adj" data-action="adjust-sets" data-delta="-1" data-plan-target="${slot.targetSets}" title="Skip a set today — reverts automatically next time this day comes around">−</button>
            <span>${effectiveTarget} sets × ${slot.repRangeMin}-${slot.repRangeMax} reps</span>
            <button type="button" class="today-set-adj" data-action="adjust-sets" data-delta="1" data-plan-target="${slot.targetSets}" title="Add a set today — reverts automatically next time this day comes around">+</button>
            ${isOverridden ? `<span class="override-note">today only</span>` : ''}
            ${doneCount ? `<span class="done-count">${doneCount}/${effectiveTarget} logged</span>` : ''}
          </div>
          <div class="meta-row suggestion">
            <span class="sugg-text">${esc(suggestion.text)}</span>
            ${(suggestion.why || []).map(w => `<span class="sugg-tag">${esc(w)}</span>`).join('')}
          </div>
          ${warmups.length ? `
          <div class="meta-row warmup">
            <span>Warm-up</span>
            ${warmups.map(w => `<span class="sugg-tag">${displayWeight(w.weightKg)}${weightUnit} × ${w.reps}</span>`).join('')}
          </div>` : ''}
          <div class="meta-row drop-myo-toggle">
            <button type="button" class="link-btn" data-action="open-drop-myo">+ Log a drop set or myo reps</button>
          </div>
          ${setRowsHtml}
        </div>
      `;
    }

    const rows = [];
    for (const ex of day.exercises) {
      rows.push(await buildCard(ex, { allowSwap: true, allowRemove: false }));
    }
    if (todayWorkout && todayWorkout.extraExercises) {
      for (const ex of todayWorkout.extraExercises) {
        const rec = exercisesById[ex.exerciseId];
        rows.push(await buildCard(
          { exerciseId: ex.exerciseId, name: rec ? rec.name : 'Unknown exercise',
            targetSets: ex.targetSets, repRangeMin: ex.repRangeMin, repRangeMax: ex.repRangeMax },
          { allowSwap: false, allowRemove: true }
        ));
      }
    }
    container.innerHTML = rows.join('');

    // After a log the list shrinks -- completed exercises collapse and the
    // page gets shorter -- and the browser clamps the scroll position to the
    // new maximum, which is what dumped the user at the bottom of the page.
    // Bring the next thing to do into view instead. `block: 'nearest'` is a
    // no-op when it is already visible, so this never yanks the page around
    // for someone who can already see what they need.
    if (revealNextOnRender) {
      revealNextOnRender = false;
      const nextUp = container.querySelector('.exercise-group:not(.complete)');
      if (nextUp && nextUp.scrollIntoView) nextUp.scrollIntoView({ block: 'nearest' });
    }

    delegate(container, 'click', WORKOUT_CLICK_ACTIONS);
    delegate(container, 'change', WORKOUT_CHANGE_ACTIONS);
    delegate(container, 'input', WORKOUT_INPUT_ACTIONS);
  }

  // Opens the exercise picker to add an off-plan exercise to TODAY only,
  // as a normal card (target sets/rep range from Settings' plan defaults,
  // same as a fresh plan would use) rather than the old "Log a set
  // manually" form's one typed-in weight. Lives inside #active-workout-wrap
  // (hidden along with everything else when there's no active plan), so
  // activeWorkoutCtx is always populated whenever this can actually fire.
  document.getElementById('add-exercise-btn').addEventListener('click', async () => {
    if (!activeWorkoutCtx) return;
    const { plan, day, allWorkouts, today } = activeWorkoutCtx;
    const todayWorkout = allWorkouts.find(w => w.date === today) || null;
    const excludeIds = new Set(day.exercises.map(ex => ex.exerciseId));
    if (todayWorkout && todayWorkout.exerciseSwaps) {
      Object.values(todayWorkout.exerciseSwaps).forEach(id => excludeIds.add(id));
    }
    if (todayWorkout && todayWorkout.extraExercises) {
      todayWorkout.extraExercises.forEach(ex => excludeIds.add(ex.exerciseId));
    }
    // "The normal set and rep range" means THIS plan's own — not whatever
    // the Plan tab's form currently holds, which can drift from the active
    // plan if it was edited without regenerating. Settings is only the
    // fallback, for a plan record old enough to predate these fields.
    const repMin = Number(plan.repRangeMin) || Number(await getSetting('planRepMin', 0)) || 8;
    const repMax = Number(plan.repRangeMax) || Number(await getSetting('planRepMax', 0)) || 12;
    const targetSets = Number(plan.fixedSets) || 3;
    await openExercisePicker({
      title: 'Add an exercise',
      excludeIds,
      onSelect: async (exerciseId) => {
        await addExtraExercise(exerciseId, targetSets, repMin, repMax);
        await refreshActiveWorkoutSection();
      }
    });
  });

  // Weight/rep fields select their whole value on focus, so tapping into one
  // that already has a number in it (a suggested weight, a logged set being
  // corrected) replaces it outright. Without this, a tap drops the cursor at
  // the tap point and the phone's numeric keypad inserts into or appends onto
  // what's already there — a stray leading/trailing digit is the normal
  // result, not a clean overwrite. A capturing `focus` listener on `document`
  // rather than `delegate()`: this runs on every render (the whole list is
  // rebuilt), so it is registered once, here, at module load, instead of
  // per-render.
  document.addEventListener('focus', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('.plan-log-weight, .plan-log-reps, .set-edit-weight, .set-edit-reps')) {
      t.select();
    }
  }, true);

  // Owns the Log tab's day-picker + active-workout list. Keeps the user's
  // in-session day choice sticky (selectedLogDayIdx) across re-renders
  // triggered by refreshLogAndHistory, instead of snapping back to whatever
  // today's workout record implies every time a set is logged.
  let selectedLogDayIdx = null;

  // `workouts` is optional and purely an optimisation — passed down by
  // refreshLogAndHistory(), which has already read the store, and omitted by
  // the handlers that call this on its own.
  async function refreshActiveWorkoutSection(workouts) {
    const wrap = document.getElementById('active-workout-wrap');
    const daySelect = document.getElementById('log-day-picker');
    const plan = await getCurrentPlan();
    if (!plan) {
      wrap.style.display = 'none';
      document.getElementById('active-workout-list').innerHTML = '';
      selectedLogDayIdx = null;
      return;
    }
    wrap.style.display = 'block';
    if (selectedLogDayIdx == null || selectedLogDayIdx >= plan.days.length) {
      const todayWorkout = workouts
        ? workouts.find(w => w.date === todayStr()) || null
        : await getWorkoutForDate(todayStr());
      if (todayWorkout && todayWorkout.planId === plan.id && todayWorkout.dayIndex != null) {
        // Already logged something today against this plan — show whatever
        // day that was, not wherever the rotation below would otherwise land.
        selectedLogDayIdx = todayWorkout.dayIndex;
      } else {
        // Nothing logged yet today: advance to the day AFTER whichever one
        // was last actually trained against THIS plan, so the split rotates
        // on its own (Push, Pull, Legs, Push, ...) instead of resetting to
        // day 0 every morning nothing's been logged yet. Scoped to plan.id
        // rather than "the last workout of any kind" because regenerating a
        // plan always creates a new id (see generatePlanWithAI) — an old
        // plan's day count/order can't be assumed to line up with this
        // one's, so a fresh plan correctly starts back at day 0 instead of
        // inheriting a stale index from whatever came before it. A session
        // only counts if it actually has a logged set — a started-but-empty
        // one (warm-up timer tapped, nothing logged) shouldn't advance the
        // rotation past a day that never really happened.
        const allWorkouts = workouts || await getAllWorkouts();
        const lastForPlan = allWorkouts
          .filter(w => w.planId === plan.id && w.dayIndex != null && w.date !== todayStr()
            && w.exercises.some(ex => ex.sets.length > 0))
          .sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0))[0];
        selectedLogDayIdx = lastForPlan ? (lastForPlan.dayIndex + 1) % plan.days.length : 0;
      }
    }
    daySelect.innerHTML = plan.days.map((d, i) => `<option value="${i}">${esc(d.name)}</option>`).join('');
    daySelect.value = String(selectedLogDayIdx);
    // No cached array here: picking a different day is a fresh interaction,
    // and the store may have moved on since the render that wired this.
    daySelect.onchange = async () => {
      selectedLogDayIdx = Number(daySelect.value);
      await renderActiveWorkout(plan, selectedLogDayIdx);
    };
    await renderActiveWorkout(plan, selectedLogDayIdx, workouts);
  }
