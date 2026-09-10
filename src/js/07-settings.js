  // 07-settings.js — Settings forms, session time model (pace/budget), hints, loadSettingsIntoForm, increment grid
  // =========================================================================
  // Settings — every field here saves on `change` (blur, if the value
  // actually changed), the same on-blur pattern the OpenRouter key and the
  // Plan tab's generation form already used. There are no Save buttons: the
  // value has to be safe the moment you leave the field, not only if you
  // remembered to press one first, and a form with some fields live and
  // others waiting on a button made it impossible to tell which state was
  // actually in effect. The `<form>` elements stay (for layout/semantics);
  // their `submit` listeners only preventDefault so Enter in a number field
  // doesn't reload the page.
  // =========================================================================
  ['units-form', 'profile-form', 'workout-form', 'settings-form', 'plan-settings-form'].forEach(id => {
    const form = document.getElementById(id);
    if (form) form.addEventListener('submit', (e) => e.preventDefault());
  });

  document.getElementById('setting-apikey').addEventListener('change', async (e) => {
    await setSetting('openrouterKey', e.target.value.trim());
    await refreshApiKeyStatus();
  });
  document.getElementById('setting-model').addEventListener('change', async (e) => {
    await setSetting('openrouterModel', e.target.value.trim());
  });

  // Progression suggestions (Log and Plan tabs) and the pace/setup/session
  // hints all quote numbers derived from these settings, so any of them
  // changing has to repaint every place that shows one.
  async function afterProgressionSettingChange() {
    await refreshPaceHint();
    await refreshGymTypeHint();
    await refreshSetupHint();
    await refreshSessionLengthHint();
    refreshExperienceHint();
    await refreshLogAndHistory();
    await refreshPlanTab();
  }

  document.getElementById('setting-rest').addEventListener('change', async (e) => {
    // `Number(e.target.value) || 90` used to treat an explicitly-typed 0 —
    // legal per this field's own min="0" — as falsy and silently overwrite it
    // with the default, so "no rest" could never actually be saved. Validate
    // properly instead: any finite value within the field's own range (>= 0,
    // no upper bound) is accepted as typed; only blank/invalid input falls
    // back to 90. (The other numeric settings below use `|| 0` the same way,
    // but 0 is already THEIR fallback/sentinel for "unset", so they don't
    // share this bug — only restDefault has a non-zero default over a range
    // that legally includes zero.)
    const parsed = Number(e.target.value);
    const rest = e.target.value.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 ? parsed : 90;
    await setSetting('restDefault', rest);
    // Reflect a changed rest length on the idle clock straight away rather
    // than leaving the old value showing until the next reload.
    if (!timerInterval) { timerRemaining = rest; timerTotal = rest; updateTimerDisplay(); }
    await afterProgressionSettingChange();
  });
  document.getElementById('setting-rest-enabled').addEventListener('change', async (e) => {
    const restOn = e.target.checked;
    await setSetting('restTimerEnabled', restOn);
    if (!restOn) { pauseTimer(); hideTimerSheet(); }
  });
  document.getElementById('setting-rir-prompt').addEventListener('change', async (e) => {
    const rirOn = e.target.checked;
    await setSetting('rirPromptEnabled', rirOn);
    if (!rirOn) hideRirPrompt();
  });
  document.getElementById('setting-seconds-per-set').addEventListener('change', async (e) => {
    await setSetting('secondsPerSet', Number(e.target.value) || 0);
    await afterProgressionSettingChange();
  });
  document.getElementById('setting-exercise-setup').addEventListener('change', async (e) => {
    await setSetting('exerciseSetupSeconds', Number(e.target.value) || 0);
    await afterProgressionSettingChange();
  });
  document.getElementById('setting-session-minutes').addEventListener('change', async (e) => {
    await setSetting('sessionMinutes', Number(e.target.value) || 0);
    await afterProgressionSettingChange();
  });

  async function afterProfileSettingChange() {
    refreshExperienceHint();
    // Progression suggestions are rendered into the Log and Plan tabs, so a
    // changed experience level has to repaint them or the old numbers linger.
    await refreshLogAndHistory();
    await refreshPlanTab();
  }
  document.getElementById('setting-sex').addEventListener('change', async (e) => {
    await setSetting('sex', e.target.value);
    await afterProfileSettingChange();
  });
  document.getElementById('setting-age').addEventListener('change', async (e) => {
    await setSetting('age', Number(e.target.value) || 0);
    await afterProfileSettingChange();
  });
  document.getElementById('setting-bodyweight').addEventListener('change', async (e) => {
    bodyweightKg = toKg(Number(e.target.value) || 0);
    await setSetting('bodyweightKg', bodyweightKg);
    await afterProfileSettingChange();
  });
  document.getElementById('setting-energy').addEventListener('change', async (e) => {
    await setSetting('energyBalance', e.target.value);
    await afterProfileSettingChange();
  });

  // Spells out what the chosen experience level actually does, in the units
  // the user thinks in, rather than leaving "affects progression" as a claim
  // they have to take on faith.
  // SESSION LENGTH: asked in minutes, used as working sets.
  //
  // Minutes is what people actually have — an hour before work, not "five
  // exercises". But minutes is useless to a plan generator on its own,
  // because it can't be checked against anything: the same 60 minutes is 15
  // working sets at 3 minutes' rest or 30 at 45 seconds. Asking for a set or
  // exercise count instead would be checkable but would push the conversion
  // onto the user, who would have to guess at exactly the thing the app
  // already measures.
  //
  // So: the user gives minutes, and the app converts using THEIR OWN pace.
  // Sessions are already timed (startedAt/endedAt/durationMs), so
  // minutes-per-set is observable rather than assumed, and the derived set
  // budget is shown back so the arithmetic is inspectable instead of magic.
  //
  // Median, not mean: forgetting to hit Complete leaves one session recorded
  // at nine hours, and a mean would be wrecked by it forever. Sessions are
  // also filtered to a plausible band for the same reason.
  const SESSION_MIN_SAMPLES = 3;
  const EXERCISE_MIN_SAMPLES = 3;
  // Exercise changes are much rarer than sets — one day gives ~7 of them, not
  // ~24 — so this floor is lower than the set-interval one or the setup term
  // would sit on a default for months.
  const TRANSITION_MIN_SAMPLES = 5;
  // A long wait for a rack is a genuine part of a transition, so this cap is
  // far more generous than the one on rests between sets. Median does the rest.
  const TRANSITION_MAX_MIN = 20;
  // Defaults until measured. Both err toward the honest side of the previous
  // model, which assumed they were ZERO.
  //
  // Four minutes is not padding, it is the sum of the parts: walking to the
  // station (~30-60s), waiting if someone is on it (0-3 min in a commercial
  // gym at six o'clock), adjusting the seat or moving pins or stripping and
  // reloading a bar (~30-90s), and a warm-up set with its rest (~1-2 min) —
  // which is real time that never appears in a working-set count.
  //
  // Five minutes of fixed overhead covers arriving at the floor and a general
  // warm-up. Changing isn't in it: the clock starts when Start is pressed.
  const DEFAULT_SETUP_MINUTES = 4;
  const DEFAULT_OVERHEAD_MINUTES = 5;

  // WHERE YOU TRAIN, as a better cold-start prior for the setup term.
  //
  // This is not a separate variable competing with the measured one — it only
  // decides what `setup` is worth *before* there is enough history to measure
  // it, which is exactly the window in which the estimate is otherwise most
  // wrong. Once transitions have been observed the measurement wins and this
  // stops mattering, which is why it is a preset rather than a modifier.
  //
  // The obvious framing — "home is faster" — is wrong, and the numbers say so.
  // A commercial gym's cost is CONTENTION: waiting for a station at six
  // o'clock. A home gym has none of that, but if it is one barbell and one
  // adjustable bench then every exercise change is a real changeover — strip
  // and reload the bar, move the pins, convert the rack. So a combo home setup
  // lands nearer a commercial gym than it does a fully-equipped one, and only
  // a home gym with dedicated stations is genuinely quick.
  const GYM_SETUP_MINUTES = {
    commercial: 4,        // queueing at peak times is the dominant cost
    home_combo: 3.5,      // no queue, but a real changeover every time
    home_dedicated: 2     // walk over, sit down, go
  };
  const GYM_TYPE_NOTE = {
    commercial: 'sharing stations with other people, so some waiting at peak times',
    home_combo: 'nothing to queue for, but stripping and reloading a bar or reconfiguring a bench between exercises',
    home_dedicated: 'no queue and nothing to reconfigure — the fastest case'
  };

  function median(xs) {
    const a = xs.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // PER-EXERCISE PACE, measured rather than configured.
  //
  // A squat set and a lateral-raise set are not the same amount of time, so a
  // single global figure mis-estimates any day that leans one way. But asking
  // for a number per exercise means ~90 fields nobody will fill in, and it
  // breaks the moment someone adds a custom exercise — which is exactly the
  // case that has to keep working.
  //
  // Every logged set already carries a timestamp, so the gap between one set
  // and the next IS that set's real cost: execution, rest, and walking to the
  // next machine. Attribute each gap to the exercise of the EARLIER set and
  // there is a per-exercise measurement with nothing to configure.
  //
  // Only sessions with `startedAt` count. Imported Fitbod sets carry synthetic
  // timestamps spaced exactly 1s apart to preserve ordering, and those would
  // otherwise read as one-second sets and destroy the estimate.
  function collectPaceSamples(workouts) {
    const byExercise = new Map();
    const setGaps = [];         // set -> next set of the SAME exercise
    const transitionGaps = [];  // last set of one exercise -> first set of the next
    workouts.forEach(w => {
      if (!w.startedAt) return;
      const flat = [];
      w.exercises.forEach(ex => ex.sets.forEach(st => {
        if (typeof st.ts === 'number') flat.push({ ts: st.ts, exerciseId: ex.exerciseId });
      }));
      flat.sort((a, b) => a.ts - b.ts);
      for (let i = 0; i < flat.length - 1; i++) {
        const mins = (flat[i + 1].ts - flat[i].ts) / 60000;
        if (mins < 0.33) continue;                      // below 20s isn't a set
        // WITHIN an exercise vs BETWEEN two exercises are different costs and
        // were previously averaged into one number. Resting between two sets
        // of the same lift is the rest interval. Moving to the next lift is
        // the rest PLUS walking there, waiting for it to be free, changing the
        // pins or stripping and reloading a bar, and usually a warm-up set.
        // Lumping them together let the second cost be dragged down by the far
        // more numerous first, which is a large part of why the estimate came
        // out low.
        //
        // The caps differ for the same reason: a 12-minute wait for a squat
        // rack is a real transition, while a 12-minute gap between two sets of
        // curls is a phone call and says nothing about anything.
        if (flat[i].exerciseId === flat[i + 1].exerciseId) {
          if (mins > 10) continue;
          setGaps.push(mins);
          if (!byExercise.has(flat[i].exerciseId)) byExercise.set(flat[i].exerciseId, []);
          byExercise.get(flat[i].exerciseId).push(mins);
        } else {
          if (mins > TRANSITION_MAX_MIN) continue;
          transitionGaps.push(mins);
        }
      }
    });
    return { setGaps, transitionGaps, byExercise };
  }

  // What a session costs OUTSIDE its logged sets: arriving, a general warm-up,
  // the walk to the first station, racking up and leaving at the end. Directly
  // measurable as the difference between the timed session and the span from
  // its first logged set to its last, so it does not have to be guessed at
  // once Start/Complete has been used a few times.
  function sessionOverheadSamples(workouts) {
    const out = [];
    workouts.forEach(w => {
      // Auto-started sessions have startedAt == the first logged set's own
      // timestamp, so spanMin already reaches all the way back to the start
      // of the measured window — the "overhead" left over would only be the
      // tail after the last set, not the real arrive/warm-up/rack-up cost,
      // and would bias the fixed term low. collectPaceSamples still wants
      // these; only the overhead measurement excludes them.
      if (!w.startedAt || w.startedAuto || !w.durationMs || w.durationMs <= 0) return;
      const ts = w.exercises.flatMap(ex => ex.sets.map(s => s.ts)).filter(t => typeof t === 'number');
      if (ts.length < 2) return;
      const spanMin = (Math.max(...ts) - Math.min(...ts)) / 60000;
      const totalMin = w.durationMs / 60000;
      if (totalMin < 10 || totalMin > 240) return;      // forgot to press Complete
      const overhead = totalMin - spanMin;
      // Negative means sets were logged outside the Start/Complete window —
      // nothing useful. An hour of overhead is someone who left it running.
      if (overhead < 0 || overhead > 60) return;
      out.push(overhead);
    });
    return out;
  }

  // Global pace, used for the session budget and as the fallback for any
  // exercise without enough of its own history.
  // A SESSION IS NOT JUST ITS SETS.
  //
  //     minutes = fixed + exercises x setup + sets x perSet
  //
  // This used to be `sets x perSet` alone, and it was wrong in a way that got
  // worse the more exercises a day had. Eight exercises of three sets came out
  // at 48 minutes — 24 sets at the fallback two minutes each — against a real
  // session nearer ninety. The missing 40 minutes were never in the model at
  // all: no walking to the next station, no loading plates or moving pins, no
  // queueing for a rack, no warm-up sets (which are never logged as working
  // sets and so are invisible to a per-set count), and nothing for arriving or
  // leaving.
  //
  // Splitting the estimate into three terms fixes the shape of the error, not
  // just its size. A per-set-only model necessarily mis-prices any day whose
  // exercise count differs from the one it was calibrated on; this one prices
  // sets and stations separately, so a 3-exercise day and a 10-exercise day
  // with the same set count come out differently — as they should.
  //
  // Every term is MEASURED once there is history for it, and each falls back
  // independently, so partial data still improves the estimate.
  async function sessionPace(workouts) {
    const all = workouts || await getAllWorkouts();
    const { setGaps, transitionGaps, byExercise } = collectPaceSamples(all);
    const overheads = sessionOverheadSamples(all);

    // --- per set ---
    let minutesPerSet, setSource, measured;
    const setOverride = Number(getSettingSync('secondsPerSet', 0)) || 0;
    if (setOverride > 0) {
      minutesPerSet = setOverride / 60; setSource = 'set by you'; measured = true;
    } else if (setGaps.length >= 8) {
      minutesPerSet = median(setGaps); setSource = `${setGaps.length} set intervals`; measured = true;
    } else {
      const rest = getSettingSync('restDefault', 90);
      minutesPerSet = (Number(rest) + 30) / 60;
      setSource = 'estimated from your rest setting'; measured = false;
    }

    // --- per exercise (setup / move) ---
    let minutesPerSetup, setupSource;
    const setupOverride = Number(getSettingSync('exerciseSetupSeconds', 0)) || 0;
    if (setupOverride > 0) {
      minutesPerSetup = setupOverride / 60; setupSource = 'set by you';
    } else if (transitionGaps.length >= TRANSITION_MIN_SAMPLES) {
      minutesPerSetup = median(transitionGaps);
      setupSource = `${transitionGaps.length} exercise change${transitionGaps.length === 1 ? '' : 's'}`;
    } else {
      // Measurement beats the preset; the preset only fills the cold start.
      const gymType = getSettingSync('gymType', 'commercial');
      minutesPerSetup = GYM_SETUP_MINUTES[gymType] ?? DEFAULT_SETUP_MINUTES;
      setupSource = `where you train`;
    }

    // --- fixed session overhead ---
    let fixedMinutes, fixedSource;
    if (overheads.length >= SESSION_MIN_SAMPLES) {
      fixedMinutes = median(overheads);
      fixedSource = `${overheads.length} timed session${overheads.length === 1 ? '' : 's'}`;
    } else {
      fixedMinutes = DEFAULT_OVERHEAD_MINUTES; fixedSource = 'default';
    }

    return {
      minutesPerSet, minutesPerSetup, fixedMinutes,
      measured, source: setSource, setupSource, fixedSource,
      sampleSize: setGaps.length, transitionSamples: transitionGaps.length,
      overheadSamples: overheads.length, byExercise
    };
  }

  // The model in one place, so the Plan tab's day estimate and the plan
  // generator's set budget can never drift apart. `exercises` is
  // [{exerciseId, targetSets}].
  //
  // DELIBERATELY CARRIES A SMALL MARGIN, and it is worth being explicit about
  // where it comes from rather than discovering it later and "fixing" it.
  //
  // Measured gaps are gaps BETWEEN sets, so n sets of one exercise yield only
  // n-1 rests, and the walk to the first station is already inside the fixed
  // overhead. Charging every set a rest and every exercise a setup therefore
  // over-counts by about one rest per exercise plus one setup per session.
  // Reconstructing a logged session exactly would mean
  // `fixed + (exercises-1) x setup + (sets-exercises) x perSet`.
  //
  // That exact form is not what gets shipped, because the measurement it
  // reconstructs is itself blind to real time: waits longer than
  // TRANSITION_MAX_MIN are discarded, warm-up sets performed at the station
  // are never logged and so appear in no gap at all, and the final set plus
  // walking away falls outside the last interval. On the eight-exercise day
  // that prompted this, the exact form predicts 65 minutes and the form below
  // predicts 85, against a lifter's own estimate of about 90.
  //
  // So the margin is not slop, it is a stand-in for time that is genuinely
  // spent and structurally unmeasurable here — and erring long is the correct
  // direction twice over: an over-long estimate is visible and adjustable,
  // while an over-short one silently tells the plan generator to prescribe a
  // session that will not fit.
  function estimateSessionMinutes(exercises, pace) {
    const perExercise = exercises.map(ex => {
      const sets = Number(ex.targetSets) || 0;
      return { exerciseId: ex.exerciseId, minutes: pace.minutesPerSetup + sets * paceForExercise(pace, ex.exerciseId) };
    });
    const total = pace.fixedMinutes + perExercise.reduce((a, e) => a + e.minutes, 0);
    return { total, perExercise };
  }

  // Per-exercise where there's enough of it, global otherwise. The fallback is
  // the whole point: a custom exercise added five minutes ago has no history
  // and still has to produce a number.
  function paceForExercise(pace, exerciseId) {
    const samples = pace.byExercise && pace.byExercise.get(exerciseId);
    if (samples && samples.length >= EXERCISE_MIN_SAMPLES) return median(samples);
    return pace.minutesPerSet;
  }

  // Inverting the three-term model to answer "how many working sets fit in N
  // minutes?".
  //
  //     minutes = fixed + E x setup + S x perSet
  //
  // Two unknowns, one equation, so the exercise count has to be assumed —
  // taken as S / AVG_SETS_PER_EXERCISE, which is the shape of every plan this
  // app generates. Substituting:
  //
  //     S = (minutes - fixed) / (perSet + setup / AVG_SETS_PER_EXERCISE)
  //
  // This is the number the plan generator is told to hit, so the old per-set
  // model was not merely displaying an optimistic estimate: it was asking the
  // AI for a day that could not fit. A 45-minute target used to buy 23 working
  // sets and now buys about 13, which is why the generated days were running
  // an hour and a half.
  const AVG_SETS_PER_EXERCISE = 3;
  async function sessionSetBudget(workouts) {
    const minutes = Number(getSettingSync('sessionMinutes', 0)) || 0;
    if (!minutes) return null;
    const pace = await sessionPace(workouts);
    const perSetCost = pace.minutesPerSet + pace.minutesPerSetup / AVG_SETS_PER_EXERCISE;
    const usable = minutes - pace.fixedMinutes;
    // A target shorter than the fixed overhead still has to return something
    // trainable rather than zero or a negative.
    const sets = perSetCost > 0 ? Math.round(usable / perSetCost) : 0;
    return { minutes, sets: Math.max(4, sets), ...pace };
  }

  // States what the pace currently is and where it came from. Without this the
  // per-exercise estimates are unexplainable numbers on a screen. The
  // reasoning behind the fallback/override behavior lives in the "?" info
  // bubble next to this hint in page.html, not duplicated here.
  // Info-bubble markup is appended INSIDE the same innerHTML string, not as a
  // sibling element in page.html — the "?" has to sit on the very end of the
  // live sentence it explains, and a static sibling would either land on its
  // own line (details.info is display:inline, but that only pulls the "?"
  // onto the PRECEDING text's line, not a separate element's) or get out of
  // sync with whichever branch of the sentence below actually rendered.
  const PACE_INFO = '<details class="info"><summary aria-label="More about per-set time">?</summary><div class="info-text">Individual exercises get their own timing once each has enough logged set intervals; until then everything uses this one figure, and entering a value overrides all of it. This counts only the set itself and the rest after it — moving between exercises is priced separately, below.</div></details>';
  const GYM_TYPE_INFO = '<details class="info"><summary aria-label="More about gym type and setup time">?</summary><div class="info-text">Home isn\'t automatically faster: no queue, but one bar and one bench mean a real changeover every time — that\'s why the combo option sits close to a commercial gym, and only dedicated stations are properly quick.</div></details>';
  const SETUP_INFO = '<details class="info"><summary aria-label="More about setup time">?</summary><div class="info-text">Covers walking to the station, waiting for it, changing pins or reloading a bar, and the warm-up set you do there but never log. Order of precedence: a number typed here, then what your own logs show, then the gym-type setting above.</div></details>';
  const SESSION_LENGTH_INFO = '<details class="info"><summary aria-label="More about target session length">?</summary><div class="info-text">Given in minutes because that\'s the real constraint — the app converts it to a working-set budget using how long your own logged sessions actually take, then asks plan generation for roughly that many sets per day.</div></details>';

  async function refreshPaceHint() {
    const el = document.getElementById('pace-hint');
    if (!el) return;
    const pace = await sessionPace();
    const secs = Math.round(pace.minutesPerSet * 60);
    el.innerHTML = `Leave blank to measure this from your own logs — currently <strong>${secs}s per set</strong> (${esc(pace.source)}).${PACE_INFO}`;
  }

  async function refreshGymTypeHint() {
    const el = document.getElementById('gym-type-hint');
    if (!el) return;
    const gymType = document.getElementById('setting-gym-type').value;
    const mins = GYM_SETUP_MINUTES[gymType] ?? DEFAULT_SETUP_MINUTES;
    const pace = await sessionPace();
    const superseded = pace.setupSource !== 'where you train';
    el.innerHTML = `Starting guess for setup time between exercises — <strong>${Math.round(mins * 60)}s per exercise</strong>, about ${Math.round(mins * 8)} min across an 8-exercise day. `
      + (superseded
        ? `<strong>Not currently in use</strong> — ${esc(pace.setupSource)} is more specific and takes precedence.`
        : `Replaced automatically once ${TRANSITION_MIN_SAMPLES} exercise changes have been logged.`)
      + GYM_TYPE_INFO;
  }

  async function refreshSetupHint() {
    const el = document.getElementById('setup-hint');
    if (!el) return;
    const pace = await sessionPace();
    const secs = Math.round(pace.minutesPerSetup * 60);
    el.innerHTML = `Charged once per exercise, on top of the per-set time above — currently <strong>${secs}s</strong> (${esc(pace.setupSource)}).${SETUP_INFO}`;
  }

  async function refreshSessionLengthHint() {
    const el = document.getElementById('session-length-hint');
    if (!el) return;
    const budget = await sessionSetBudget();
    if (!budget) {
      el.innerHTML = `How long you actually have — left blank, plan generation makes no assumption about session length.${SESSION_LENGTH_INFO}`;
      return;
    }
    // The arithmetic is shown rather than asserted, because the answer got
    // materially smaller when setup time entered the model and a number that
    // drops by 40% without explanation reads as a bug.
    const perSet = Math.round(budget.minutesPerSet * 60);
    const setup = Math.round(budget.minutesPerSetup * 60);
    const fixed = Math.round(budget.fixedMinutes);
    const exercises = Math.max(1, Math.round(budget.sets / AVG_SETS_PER_EXERCISE));
    el.innerHTML = `Works out to about <strong>${budget.sets} working sets</strong> (~${exercises} exercises) — ${fixed} min getting started, ~${setup}s setup per exercise, ~${perSet}s per set.${SESSION_LENGTH_INFO}`;
  }

  function refreshBodyweightField() {
    const input = document.getElementById('setting-bodyweight');
    const unitEl = document.getElementById('bodyweight-unit');
    if (!input) return;
    if (unitEl) unitEl.textContent = weightUnit;
    input.placeholder = weightUnit === 'lb' ? 'e.g. 175' : 'e.g. 80';
    input.step = weightUnit === 'lb' ? 1 : 0.5;
    input.value = bodyweightKg ? Math.round(fromKg(bodyweightKg) * 10) / 10 : '';
  }

  // The "why percentages, not fixed jumps" reasoning is appended as a "?"
  // info bubble at the end of this same innerHTML string, not a sibling
  // element in page.html — it has to ride along with wherever this live
  // sentence actually ends up.
  const EXPERIENCE_PCT_INFO = '<details class="info"><summary aria-label="Why percentages instead of fixed jumps">?</summary><div class="info-text">Percentages rather than fixed plate jumps, because a small fixed jump is a much bigger percentage change on a light lift than a heavy one. When the percentage works out smaller than the smallest jump the equipment allows, you get that jump <em>less often</em> instead of a bigger one — so the average rate still lands on target, and age, nutrition phase and reported reps-in-reserve keep mattering at loads where rounding would otherwise erase them.</div></details>';
  function refreshExperienceHint() {
    const el = document.getElementById('experience-hint');
    if (!el) return;
    const level = document.getElementById('setting-experience').value;
    const pct = PROGRESSION_PCT[level] || PROGRESSION_PCT.intermediate;
    const needed = PROGRESSION_SESSIONS[level] || 1;
    el.innerHTML = `Currently: about <strong>${(pct.lower * 100).toFixed(1)}%</strong> on lower-body lifts and `
      + `<strong>${(pct.upper * 100).toFixed(1)}%</strong> on upper-body lifts, `
      + `after <strong>${needed} clean session${needed === 1 ? '' : 's'}</strong> in a row.${EXPERIENCE_PCT_INFO}`;
  }

  document.getElementById('setting-experience').addEventListener('change', async (e) => {
    await setSetting('experienceLevel', e.target.value);
    await afterProfileSettingChange();
  });
  // Live, like the experience hint: the whole point of naming the three cases
  // is being able to see what each is worth before committing to one.
  document.getElementById('setting-gym-type').addEventListener('change', async (e) => {
    await setSetting('gymType', e.target.value);
    await afterProgressionSettingChange();
  });
  // Recomputed on input rather than only on save: the whole point of showing
  // the derived set count is to let someone try 45 vs 60 minutes and see what
  // it costs before committing to either.
  document.getElementById('setting-session-minutes').addEventListener('input', async (e) => {
    const el = document.getElementById('session-length-hint');
    const minutes = Number(e.target.value) || 0;
    if (!minutes) { await refreshSessionLengthHint(); return; }
    const pace = await sessionPace();
    // Same three-term arithmetic as sessionSetBudget(). This preview used to
    // divide by minutesPerSet alone, so while you typed it promised a set
    // count the saved value would then contradict.
    const perSetCost = pace.minutesPerSet + pace.minutesPerSetup / AVG_SETS_PER_EXERCISE;
    const sets = Math.max(4, perSetCost > 0 ? Math.round((minutes - pace.fixedMinutes) / perSetCost) : 0);
    el.innerHTML = `Works out to about <strong>${sets} working sets</strong> — ${Math.round(pace.fixedMinutes)} min getting started, `
      + `~${Math.round(pace.minutesPerSetup * 60)}s setup per exercise, ~${Math.round(pace.minutesPerSet * 60)}s per set`
      + `${pace.measured ? '' : ' (per-set time still estimated — no logged intervals yet)'}.${SESSION_LENGTH_INFO}`;
  });

  // The key is saved on `change` (i.e. on blur, if the value actually
  // changed) rather than only on form submit. The old behaviour lost the key
  // silently whenever someone pasted it and went straight to Generate Plan —
  // the generator reads the *stored* key, not the input, so it reported "Add
  // your OpenRouter API key in Settings first" while the key sat visible on
  // screen. Model gets the same treatment for the same reason.
  ['setting-apikey', 'setting-model'].forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    const settingName = id === 'setting-apikey' ? 'openrouterKey' : 'openrouterModel';
    input.addEventListener('change', async () => {
      await setSetting(settingName, input.value.trim());
      if (id === 'setting-apikey') await refreshApiKeyStatus();
    });
  });

  document.getElementById('forget-apikey').addEventListener('click', async () => {
    await clearSetting('openrouterKey');
    document.getElementById('setting-apikey').value = '';
    await refreshApiKeyStatus();
    toast('API key forgotten');
  });

  // Says plainly whether a key is stored and where it survives, because the
  // whole point of this is not having to wonder whether it took.
  async function refreshApiKeyStatus() {
    const el = document.getElementById('apikey-status');
    if (!el) return;
    const key = await getSetting('openrouterKey', '');
    const where = dbAvailable ? 'IndexedDB + localStorage' : 'localStorage only (IndexedDB unavailable)';
    el.textContent = key
      ? `Key stored (${key.length} chars, ends "${key.slice(-4)}") in ${where} — unencrypted, so use a spend-limited key.`
      : 'No key stored yet — paste one above; it saves automatically, unencrypted, so use a spend-limited key.';
  }

  async function loadSettingsIntoForm() {
    document.getElementById('setting-apikey').value = await getSetting('openrouterKey', '');
    await refreshApiKeyStatus();
    document.getElementById('setting-model').value = await getSetting('openrouterModel', '');
    document.getElementById('setting-rest').value = await getSetting('restDefault', 90);
    document.getElementById('setting-rest-enabled').checked = await getSetting('restTimerEnabled', true);
    document.getElementById('setting-rir-prompt').checked = await getSetting('rirPromptEnabled', true);
    const storedPace = await getSetting('secondsPerSet', 0);
    document.getElementById('setting-seconds-per-set').value = storedPace || '';
    document.getElementById('setting-gym-type').value = await getSetting('gymType', 'commercial');
    const storedSetup = await getSetting('exerciseSetupSeconds', 0);
    document.getElementById('setting-exercise-setup').value = storedSetup || '';
    const storedMinutes = await getSetting('sessionMinutes', 0);
    document.getElementById('setting-session-minutes').value = storedMinutes || '';
    document.getElementById('setting-experience').value = await getSetting('experienceLevel', 'intermediate');
    document.getElementById('setting-sex').value = await getSetting('sex', 'unspecified');
    const storedAge = await getSetting('age', 0);
    document.getElementById('setting-age').value = storedAge || '';
    document.getElementById('setting-energy').value = await getSetting('energyBalance', 'maintenance');
    bodyweightKg = await getSetting('bodyweightKg', 0);
    document.getElementById('setting-plan-days').value = await getSetting('planDaysPerWeek', 4);
    document.getElementById('setting-plan-split').value = await getSetting('planSplitType', 'auto');
    document.getElementById('setting-plan-split-custom').value = await getSetting('planSplitCustom', '');
    refreshSplitCustomVisibility();
    weightUnit = await getSetting('weightUnit', 'kg');
    document.getElementById('setting-weight-unit').value = weightUnit;
    // These three are last and in this order: the default increment depends
    // on the unit, the select's options depend on the unit, and the hint
    // quotes both back in display units.
    // Merge over the defaults rather than replacing wholesale, so a stored
    // object written before a new equipment class existed still yields a step
    // for that class instead of undefined.
    equipmentStepsKg = { ...equipmentStepsKg, ...(await getSetting('equipmentStepsKg', {})) };
    renderIncrementGrid();
    refreshBodyweightField();
    refreshExperienceHint();
    await refreshSessionLengthHint();
    await refreshPaceHint();
    await refreshGymTypeHint();
    await refreshSetupHint();
  }

  document.getElementById('setting-weight-unit').addEventListener('change', async (e) => {
    weightUnit = e.target.value;
    await setSetting('weightUnit', weightUnit);
    // The increment choices and the experience hint are both quoted in
    // display units, so they have to be rebuilt whenever the unit flips.
    // renderIncrementGrid() only re-displays the grid in the new unit — it
    // must NOT be followed by readIncrementGrid()/setSetting here, or every
    // stored kg step gets snapped to the nearest option in the new unit and
    // written back (2kg -> 5lb -> 2.5kg). The stored kg values are only
    // written when an increment-grid select is itself changed (below).
    renderIncrementGrid();
    // Re-rendered rather than re-parsed: the stored value is kg, so switching
    // units must re-display it, never re-read the box as if it had changed.
    refreshBodyweightField();
    refreshExperienceHint();
    renderEntryRows();
    await refreshLogAndHistory();
    await refreshPlanTab();
    toast(`Now showing weights in ${weightUnit}`);
  });

  // Each equipment class's step saves the instant it's changed, same as
  // every other setting here — readIncrementGrid() re-reads every select
  // (not just the one that fired) because it writes equipmentStepsKg as one
  // object, not one setting per equipment class.
  document.getElementById('increment-grid').addEventListener('change', async () => {
    readIncrementGrid();
    await setSetting('equipmentStepsKg', equipmentStepsKg);
    refreshExperienceHint();
    // Progression suggestions are rendered into Log and Plan, so a changed
    // increment floor has to repaint them or stale numbers linger.
    await refreshLogAndHistory();
    await refreshPlanTab();
  });

  document.getElementById('setting-plan-days').addEventListener('change', async (e) => {
    await setSetting('planDaysPerWeek', Number(e.target.value) || 4);
    await renderWeekProgress();
  });
  document.getElementById('setting-plan-split-custom').addEventListener('change', async (e) => {
    await setSetting('planSplitCustom', e.target.value.trim());
    await renderWeekProgress();
  });
