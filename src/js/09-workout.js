  // 09-workout.js — Workout tab — active workout render
  // The swap picker's <option> list — identical for every picker on screen, so
  // it is built at most ONCE per render and then handed out.
  //
  // It used to take the current exercise id and bake `selected` into the
  // markup, which forced a rebuild per exercise row: two full store reads and
  // a fresh ~100-option string every time. A four-day plan with twelve slots
  // therefore did twenty-four store reads and built twelve copies of the same
  // list — and renderActiveWorkout repaints on EVERY logged set, so the Log
  // tab paid it mid-workout, over and over. Selection is now set on the
  // element (sel.value) instead, which is what makes the string shareable.
  //
  // Nothing is attached until a picker is actually opened, either: every
  // .swap-picker starts hidden, so materialising a hundred option nodes inside
  // each one was work for a control most sessions never touch.
  let swapOptionsCache = null;
  function invalidateSwapOptions() { swapOptionsCache = null; }
  function exerciseOptionsHtml() {
    if (!swapOptionsCache) swapOptionsCache = buildExerciseOptionsHtml();
    return swapOptionsCache;
  }

  // Fills a picker's <select> on first open and selects the row's current
  // exercise. Cheap and idempotent — re-opening a populated picker is a
  // no-op beyond the toggle.
  async function ensureSwapOptions(sel, currentExerciseId) {
    if (!sel || sel.dataset.populated === 'yes') return;
    sel.innerHTML = await exerciseOptionsHtml();
    sel.dataset.populated = 'yes';
    if (currentExerciseId != null) sel.value = String(currentExerciseId);
  }

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

  async function buildExerciseOptionsHtml() {
    const exercises = await getAllRecords('exercises');
    const prefs = await getAllRecords('exercisePrefs');
    const dislikedIds = new Set(prefs.filter(p => p.disliked).map(p => p.exerciseId));
    const musclesById = Object.fromEntries(MUSCLES.map(m => [m.id, m]));
    const groups = {};
    exercises.filter(e => !dislikedIds.has(e.id)).forEach(ex => {
      const mname = (musclesById[ex.primaryMuscle] || { name: 'Other' }).name;
      if (!groups[mname]) groups[mname] = [];
      groups[mname].push(ex);
    });
    return Object.keys(groups).sort().map(mname => `
      <optgroup label="${esc(mname)}">
        ${groups[mname].sort((a, b) => a.name.localeCompare(b.name)).map(ex =>
          `<option value="${ex.id}">${esc(ex.name)}</option>`
        ).join('')}
      </optgroup>
    `).join('');
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
      const opening = panel.style.display !== 'block';
      // Rendered on first open, not on every repaint. Most exercises in a
      // session never have this opened, and building it for all of them
      // would add another pass over the whole workout history to the path
      // that already runs on every single logged set.
      if (opening && panel.dataset.rendered !== 'yes') {
        const id = Number(group.dataset.exid);
        const { allWorkouts, exercisesById } = activeWorkoutCtx;
        panel.innerHTML = exerciseHistoryHtml(id, allWorkouts, exercisesById[id]);
        panel.dataset.rendered = 'yes';
      }
      panel.style.display = opening ? 'block' : 'none';
      el.setAttribute('aria-expanded', opening ? 'true' : 'false');
    },
    'swap-open': async (el) => {
      const group = el.closest('.exercise-group');
      if (!group) return;
      const picker = group.querySelector('.swap-picker');
      if (!picker) return;
      await ensureSwapOptions(picker.querySelector('.swap-select'), Number(group.dataset.exid));
      picker.style.display = picker.style.display === 'block' ? 'none' : 'block';
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
  // standard set \u2014 see "Editing a logged set" in the design summary.
  // 'swap-select' change: the session-only swap (never touches the plan
  // record \u2014 compare the Plan tab's PERMANENT swap in renderPlanDayOverview).
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
    'swap-select': async (el) => {
      const group = el.closest('.exercise-group');
      if (!group) return;
      const origExerciseId = Number(group.dataset.origExid);
      const currentEffectiveId = Number(group.dataset.exid);
      const newExerciseId = Number(el.value);
      if (newExerciseId === currentEffectiveId) return;
      await setSessionSwap(origExerciseId, newExerciseId);
      await refreshActiveWorkoutSection();
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

  // The Log tab's "active workout" \u2014 this is where sets actually get logged
  // against today's plan day. Anything changed here (session-only swap,
  // today-only target-set override) is scoped to today's `workouts` record
  // only; it never touches the plan itself. Compare renderPlanDayOverview
  // above, which edits the plan record permanently.
  async function renderActiveWorkout(plan, dayIdx, workouts) {
    const day = plan.days[dayIdx];
    const container = document.getElementById('active-workout-list');
    container.innerHTML = '<div class="empty">Working out your next sets\u2026</div>';
    const today = todayStr();
    // Shared option list is rebuilt at most once for this render \u2014 see
    // exerciseOptionsHtml().
    invalidateSwapOptions();
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
    const rows = [];
    for (const ex of day.exercises) {
      const swappedId = todayWorkout && todayWorkout.exerciseSwaps ? todayWorkout.exerciseSwaps[ex.exerciseId] : undefined;
      const isSwapped = swappedId != null;
      const effectiveExerciseId = isSwapped ? swappedId : ex.exerciseId;
      let effectiveName = ex.name;
      if (isSwapped) {
        const swappedEx = exercisesById[swappedId];
        effectiveName = swappedEx ? swappedEx.name : ex.name;
      }
      const suggestion = await suggestForExercise(effectiveExerciseId, ex.repRangeMin, ex.repRangeMax, ex.targetSets, allWorkouts, exercisesById);
      const exEntry = todayWorkout ? todayWorkout.exercises.find(e => e.exerciseId === effectiveExerciseId) : null;
      const todaySets = exEntry ? exEntry.sets : [];
      const doneCount = todaySets.length;
      const overrideVal = todayWorkout && todayWorkout.targetOverrides ? todayWorkout.targetOverrides[effectiveExerciseId] : undefined;
      const effectiveTarget = overrideVal != null ? overrideVal : ex.targetSets;
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
        ? `<button type="button" class="sign-btn${negative ? ' negative' : ''}" data-action="toggle-sign" title="Toggle negative \u2014 for assisted reps, enter how much weight is taken off you">\u00b1</button>`
        : '';
      // Only before anything's logged today \u2014 once a set is on the board the
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
                <button class="del" data-exid="${effectiveExerciseId}" data-idx="${i}" data-action="delete-set" title="Delete set">\u00d7</button>
              </div>
            `;
          } else {
            setRowsHtml += `
              <div class="set-row">
                <span class="set-idx">${setNum}</span>
                <span class="set-data">${esc(formatSetLine(s))}</span>
                <button class="del" data-exid="${effectiveExerciseId}" data-idx="${i}" data-action="delete-set" title="Delete set">\u00d7</button>
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
      // a mis-logged set doesn't snap shut on the next refresh.
      const setSummary = todaySets.map(st => formatSetLine(st)).join(' \u00b7 ');
      rows.push(`
        <div class="exercise-group${isComplete ? ' complete' : ''}${isOpen ? '' : ' collapsed'}" data-exid="${effectiveExerciseId}" data-orig-exid="${ex.exerciseId}" data-target="${effectiveTarget}">
          <div class="ex-name">
            <span>${isComplete ? '<span class="ex-tick">\u2713</span> ' : ''}${esc(effectiveName)}${isSwapped ? ` <span class="override-note">swapped today</span>` : ''}</span>
            <span class="ex-actions">
              <button type="button" class="hist-btn" data-action="show-history" aria-expanded="false" aria-label="Previous sessions of ${esc(effectiveName)}" title="Previous sessions">History</button>
              ${isComplete
                ? `<button type="button" class="ex-toggle" data-action="toggle-exercise" aria-expanded="${isOpen}" aria-label="${isOpen ? 'Collapse' : 'Expand'} ${esc(effectiveName)}" title="${isOpen ? 'Collapse' : 'Expand to edit'}">${isOpen ? '\u2303' : '\u2304'}</button>`
                : `<button type="button" class="swap-btn" data-action="swap-open">Swap</button>`}
            </span>
          </div>
          ${isComplete && !isOpen ? `<div class="meta-row ex-digest">${esc(setSummary)}</div>` : ''}
          <div class="swap-picker">
            <select class="swap-select" data-action="swap-select" aria-label="Swap ${esc(effectiveName)} for today"></select>
          </div>
          <div class="ex-history"></div>
          <div class="meta-row">
            <button type="button" class="today-set-adj" data-action="adjust-sets" data-delta="-1" data-plan-target="${ex.targetSets}" title="Skip a set today \u2014 reverts automatically next time this day comes around">\u2212</button>
            <span>${effectiveTarget} sets \u00d7 ${ex.repRangeMin}-${ex.repRangeMax} reps</span>
            <button type="button" class="today-set-adj" data-action="adjust-sets" data-delta="1" data-plan-target="${ex.targetSets}" title="Add a set today \u2014 reverts automatically next time this day comes around">+</button>
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
          ${setRowsHtml}
        </div>
      `);
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
      selectedLogDayIdx = (todayWorkout && todayWorkout.planId === plan.id && todayWorkout.dayIndex != null)
        ? todayWorkout.dayIndex : 0;
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
