  // 11-plan.js — Plan tab render, weekly regeneration, generatePlanWithAI, starting weights AI, plan form persistence
  // =========================================================================
  // Plan tab
  // =========================================================================
  async function getCurrentPlan() {
    const plans = await getAllRecords('plans');
    if (plans.length === 0) return null;
    return plans.sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  // The "Generate a new plan" disclosure starts open when there's nothing to
  // show instead (no plan yet) and closes itself once a plan exists — but
  // never OVER the user's own hand: once they've opened it themselves this
  // session, refreshPlanTab() stops touching `open` at all, so generating a
  // second plan while it's open on purpose doesn't slam it shut mid-review.
  //
  // Setting `.open` from script fires the same `toggle` event a user click
  // does, so the listener below would otherwise mark every programmatic sync
  // as "the user opened it." planFormDisclosureSyncing brackets our own
  // writes so the listener can tell the two apart.
  let planFormUserOpened = false;
  let planFormDisclosureSyncing = false;
  {
    const el = document.getElementById('plan-form-disclosure');
    if (el) el.addEventListener('toggle', () => {
      if (!planFormDisclosureSyncing) planFormUserOpened = true;
    });
  }
  function setPlanFormDisclosureOpen(open) {
    if (planFormUserOpened) return;
    const el = document.getElementById('plan-form-disclosure');
    if (!el) return;
    planFormDisclosureSyncing = true;
    el.open = open;
    planFormDisclosureSyncing = false;
  }

  async function refreshPlanTab() {
    const container = document.getElementById('plan-current');
    const overview = document.getElementById('plan-day-overview');
    // The Log tab's day pick is left alone here — this is also called after
    // many non-plan changes (settings saves, equipment changes, unit
    // switches, import, restore), not just on init or after generating a new
    // plan. Callers that actually introduce a new plan reset it themselves.
    const plan = await getCurrentPlan();
    setPlanFormDisclosureOpen(!plan);
    if (!plan) {
      container.innerHTML = '<div class="empty">No plan yet.<br>Generate one below and it becomes your active workout on the Log tab.</div>';
      overview.innerHTML = '';
      await refreshWeeklyPlanPrompt(null);
      await refreshActiveWorkoutSection();
      return;
    }
    const weeksOld = weeksBetween(weekKeyOfTs(plan.createdAt), startOfWeek(todayStr()));
    container.innerHTML = `
      <div class="exercise-group">
        <div class="ex-name"><span>${esc(plan.goal)}</span><span class="done-count">${plan.daysPerWeek}x/week</span></div>
        <div class="meta-row">Generated ${new Date(plan.createdAt).toLocaleDateString()} \u00b7 ${plan.days.length} days \u00b7 ${weeksOld === 0 ? 'this week' : weeksOld === 1 ? 'last week' : weeksOld + ' weeks ago'}</div>
      </div>
    `;
    await refreshWeeklyPlanPrompt(plan);
    await renderPlanDayOverview(plan);
    await refreshActiveWorkoutSection();
  }

  // =========================================================================
  // Start-of-week plan regeneration
  //
  // Plans are meant to turn over weekly. The generator already receives the
  // previous plan and is told to vary from it, so the only piece missing was
  // the nudge to run it.
  //
  // It is a PROMPT, never an automatic call, for two reasons that both matter:
  // generation spends real OpenRouter credit, and a plan that rewrote itself
  // in the background would change the exercises out from under a half-finished
  // week \u2014 you'd walk into the gym on Thursday to a different session than the
  // one you were three days into.
  //
  // "This week" is the same Monday-based week the weekly-progress counter
  // already uses, so the prompt lines up with the "2 of 4 done" card directly
  // above it instead of inventing a second notion of a week.
  //
  // Dismissal is stored as the WEEK it applies to rather than as a boolean, so
  // it expires by itself next Monday with no cleanup \u2014 the same trick the
  // today-only set overrides use by living on a dated record.
  // =========================================================================
  function weekKeyOfTs(ts) {
    const d = new Date(ts);
    return startOfWeek(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  function weeksBetween(fromWeekStart, toWeekStart) {
    const a = Date.parse(fromWeekStart + 'T00:00:00');
    const b = Date.parse(toWeekStart + 'T00:00:00');
    return Math.max(0, Math.round((b - a) / (7 * 86400000)));
  }

  async function refreshWeeklyPlanPrompt(plan) {
    const box = document.getElementById('week-plan-prompt');
    if (!box) return;
    if (!plan) { box.hidden = true; return; }
    const thisWeek = startOfWeek(todayStr());
    const planWeek = weekKeyOfTs(plan.createdAt);
    const dismissedFor = await getSetting('planWeekDismissed', '');
    if (planWeek >= thisWeek || dismissedFor === thisWeek) { box.hidden = true; return; }

    const weeksOld = weeksBetween(planWeek, thisWeek);
    const monday = new Date(thisWeek + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    document.getElementById('week-plan-prompt-text').textContent =
      `New training week (from ${monday}) \u2014 your plan is ${weeksOld === 1 ? 'a week' : weeksOld + ' weeks'} old.`;

    // Spells out exactly what the one tap will do, including that it costs
    // money and what it reuses, so "Generate" is never a leap of faith.
    const hasKey = !!(await getSetting('openrouterKey', ''));
    // Reads the SAME live-first values the button will actually send, so the
    // summary can't promise one thing and generate another \u2014 in particular it
    // must show a note that has been edited since last week's plan, since
    // that is the whole reason those fields now persist.
    const goal = (await getSetting('planGoal', '')) || plan.goal;
    const equipment = (await getSetting('planEquipment', null)) ?? (plan.equipment || '');
    const notes = (await getSetting('planNotes', null)) ?? (plan.notes || '');
    const repMin = Number(await getSetting('planRepMin', 0)) || plan.repRangeMin || 8;
    const repMax = Number(await getSetting('planRepMax', 0)) || plan.repRangeMax || 12;
    const fixedSets = Number(await getSetting('planFixedSets', 0)) || plan.fixedSets || null;
    const fixed = fixedSets ? `${fixedSets} sets per exercise` : 'AI-chosen set counts';
    document.getElementById('week-plan-prompt-hint').innerHTML = hasKey
      ? `Reuses your saved setup \u2014 <strong>${esc(goal)}</strong>, ${esc(equipment || 'standard commercial gym')}, `
        + `${repMin}\u2013${repMax} reps, ${esc(fixed)} \u2014 with your current days-per-week and split settings, `
        + `and asks for something different from the plan you just finished. `
        + (notes ? `Your notes still apply: <em>${esc(notes)}</em>. ` : '')
        + `Costs one OpenRouter call. Your logged history is untouched either way.`
      : `Add an OpenRouter API key in Settings to generate a new one. Keeping the current plan changes nothing.`;
    document.getElementById('week-plan-generate').disabled = !hasKey;
    box.hidden = false;
  }

  document.getElementById('week-plan-keep').addEventListener('click', async () => {
    await setSetting('planWeekDismissed', startOfWeek(todayStr()));
    document.getElementById('week-plan-prompt').hidden = true;
    toast('Keeping your current plan this week');
  });

  document.getElementById('week-plan-generate').addEventListener('click', async () => {
    const btn = document.getElementById('week-plan-generate');
    const plan = await getCurrentPlan();
    if (!plan) return;
    btn.disabled = true; btn.textContent = 'Generating\u2026';
    clearPlanStatusLog();
    try {
      // Every input is read LIVE, falling back to the old plan's snapshot only
      // where nothing has been saved. That ordering is the point: if the knee
      // has healed and the note has been deleted — or a new one added — this
      // week's plan must reflect what the form says today, not what was true
      // when last week's plan happened to be generated.
      await generatePlanWithAI({
        goal: (await getSetting('planGoal', '')) || plan.goal,
        daysPerWeek: await getSetting('planDaysPerWeek', plan.daysPerWeek || 4),
        equipment: (await getSetting('planEquipment', null)) ?? (plan.equipment || ''),
        notes: (await getSetting('planNotes', null)) ?? (plan.notes || ''),
        repRangeMin: Number(await getSetting('planRepMin', 0)) || plan.repRangeMin || 8,
        repRangeMax: Number(await getSetting('planRepMax', 0)) || plan.repRangeMax || 12,
        splitType: await getSetting('planSplitType', 'auto'),
        fixedSets: Number(await getSetting('planFixedSets', 0)) || plan.fixedSets || null
      });
      // A fresh plan for this week makes any dismissal moot; clearing it stops
      // a stale value lingering into next week's comparison.
      await clearSetting('planWeekDismissed');
      await populateExerciseSelect();
      await renderExerciseManager();
      selectedLogDayIdx = null; // a new plan just replaced the old one \u2014 reset the Log tab's day pick
      await refreshPlanTab();
      toast('This week\u2019s plan is ready');
    } catch (err) {
      logPlanStatus(`Failed: ${err.message}`);
      const errBox = document.getElementById('plan-error');
      errBox.textContent = err.message;
      errBox.style.display = 'block';
      toast(err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Generate this week\u2019s plan';
    }
  });

  // Delegated actions for #plan-day-overview. Named 'plan-swap-*' rather
  // than reusing the Workout tab's 'swap-*' names: same shape (a picker
  // toggled open, then a select that commits it), but this one edits the
  // PLAN record permanently \u2014 see updatePlanDayExercise() \u2014 while the
  // Workout tab's swap-select is scoped to today only. Different registries
  // on different containers wouldn't collide either way, but distinct names
  // make that permanence obvious at the call site.
  const PLAN_DAY_CLICK_ACTIONS = {
    'plan-swap-open': async (el) => {
      const group = el.closest('.exercise-group');
      if (!group) return;
      const picker = group.querySelector('.swap-picker');
      if (!picker) return;
      await ensureSwapOptions(picker.querySelector('.swap-select'), Number(group.dataset.exid));
      picker.style.display = picker.style.display === 'block' ? 'none' : 'block';
    },
  };
  const PLAN_DAY_CHANGE_ACTIONS = {
    'plan-swap-select': async (el) => {
      const group = el.closest('.exercise-group');
      if (!group) return;
      const oldExerciseId = Number(group.dataset.exid);
      const newExerciseId = Number(el.value);
      if (newExerciseId === oldExerciseId) return;
      const planId = Number(el.dataset.planid);
      const dayIdx = Number(el.dataset.dayidx);
      // Everything here is re-read from the store rather than trusted from
      // the DOM, so any of it can be gone by the time the change fires --
      // the plan regenerated in another tab, the day removed, the exercise
      // deleted. Unguarded, that threw inside a forEach and took the rest
      // of the render with it.
      const currentPlan = await getRecord('plans', planId);
      const day = currentPlan && currentPlan.days && currentPlan.days[dayIdx];
      if (!day) return;
      const exIndex = day.exercises.findIndex(e => e.exerciseId === oldExerciseId);
      if (exIndex === -1) return;
      const newEx = await getRecord('exercises', newExerciseId);
      if (!newEx) return;
      await updatePlanDayExercise(planId, dayIdx, exIndex, { exerciseId: newExerciseId, name: newEx.name });
      await refreshPlanTab();
    },
  };

  // Read-only-ish structural view of the plan: each day's exercises with
  // their prescribed sets/reps, plus a PERMANENT swap (writes to the plan
  // record itself). No logging happens here \u2014 see the Log tab's active
  // workout for that; this tab is for shaping the plan, not doing it.
  async function renderPlanDayOverview(plan) {
    const container = document.getElementById('plan-day-overview');
    // Each day gets its set count and the time that implies at the lifter's
    // measured pace. Without this the session-length setting is unverifiable:
    // it's an instruction in a prompt, and models don't always follow
    // instructions. Showing the arithmetic makes an over-long day obvious
    // instead of something you discover in the gym at minute 75.
    const pace = await sessionPace();
    const targetMinutes = Number(await getSetting('sessionMinutes', 0)) || 0;
    // The exercise catalog may have changed since the last paint (an import, a
    // muscle reassignment, a new dislike), so the shared option list is
    // rebuilt at most once for this render rather than reused across renders.
    invalidateSwapOptions();
    const blocks = [];
    for (let dayIdx = 0; dayIdx < plan.days.length; dayIdx++) {
      const day = plan.days[dayIdx];
      // One model for the day AND its parts, so the per-exercise lines add up
      // to the day total instead of being computed a second, different way.
      const estimate = estimateSessionMinutes(day.exercises, pace);
      const exRows = [];
      day.exercises.forEach((ex, exIdx) => {
        exRows.push(`
          <div class="exercise-group" data-exid="${ex.exerciseId}">
            <div class="ex-name">
              <span>${esc(ex.name)}</span>
              <button type="button" class="swap-btn" data-action="plan-swap-open">Swap</button>
            </div>
            <div class="swap-picker">
              <select class="swap-select" data-action="plan-swap-select" data-planid="${plan.id}" data-dayidx="${dayIdx}" aria-label="Replace ${esc(ex.name)}"></select>
            </div>
            <div class="meta-row">${ex.targetSets} sets \u00d7 ${ex.repRangeMin}-${ex.repRangeMax} reps \u00b7 ~${Math.round(estimate.perExercise[exIdx].minutes)} min <span class="setup-note" title="Includes about ${Math.round(pace.minutesPerSetup)} min to reach the station, set it up and warm up">incl. setup</span></div>
          </div>
        `);
      });
      const daySets = day.exercises.reduce((a, ex) => a + (Number(ex.targetSets) || 0), 0);
      const dayMinutes = Math.round(estimate.total);
      // Only called "over" against a target the user actually set, and only
      // past a 10% margin — a 63-minute day against a 60-minute target is
      // not worth flagging.
      const over = targetMinutes > 0 && dayMinutes > targetMinutes * 1.1;
      blocks.push(`
        <div class="day-block">
          <div class="day-date">${esc(day.name)}</div>
          <div class="meta-row day-load${over ? ' over' : ''}">${daySets} working sets \u00b7 about ${dayMinutes} min${over ? ` \u2014 over your ${targetMinutes} min target` : ''}</div>
          <div class="meta-row day-breakdown">${Math.round(pace.fixedMinutes)} min getting started \u00b7 ${day.exercises.length} \u00d7 ~${Math.round(pace.minutesPerSetup)} min setup \u00b7 ${daySets} \u00d7 ~${Math.round(pace.minutesPerSet * 60)}s per set</div>
          ${exRows.join('')}
        </div>
      `);
    }
    container.innerHTML = blocks.join('');

    delegate(container, 'click', PLAN_DAY_CLICK_ACTIONS);
    delegate(container, 'change', PLAN_DAY_CHANGE_ACTIONS);
  }

  // Edits the plan itself (permanent, unlike the session-only swap/overrides
  // used in the Log tab's active workout) — used by the Plan tab's Swap
  // picker above.
  async function updatePlanDayExercise(planId, dayIndex, exIndex, updates) {
    const plan = await getRecord('plans', planId);
    if (!plan) return null;
    const ex = plan.days[dayIndex].exercises[exIndex];
    if (!ex) return null;
    Object.assign(ex, updates);
    await putRecord('plans', plan);
    return plan;
  }

  // The free-text box is only meaningful for the 'custom' choice, so it stays
  // out of the way otherwise. Its VALUE is left alone either way: switching to
  // a preset and back shouldn't lose what was typed.
  function refreshSplitCustomVisibility() {
    const sel = document.getElementById('setting-plan-split');
    const field = document.getElementById('split-custom-field');
    if (!sel || !field) return;
    field.style.display = sel.value === 'custom' ? '' : 'none';
    // scrollHeight reads 0 on a display:none element, so the init()-time
    // auto-grow pass over this textarea (12-init.js) was a no-op while this
    // field started out hidden — a saved multi-line value would otherwise
    // stay clipped to the CSS default height until the next keystroke.
    if (sel.value === 'custom') {
      const textarea = document.getElementById('setting-plan-split-custom');
      if (textarea) autoGrowTextarea(textarea);
    }
  }
  document.getElementById('setting-plan-split').addEventListener('change', async (e) => {
    refreshSplitCustomVisibility();
    await setSetting('planSplitType', e.target.value);
    await renderWeekProgress();
  });

  const SPLIT_LABELS = {
    full_body: 'Full Body — hit all major muscle groups every session',
    upper_lower: 'Upper / Lower split',
    push_pull_legs: 'Push / Pull / Legs split',
    bro_split: 'Bro split — one primary muscle group per day',
    ppl_upper_lower: 'Push/Pull/Legs + Upper/Lower hybrid'
  };

  // Shared by every entry point that can reach generatePlanWithAI() — the
  // weekly-regeneration banner's button and the plan form's Generate button
  // each disable only themselves, so without this a quick double-tap across
  // both fires two independent OpenRouter requests (double billing), each
  // saves its own plan record, and one call's clearPlanStatusLog() wipes the
  // other's in-progress status log out from under it. A single module-level
  // flag makes the second call fail loudly instead of duplicating the spend.
  let planGenerationInFlight = false;

  async function generatePlanWithAI({ goal, daysPerWeek, equipment, notes, repRangeMin, repRangeMax, splitType, fixedSets }) {
    if (planGenerationInFlight) {
      throw new Error('A plan is already being generated — wait for it to finish before starting another.');
    }
    planGenerationInFlight = true;
    try {
    logPlanStatus('Checking OpenRouter settings…');
    const apiKey = await getSetting('openrouterKey', '');
    const model = await getSetting('openrouterModel', '');
    if (!apiKey) throw new Error('Add your OpenRouter API key in Settings first.');
    if (!model) throw new Error('Enter a model name in Settings first (see openrouter.ai/models).');
    // Never render any part of the key itself — length is enough to confirm
    // "yes, something is saved" without leaving characters on screen that a
    // screenshot or shoulder-surf could piece together with other leaks.
    logPlanStatus(`Key present (${apiKey.length} chars). Model: ${model}`);

    const allExercises = await getAllRecords('exercises');
    const prefs = await getAllRecords('exercisePrefs');
    const dislikedIds = new Set(prefs.filter(p => p.disliked).map(p => p.exerciseId));
    const likedIds = new Set(prefs.filter(p => p.liked).map(p => p.exerciseId));
    const pinnedIds = new Set(prefs.filter(p => p.pinned).map(p => p.exerciseId));

    const availableExercises = allExercises.filter(e => !dislikedIds.has(e.id));
    const exerciseListText = availableExercises.map(e => e.name).sort().join(', ');
    if (dislikedIds.size > 0) logPlanStatus(`Excluding ${dislikedIds.size} disliked exercise(s) from what the AI can choose.`);

    // Pinned: always required, every generation. Liked: each one independently
    // gets a 50/50 chance of being required THIS generation — enough to bias
    // toward exercises the user likes over time without pinning them in place
    // permanently (that's what pinning itself is for), so plans still vary.
    const pinnedExercises = availableExercises.filter(e => pinnedIds.has(e.id));
    const likedExercises = availableExercises.filter(e => likedIds.has(e.id) && !pinnedIds.has(e.id));
    const requiredLiked = likedExercises.filter(() => Math.random() < 0.5);

    const musclesById = Object.fromEntries(MUSCLES.map(m => [m.id, m]));
    const pinnedInstruction = pinnedExercises.length
      ? `\nThe user has pinned these exercises — you MUST include every single one of them somewhere in the plan, each placed on a day that trains its primary muscle group:\n${pinnedExercises.map(e => `${e.name} (${(musclesById[e.primaryMuscle] || {}).name || e.primaryMuscle})`).join(', ')}\n`
      : '';
    const requiredLikedInstruction = requiredLiked.length
      ? `\nThe user especially likes these exercises — treat them as REQUIRED, include them in the plan wherever they fit the day's muscle groups and equipment: ${requiredLiked.map(e => e.name).join(', ')}.\n`
      : '';
    if (pinnedExercises.length > 0) logPlanStatus(`Requiring ${pinnedExercises.length} pinned exercise(s).`);
    if (likedExercises.length > 0) logPlanStatus(`${requiredLiked.length}/${likedExercises.length} liked exercise(s) required this time (50/50 per exercise).`);

    // A blank custom description is treated as 'auto' rather than emitting
    // "Structure the split as: ." — an empty directive is worse than none.
    const customSplit = (await getSetting('planSplitCustom', '')).trim();
    // Resolves to '' for 'auto' AND for a custom choice left blank, so both
    // fall through to letting the model decide. One empty-string test rather
    // than two special cases.
    const splitText = !splitType || splitType === 'auto' ? ''
      : splitType === 'custom' ? customSplit
      : (SPLIT_LABELS[splitType] || splitType);
    const splitInstruction = splitText
      ? `Structure the split as: ${splitText}.`
      : `Choose whatever day structure/split best fits the goal and days per week.`;

    const existingPlans = await getAllRecords('plans');
    const previousPlan = existingPlans.length ? existingPlans.sort((a, b) => b.createdAt - a.createdAt)[0] : null;
    const previousPlanText = previousPlan
      ? previousPlan.days.map(d => `${d.name}: ${d.exercises.map(e => e.name).join(', ')}`).join('\n')
      : '';
    const previousPlanInstruction = previousPlanText
      ? `\nHere is the user's previous plan. Give them something different this time — vary the exercise selection, ordering, and/or day structure where reasonable, rather than reproducing it, while still following the constraints above:\n${previousPlanText}\n`
      : '';
    logPlanStatus(previousPlan
      ? `Including previous plan (${previousPlan.days.length} days, generated ${new Date(previousPlan.createdAt).toLocaleDateString()}) to steer toward variety.`
      : 'No previous plan found — first-time generation.');
    const schemaExample = '{"days":[{"name":"Day 1 - Push","exercises":[{"name":"Barbell Bench Press","targetSets":4,"repRangeMin":6,"repRangeMax":10}]}]}';
    // A fixed set count removes one of the model's two levers for hitting the
    // session budget, so the remaining one has to be named explicitly or it
    // will hold the exercise count and overshoot.
    const setsInstruction = fixedSets
      ? `Use exactly ${fixedSets} working sets for EVERY exercise \u2014 do not vary it. Adjust the number of exercises per day to control session length instead.`
      : `Vary targetSets by exercise as appropriate \u2014 typically more on heavy compounds than on isolation work.`;
    const experience = await getSetting('experienceLevel', 'intermediate');
    const sex = await getSetting('sex', 'unspecified');
    const profileInstruction = `Lifter: ${experience} (${{ novice: 'can still add load nearly every session', intermediate: 'adds load about weekly; session-to-session progress has stalled', advanced: 'adds load monthly at best; progress comes in blocks' }[experience] || 'experience unstated'})`
      + (sex === 'unspecified' ? '.' : `, ${sex}.`);

    // Both numbers go in. The minutes are the user's real constraint; the set
    // budget is the only half a model can actually check itself against,
    // since it can't know how long anyone rests. Derived from this lifter's
    // measured pace, so it's their sets-per-hour, not a generic assumption.
    const budget = await sessionSetBudget();
    const lengthInstruction = budget
      ? `Each session must fit roughly ${budget.minutes} minutes, which for this lifter is about ${budget.sets} working sets per day (${(Math.round(budget.minutesPerSet * 100) / 100).toFixed(2)} min per set${budget.measured ? ', measured from their logged sessions' : ', estimated'}). Keep the total of all targetSets on each day close to ${budget.sets} — prefer fewer exercises done properly over cramming the day.\n`
      : '';

    // Logged here, after every value it mentions exists. "Built prompt" was
    // previously reported ~20 lines earlier, which was both a TDZ error
    // (`budget` is declared below) and a lie about what had happened yet.
    // The split is reported as TEXT rather than as its key: "custom" tells
    // the user nothing, and this log exists so they can see what was asked.
    logPlanStatus(`Built prompt (${allExercises.length} exercises in library, rep range ${repRangeMin}-${repRangeMax}, sets: ${fixedSets ? `fixed at ${fixedSets}` : 'AI chooses'}, split: ${splitText || 'AI chooses'}${budget ? `, ~${budget.minutes}min / ~${budget.sets} sets per day` : ''}).`);

    const prompt = `Design a ${daysPerWeek}-day-per-week weight training split for the goal: ${goal}.
${splitInstruction}
${profileInstruction}
${lengthInstruction}Available equipment: ${equipment || 'standard commercial gym'}.
Notes/constraints: ${notes || 'none'}.
Target rep range for working sets: ${repRangeMin}-${repRangeMax} reps, unless the goal clearly calls for a different range on a specific exercise (e.g. heavier, lower-rep compound work for a Strength goal).
${setsInstruction}
You MUST choose exercises exclusively from this existing exercise list — use the exact names as written, do not invent new ones:
${exerciseListText}
${pinnedInstruction}${requiredLikedInstruction}${previousPlanInstruction}For each exercise give a target number of sets and a rep range appropriate for the goal.
Respond with ONLY valid JSON, no markdown fences, no commentary, exactly matching this shape:
${schemaExample}`;

    const content = await aiChat({
      apiKey, model,
      system: 'You are a strength training coach. You respond only with valid JSON, never markdown or prose.',
      user: prompt
    });
    let parsed;
    try { parsed = JSON.parse(content); }
    catch (e) {
      logPlanStatus(`Raw response (unparsable): ${content.slice(0, 300)}`);
      throw new Error('Could not parse the AI response as JSON \u2014 try again.');
    }
    if (!parsed.days || !Array.isArray(parsed.days)) throw new Error('AI response was missing the expected "days" list.');
    logPlanStatus(`Got ${parsed.days.length} day(s) back. Matching exercises against your library\u2026`);

    const byName = new Map(allExercises.map(e => [nameKey(e.name), e]));
    // Exercise records created below for names the library didn't already
    // have. Tracked so that if anything past this point fails — a later day
    // with a bad shape, a storage error saving the plan — those brand new
    // "custom" records can be rolled back instead of left as orphans:
    // permanent rows nothing references, because the plan that would have
    // pointed at them never got saved.
    const createdExerciseIds = [];

    // Declared out here rather than inside the rollback block below: the
    // post-save steps (starting-weight estimates, the return) still need to
    // see the plan once that block has closed.
    let plan;

    try {
    for (const day of parsed.days) {
      // `parsed.days` being an array was checked above; the days INSIDE it are
      // still model output. A day that came back without an exercise list used
      // to throw a raw "day.exercises is not iterable" out of this loop, past
      // every friendly message this function is otherwise careful to produce.
      if (!Array.isArray(day.exercises)) {
        throw new Error(`The model returned a day ("${day.name || 'unnamed'}") with no exercise list — try again.`);
      }
      for (const ex of day.exercises) {
        const key = nameKey(ex.name);
        let match = byName.get(key);
        if (!match) {
          const newId = await addRecord('exercises', { name: ex.name, primaryMuscle: 'unclassified', secondaryMuscles: [], equipment: classifyEquipmentFromName(ex.name), custom: true });
          match = { id: newId, name: ex.name, primaryMuscle: 'unclassified' };
          byName.set(key, match);
          createdExerciseIds.push(newId);
        }
        ex.exerciseId = match.id;
      }
    }

    plan = {
      createdAt: Date.now(),
      goal, daysPerWeek, equipment, notes,
      // The inputs this plan was generated from, kept on the record so the
      // start-of-week prompt can regenerate in ONE tap instead of making the
      // user re-fill a form they already filled. Only these travel: split type
      // and days-per-week are global settings and are deliberately read live at
      // regeneration time, so changing them takes effect on the next week.
      repRangeMin, repRangeMax, fixedSets: fixedSets || null,
      days: parsed.days.map(d => ({
        name: d.name,
        exercises: d.exercises.map(e => {
          // Model output is untrusted input. `|| 3` alone turns 0 into 3 but
          // passes -1 through, and `slice(0, -1)` in the progression check
          // then silently drops the last set of every session. Clamp to a
          // sane positive integer, and un-invert a backwards rep range rather
          // than letting repRangeMax sit below repRangeMin.
          const sets = fixedSets || Math.max(1, Math.min(20, Math.round(Number(e.targetSets)) || 3));
          let lo = Math.max(1, Math.round(Number(e.repRangeMin)) || repRangeMin);
          let hi = Math.max(1, Math.round(Number(e.repRangeMax)) || repRangeMax);
          if (lo > hi) [lo, hi] = [hi, lo];
          return { exerciseId: e.exerciseId, name: e.name, targetSets: sets, repRangeMin: lo, repRangeMax: hi };
        })
        // ONE SLOT PER EXERCISE PER DAY.
        //
        // A model naming the same movement twice in a day (directly, or via
        // two names that resolve to one record through nameKey) produced two
        // rows sharing a data-exid, and the whole Log tab addresses today's
        // sets by exercise id: both rows then showed the same logged sets, one
        // "Log" tap ticked both off, and the Plan tab's permanent Swap edited
        // whichever slot findIndex hit first while silently leaving the other.
        // Nothing downstream can tell the two apart, so the duplicate is
        // dropped here — keeping the first, which is where the model put the
        // exercise it actually meant to prioritise.
        .filter((e, i, arr) => arr.findIndex(o => o.exerciseId === e.exerciseId) === i)
      }))
    };
    const dropped = parsed.days.reduce((a, d) => a + d.exercises.length, 0)
      - plan.days.reduce((a, d) => a + d.exercises.length, 0);
    if (dropped > 0) logPlanStatus(`Dropped ${dropped} duplicate exercise slot(s) the model repeated within a day.`);
    await addRecord('plans', plan);
    logPlanStatus('Plan saved.');
    } catch (err) {
      // Roll back any brand-new exercise records created above before the
      // plan itself made it to disk — best-effort; the original error is
      // what the caller needs to see either way.
      for (const id of createdExerciseIds) {
        try { await deleteRecord('exercises', id); } catch (e) { /* ignore */ }
      }
      throw err;
    }

    // Second pass, and deliberately after the plan is safely stored: a failure
    // here must cost you a nicety, never the plan you just paid for.
    try {
      await estimateStartingWeightsWithAI(plan, { apiKey, model });
    } catch (err) {
      logPlanStatus(`Starting-weight estimates unavailable (${err.message}). The built-in estimator will fill these in instead.`);
    }
    return plan;
    } finally {
      planGenerationInFlight = false;
    }
  }

  // =========================================================================
  // AI starting weights for lifts with no history — the second step.
  //
  // WHY A SECOND CALL AND NOT A BIGGER FIRST ONE. The plan request already
  // carries the whole exercise library and a pile of constraints, and models
  // reliably drop instructions as prompts grow. More importantly the two
  // questions want different inputs: choosing exercises needs the catalog,
  // while guessing a load needs YOUR NUMBERS. Keeping them apart lets the
  // second prompt be short and almost entirely made of your recent top sets.
  //
  // WHY THE AI IS BETTER AT THIS THAN THE HEURISTIC. estimateStartingWeight()
  // reasons from equipment class, because that is the only load-scale signal
  // in the data model. A model knows the actual relationships — that an
  // incline press runs about 80% of a flat press, that a lateral raise is a
  // fraction of an overhead press, that a hip thrust outweighs almost
  // everything — which is exactly the knowledge the taxonomy does not encode
  // and cannot be made to encode without hand-writing a ratio table for every
  // pair of exercises.
  //
  // WHY THE HEURISTIC STAYS. This path is unavailable more often than it is
  // available: no API key, offline, a swap made mid-session, an exercise
  // added by hand, a model that returns nonsense. The heuristic is the floor
  // that always works, and it is also the sanity bound below — an AI number
  // is rejected, never clamped, when it fails the check, because a silently
  // corrected number is a number nobody can debug.
  // =========================================================================
  async function estimateStartingWeightsWithAI(plan, { apiKey, model }) {
    const workouts = await getAllWorkouts();
    const exercises = await getAllRecords('exercises');
    const exercisesById = Object.fromEntries(exercises.map(e => [e.id, e]));

    // Only lifts with genuinely nothing logged, and only those in this plan.
    const logged = new Set();
    for (const w of workouts) for (const ex of w.exercises) if (ex.sets.length) logged.add(ex.exerciseId);

    const needed = [];
    const seen = new Set();
    for (const day of plan.days) {
      for (const ex of day.exercises) {
        if (logged.has(ex.exerciseId) || seen.has(ex.exerciseId)) continue;
        const rec = exercisesById[ex.exerciseId];
        if (!rec) continue;
        // Bodyweight movements already have a correct answer (you), so there
        // is nothing to ask about.
        if (exerciseEquipment(rec) === 'bodyweight') continue;
        seen.add(ex.exerciseId);
        needed.push({ rec, repRangeMin: ex.repRangeMin, repRangeMax: ex.repRangeMax });
      }
    }
    if (!needed.length) { logPlanStatus('Every exercise in this plan already has history — no starting weights needed.'); return; }

    // The anchors: what the lifter has actually done recently. Without these
    // the model is guessing at a stranger's strength, which is worse than the
    // heuristic rather than better.
    const recent = recentTopSetByExercise(workouts, null);
    const anchors = [...recent.entries()]
      .map(([id, r]) => ({ rec: exercisesById[id], ...r }))
      .filter(a => a.rec)
      .sort((a, b) => (b.date > a.date ? 1 : -1))
      .slice(0, 60);
    if (!anchors.length) { logPlanStatus('No logged history yet to estimate starting weights from — skipping.'); return; }

    const musclesById = Object.fromEntries(MUSCLES.map(m => [m.id, m]));
    const describe = (rec) => `${rec.name} (${(musclesById[rec.primaryMuscle] || {}).name || rec.primaryMuscle}, ${exerciseEquipment(rec)})`;
    const bw = bodyweightKg > 0 ? `Bodyweight: ${Math.round(bodyweightKg)}kg.` : 'Bodyweight: not given.';
    const experience = await getSetting('experienceLevel', 'intermediate');

    logPlanStatus(`Estimating starting weights for ${needed.length} new exercise(s) from ${anchors.length} logged lift(s)…`);

    const prompt = `This lifter is ${experience}. ${bw} All weights are KILOGRAMS.

Their most recent top set on each exercise they have actually trained:
${anchors.map(a => `${describe(a.rec)}: ${Math.round(a.weight * 100) / 100}kg`).join('\n')}

They are about to start these exercises for the FIRST time:
${needed.map(n => `${describe(n.rec)} — target ${n.repRangeMin}-${n.repRangeMax} reps`).join('\n')}

For each one, estimate a sensible working weight for their FIRST session, in kilograms, based on the strength they have demonstrated above and the normal strength relationships between these movements.

Rules:
- Err on the LIGHT side. A first set that is too light costs nothing; too heavy on an unfamiliar movement risks injury.
- Give the weight the way this app logs it: for dumbbell exercises, match how their existing dumbbell entries above are expressed.
- For assisted machines (assisted pull-up/dip), give a NEGATIVE number: the amount of assistance.
- Use 0 only if the movement is genuinely unloaded.
- Every name must be copied EXACTLY from the list above.

Respond with ONLY valid JSON, no markdown, exactly:
{"estimates":[{"name":"Exercise Name","weightKg":42.5}]}`;

    const raw = await aiChat({
      apiKey, model,
      system: 'You are a strength coach estimating starting loads. You respond only with valid JSON, never markdown or prose.',
      user: prompt,
      // Short answer. Kept small so a reasoning model can't spend a fortune
      // on what is explicitly a nice-to-have.
      maxTokens: 2000
    });

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error('the estimate response was not valid JSON'); }
    if (!parsed || !Array.isArray(parsed.estimates)) throw new Error('the estimate response had no "estimates" list');

    // SANITY BOUND. Model output is untrusted, and a 500kg lateral raise
    // prefilled into a weight box is worse than an empty one. A first attempt
    // at an unfamiliar lift has no business exceeding the heaviest thing the
    // lifter has ever logged, so that — with a little headroom — is the
    // ceiling. Anything outside it is DROPPED, not clamped: the heuristic
    // then fills the gap and the log says which ones were rejected.
    const heaviest = anchors.reduce((m, a) => Math.max(m, a.weight), 0);
    const ceiling = heaviest > 0 ? heaviest * 1.25 : 0;

    const byKey = new Map(needed.map(n => [nameKey(n.rec.name), n.rec]));
    let applied = 0;
    const rejected = [];
    for (const est of parsed.estimates) {
      const rec = byKey.get(nameKey(est && est.name));
      if (!rec) continue;
      const kg = Number(est.weightKg);
      if (!isFinite(kg)) { rejected.push(`${rec.name}: not a number`); continue; }
      const equip = exerciseEquipment(rec);
      if (equip === 'assisted') {
        // Assistance, so it must be negative and not absurdly large.
        if (kg >= 0 || Math.abs(kg) > (bodyweightKg > 0 ? bodyweightKg * 1.2 : 200)) {
          rejected.push(`${rec.name}: ${kg}kg is not a plausible assistance value`); continue;
        }
      } else if (kg < 0) {
        rejected.push(`${rec.name}: negative weight on a non-assisted lift`); continue;
      } else if (ceiling > 0 && kg > ceiling) {
        rejected.push(`${rec.name}: ${kg}kg exceeds ${Math.round(ceiling)}kg (1.25x your heaviest logged set)`); continue;
      }
      // Snap to something the equipment can actually be loaded to.
      const step = loadStepKg(rec);
      const rounded = kg === 0 ? 0 : Math.sign(kg) * Math.max(step, Math.round(Math.abs(kg) / step) * step);
      await putRecord('exercises', { ...rec, startingWeightKg: rounded, startingWeightSource: 'ai' });
      applied++;
    }
    rejected.forEach(r => logPlanStatus(`Rejected estimate — ${r}`));
    logPlanStatus(`Applied ${applied} starting-weight estimate(s)${rejected.length ? `, rejected ${rejected.length}` : ''}.`);
  }

  // =========================================================================
  // The plan form remembers itself.
  //
  // Goal, equipment and especially NOTES describe the lifter rather than one
  // request. An injury is not a per-generation fact — "bad left shoulder,
  // avoid overhead pressing" is true this week and next — so a form that
  // emptied itself after every generation meant retyping the same constraint
  // every Monday, and forgetting to meant the AI silently stopped avoiding it.
  //
  // Saved on `change` (i.e. on blur, if the value actually changed), which is
  // the same pattern the OpenRouter key uses and for the same reason: the
  // value must be safe by the time you tap Generate, not only if you
  // remembered to press a Save button first.
  // =========================================================================
  const PLAN_FORM_FIELDS = [
    ['plan-goal', 'planGoal'],
    ['plan-rep-min', 'planRepMin'],
    ['plan-rep-max', 'planRepMax'],
    ['plan-set-count', 'planFixedSets'],
    ['plan-equipment', 'planEquipment'],
    ['plan-notes', 'planNotes']
  ];
  PLAN_FORM_FIELDS.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => setSetting(key, el.value));
  });

  async function loadPlanFormFromSettings() {
    for (const [id, key] of PLAN_FORM_FIELDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      // Falls back to whatever the markup already had, so a first run keeps
      // its sensible defaults instead of blanking every field.
      const stored = await getSetting(key, null);
      if (stored != null && stored !== '') el.value = stored;
    }
  }

  document.getElementById('plan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Submitting this form only happens with the disclosure open and the
    // user looking right at it — the refreshPlanTab() a successful
    // generation triggers must not slam it shut out from under them the
    // instant a plan now exists. Treated the same as an explicit toggle.
    planFormUserOpened = true;
    const goal = document.getElementById('plan-goal').value;
    const daysPerWeek = await getSetting('planDaysPerWeek', 4);
    const splitType = await getSetting('planSplitType', 'auto');
    const repRangeMin = Number(document.getElementById('plan-rep-min').value) || 8;
    const repRangeMax = Number(document.getElementById('plan-rep-max').value) || 12;
    const fixedSets = Number(document.getElementById('plan-set-count').value) || null;
    const equipment = document.getElementById('plan-equipment').value.trim();
    const notes = document.getElementById('plan-notes').value.trim();
    const btn = document.getElementById('plan-generate-btn');
    const errBox = document.getElementById('plan-error');
    errBox.style.display = 'none';
    clearPlanStatusLog();
    if (repRangeMin > repRangeMax) {
      errBox.textContent = 'Rep range min can\u2019t be greater than max.';
      errBox.style.display = 'block';
      return;
    }
    btn.disabled = true; btn.textContent = 'Generating\u2026';
    try {
      await generatePlanWithAI({ goal, daysPerWeek, equipment, notes, repRangeMin, repRangeMax, splitType, fixedSets });
      await populateExerciseSelect();
      await renderExerciseManager();
      selectedLogDayIdx = null; // a new plan just replaced the old one — reset the Log tab's day pick
      await refreshPlanTab();
      // NOT form.reset(). These inputs describe the lifter, not this one
      // request: equipment is wherever they train and notes are usually a
      // long-lived constraint — "bad left shoulder, avoid overhead pressing",
      // a knee that will still be a knee next week. Wiping them on every
      // successful generation meant retyping the same injury every Monday,
      // and anything not retyped was silently dropped from the next plan.
      // They are saved on edit (see the persistence block below) and reloaded
      // on start-up, so there is nothing here to clear.
      toast('New plan ready');
    } catch (err) {
      logPlanStatus(`Failed: ${err.message}`);
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'Generate Plan';
    }
  });
