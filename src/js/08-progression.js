  // 08-progression.js — Progression rate model, starting weight estimation, suggestForExercise
  // =========================================================================
  // Progression rate model
  //
  // Two things decide the next jump: how long the lifter has been training,
  // and how heavy the lift already is.
  //
  // TRAINING AGE is the input with real evidence behind it. Rate of strength
  // gain falls off sharply as training age rises — it is the reason novice
  // programs add load every session, intermediate programs every week, and
  // advanced programs every training block. Rhea et al.'s 2003 dose-response
  // meta-analysis found trained and untrained lifters need materially
  // different intensities and volumes to keep progressing at all, with effect
  // sizes shrinking as experience accumulates.
  //
  // ABSOLUTE LOAD matters because a fixed plate jump is not a fixed stimulus.
  // +2.5kg on a 100kg squat is 2.5%. The same +2.5kg on a 20kg overhead press
  // is 12.5% — a jump almost nobody makes session to session. The previous
  // code used flat 2.5kg upper / 5kg lower increments, which silently
  // over-prescribed on every light lift.
  //
  // So the increment is a PERCENTAGE of the current working weight, chosen by
  // training age, then snapped to a jump that can actually be loaded.
  const PROGRESSION_PCT = {
    novice:       { lower: 0.050, upper: 0.033 },
    intermediate: { lower: 0.025, upper: 0.020 },
    advanced:     { lower: 0.015, upper: 0.010 }
  };

  // Percentages alone stop discriminating once the plate floor binds: an
  // advanced lifter's 1% of a 100kg bench rounds up to the same 2.5kg an
  // intermediate gets. The lever that actually separates them in practice is
  // FREQUENCY, not size — advanced lifters earn a jump after repeated
  // successful sessions, not the first one. So experience also sets how many
  // consecutive top-of-range sessions are required before load moves.
  const PROGRESSION_SESSIONS = { novice: 1, intermediate: 1, advanced: 2 };

  // Ordered fastest-to-slowest. Used to compare two experience judgements and
  // take the more aggressive one.
  const EXPERIENCE_ORDER = ['novice', 'intermediate', 'advanced'];
  const fasterExperience = (a, b) =>
    EXPERIENCE_ORDER.indexOf(a) <= EXPERIENCE_ORDER.indexOf(b) ? a : b;

  // PER-LIFT TRAINING AGE. Global experience is a crude proxy: a three-year
  // lifter starting overhead press progresses like a novice ON THAT LIFT,
  // because early gains are substantially motor learning and that is specific
  // to the movement. Derived from logged history, so it needs no setting.
  //
  // It can only ever speed progression up, never slow it. A lift with a long
  // history doesn't make someone more advanced than they are — that's what
  // the global setting is for — but a lift with almost no history genuinely
  // does support faster jumps for anyone.
  function experienceForLiftHistory(sessionCount) {
    if (sessionCount < 8) return 'novice';
    if (sessionCount < 25) return 'intermediate';
    return 'advanced';
  }

  // AGE. Strength gains continue at every age; what declines is the rate and
  // the recovery between sessions. These coefficients are a defensible guess
  // at the shape, NOT a value taken from a study — no meta-analysis gives a
  // per-decade progression multiplier, and pretending otherwise would be
  // dressing up a judgement call as evidence.
  function ageRateMultiplier(age) {
    if (!age || age < 40) return 1;
    if (age < 50) return 0.95;
    if (age < 60) return 0.85;
    return 0.75;
  }

  // ENERGY BALANCE. Direction is well established — strength progress
  // attenuates in a caloric deficit and is modestly favoured in a surplus.
  // The magnitudes, again, are a judgement call.
  const ENERGY_MULTIPLIER = { deficit: 0.6, maintenance: 1, surplus: 1.1 };

  // RIR (reps in reserve) on the LAST set of an exercise, optional. This is
  // the highest-quality signal available, because it measures the thing every
  // other variable here only estimates: how much headroom was actually left.
  // A final set closed out with 4 in the tank was under-loaded, whatever the
  // lifter's training age or nutrition says. Absent RIR the multiplier is 1
  // and behaviour is unchanged, so logging it stays entirely optional.
  //
  // Caveat worth knowing: self-reported RIR is unreliable in novices and
  // improves with training experience — lifters systematically UNDER-estimate
  // proximity to failure, i.e. report more reps in reserve than they had. The
  // multipliers below are therefore deliberately gentle.
  function rirRateMultiplier(rir) {
    if (rir == null) return 1;
    if (rir >= 4) return 2;
    if (rir >= 3) return 1.5;
    if (rir >= 2) return 1.25;
    return 1;
  }

  // Bodyweight and assisted work carry load the logged number doesn't show. A
  // pull-up at +10kg is not a 10kg lift, and an assisted pull-up at -45kg is
  // not a -45kg lift; computing a percentage increment off either is
  // computing it off the wrong number. Falls back to the raw weight when
  // bodyweight is unknown, so the setting stays optional.
  let bodyweightKg = 0;
  function effectiveLoadKg(exercise, weightKg) {
    const equip = exerciseEquipment(exercise);
    if ((equip === 'bodyweight' || equip === 'assisted') && bodyweightKg > 0) {
      return bodyweightKg + weightKg;
    }
    return weightKg;
  }

  // SEX_NOTE — why sex is stored but deliberately does not scale this.
  // The intuition is reasonable and the evidence does not support it. Meta
  // analysis of controlled resistance-training trials (Roberts, Nuckols &
  // Krieger 2020, J Strength Cond Res) found women's *relative* strength
  // gains equal to men's in the lower body and slightly greater in the upper
  // body. Absolute gains differ, because absolute starting loads differ — and
  // that is precisely what the load-relative increment above already handles,
  // for everyone, without needing to know anyone's sex. Applying a second
  // sex-based multiplier on top would double-count the load difference and
  // encode a false premise about rate. `sex` is therefore used for AI plan
  // context only. If this ever changes, change it because of evidence about
  // rate, not because the numbers feel like they ought to differ.

  // Smallest jump that can actually be loaded, per equipment class, in kg.
  // This is the variable that decides whether the progression percentages mean
  // anything: a 2.5kg floor rounds novice, intermediate and advanced to the
  // SAME jump on every upper-body lift under ~125kg. Cached in a module-level
  // object so the progression hot path stays synchronous.
  let equipmentStepsKg = Object.fromEntries(EQUIPMENT.map(e => [e.id, e.defaultStepKg]));

  // Exercises predating the equipment field (and anything the user never
  // corrected) fall back to guessing from the name, so no migration is needed
  // and nothing is ever left without a step.
  function exerciseEquipment(exercise) {
    if (!exercise) return 'other';
    return exercise.equipment || classifyEquipmentFromName(exercise.name || '');
  }

  function loadStepKg(exercise) {
    const step = equipmentStepsKg[exerciseEquipment(exercise)];
    return step > 0 ? step : 2.5;
  }

  // =========================================================================
  // Warm-up ramp shown under the working-weight suggestion in the active
  // workout, once there IS a working weight to ramp into. Fixed percentages
  // of that weight (50%×8, 70%×5, 85%×2) — not measured, because warm-ups
  // are never logged, so there's nothing to derive a measured ramp from (see
  // Part 2 of the design summary). Skipped entirely for bodyweight/assisted
  // work (nothing to load onto the body before the working set) and for a
  // load too light to be worth ramping into at all.
  // =========================================================================
  const WARMUP_STEPS = [[0.50, 8], [0.70, 5], [0.85, 2]];
  function warmupSets(workingKg, exercise) {
    if (workingKg == null || workingKg <= 0) return [];
    const equip = exerciseEquipment(exercise);
    if (equip === 'bodyweight' || equip === 'assisted') return [];
    const step = loadStepKg(exercise);
    if (equip === 'barbell') {
      // An empty bar (20kg) IS the warm-up once the working weight is only a
      // few plates past it — showing a "ramp" on top of that would just be
      // the same bar shown three times.
      if (workingKg <= 30) return [];
    } else if (workingKg <= 4 * step) {
      // Same idea without a fixed bar to anchor on: a working weight that's
      // only a handful of the equipment's own loadable steps (e.g. an 8kg
      // dumbbell pair at a 2kg step) is already about as light as it gets —
      // a ramp into it would just be smaller multiples of the same tiny step.
      return [];
    }
    const out = [];
    for (const [pct, reps] of WARMUP_STEPS) {
      const w = Math.round((workingKg * pct) / step) * step;
      if (equip === 'barbell' && w < 20) continue;   // can't load less than an empty bar
      if (w <= 0) continue;
      if (w >= workingKg) continue;
      if (out.some(c => c.weightKg === w)) continue; // collapsed onto an earlier candidate
      out.push({ weightKg: w, reps });
    }
    return out.slice(0, 3);
  }

  // Offered jumps differ by unit because the plates do: kg gyms have 1.25kg
  // plates (2.5kg jump) and microplate sets go down to 0.25kg; lb gyms have
  // 2.5lb plates (5lb jump) and 1.25lb microplates.
  const INCREMENT_CHOICES = { kg: [0.5, 1, 1.25, 2, 2.5, 5, 10], lb: [1, 2.5, 5, 10, 20] };

  function renderIncrementGrid() {
    const grid = document.getElementById('increment-grid');
    if (!grid) return;
    const choices = INCREMENT_CHOICES[weightUnit] || INCREMENT_CHOICES.kg;
    grid.innerHTML = EQUIPMENT.map(eq => {
      const current = Math.round(fromKg(equipmentStepsKg[eq.id] ?? eq.defaultStepKg) * 100) / 100;
      // A stored kg value can land between the offered display-unit options
      // when the unit is switched under it. Snap to the nearest offered value
      // rather than rendering a select whose display contradicts the setting.
      const nearest = choices.reduce((best, v) => Math.abs(v - current) < Math.abs(best - current) ? v : best, choices[0]);
      const opts = choices.map(v => `<option value="${v}" ${v === nearest ? 'selected' : ''}>${v} ${weightUnit}</option>`).join('');
      return `<label for="step-${eq.id}">${esc(eq.name)}</label><select id="step-${eq.id}" data-equip="${eq.id}">${opts}</select>`;
    }).join('');
  }

  function readIncrementGrid() {
    EQUIPMENT.forEach(eq => {
      const sel = document.getElementById(`step-${eq.id}`);
      if (!sel) return;
      equipmentStepsKg[eq.id] = toKg(Number(sel.value) || fromKg(eq.defaultStepKg));
    });
  }

  // Returns BOTH the jump and how many clean sessions to bank before taking
  // it, because those are the same decision.
  //
  // The target increment is a percentage of the real load. Often it comes out
  // SMALLER than the smallest jump the equipment allows — 2% of a 100kg bench
  // is 2kg, and the bar moves in 2.5kg steps. Rounding that up to 2.5kg was
  // the obvious first answer and it was wrong: it silently discarded every
  // modifier below the floor, so reporting 3 reps in reserve, cutting, or
  // being 55 all produced the identical +2.5kg. The setting looked live and
  // wasn't.
  //
  // The honest translation of "you should add less than one plate per
  // session" is not "add one plate" — it's "add one plate, less often". So a
  // sub-step target becomes a session requirement instead: ceil(step / target)
  // clean sessions before the smallest available jump. Average rate then
  // tracks the target percentage at any load, on any equipment, and every
  // modifier stays visible.
  function progressionPlan(lastWeightKg, region, experience, exercise, modifiers = {}) {
    const table = PROGRESSION_PCT[experience] || PROGRESSION_PCT.intermediate;
    const pct = table[region === 'lower' ? 'lower' : 'upper'];
    const step = loadStepKg(exercise);
    const baseSessions = PROGRESSION_SESSIONS[experience] || 1;
    // Percentage applies to the REAL load being moved, not the logged number.
    const load = Math.abs(effectiveLoadKg(exercise, lastWeightKg));
    const scale = ageRateMultiplier(modifiers.age)
      * (ENERGY_MULTIPLIER[modifiers.energy] ?? 1)
      * rirRateMultiplier(modifiers.rir);
    const target = load * pct * scale;

    if (target >= step) {
      return { incrementKg: Math.round(target / step) * step, sessionsRequired: baseSessions };
    }
    // target of 0 (bodyweight-only work logged at 0) would divide to Infinity.
    const spread = target > 0 ? Math.ceil(step / target) : baseSessions;
    // Cap it: past about six clean sessions at one weight the prescription
    // people actually need is a different exercise or a deload, not a longer
    // wait, and an uncapped number reads as broken.
    return { incrementKg: step, sessionsRequired: Math.min(6, Math.max(baseSessions, spread)) };
  }

  // =========================================================================
  // Starting weight for a lift with NO history
  //
  // Previously there wasn't one: zero logged sets meant `weight: null` and a
  // blank input box. That was tolerable when a new exercise was a first-run
  // event; it stopped being tolerable once plans regenerate weekly, because
  // every new plan introduces movements you have never done and hands you a
  // row of empty fields in the gym.
  //
  // WHAT IT USES. Equipment class is the load scale. A "chest" exercise says
  // nothing about weight on its own — a barbell bench and a cable fly are both
  // chest and an order of magnitude apart — but a chest CABLE movement is
  // reliably in the neighbourhood of your other chest cable movements. So the
  // best match is same muscle + same equipment, and that is the tier that
  // needs no cross-scale assumptions at all.
  //
  // WHY IT ERRS LOW. A first set that is too light costs one set. A first set
  // that is too heavy costs a failed rep on an unfamiliar movement, which is
  // where people get hurt. Every tier therefore applies a haircut, and a new
  // movement genuinely is harder than a familiar one at the same load —
  // unfamiliar groove, no motor learning yet — so the haircut is honest rather
  // than merely cautious.
  //
  // WHEN IT REFUSES. If nothing comparable exists it returns null and the box
  // stays blank, exactly as before. A confident wrong number is worse than an
  // empty field, because an empty field is obviously your problem to solve.
  // =========================================================================

  // Rough load carried by each equipment class for the SAME muscle, barbell
  // as the reference. These are judgement calls in the same spirit as
  // ageRateMultiplier() — a defensible shape, NOT numbers from a study, and
  // they only ever seed a first guess the user is about to overwrite.
  //
  // Dumbbells carry a real ambiguity worth naming: the Fitbod importer stores
  // them as TOTAL load (it multiplies by the export's `multiplier` of 2.0),
  // while someone typing a dumbbell press by hand almost certainly enters the
  // per-hand number. Both shapes exist in the same store and nothing
  // distinguishes them. That ambiguity cancels out entirely within the
  // same-equipment tier — per-hand history seeds a per-hand estimate — which
  // is the main reason the cross-equipment tiers below are deliberately timid.
  const EQUIP_LOAD_RATIO = {
    barbell: 1, machine: 0.9, cable: 0.5, dumbbell: 0.45, other: 0.7
  };

  // A myo-rep set or a drop set counts as ONE working set for progression,
  // represented by its FIRST entry — the working weight and the reps done at
  // it before the myo clusters or drops that follow. The first entry is the
  // set actually performed at the working weight before fatigue is
  // deliberately extended past it, so it's the unit comparable across
  // sessions and across set types. Volume still sums every entry
  // (setVolumeKg) — this only changes what progression judges. Returns null
  // for a set with no entries at all (shouldn't happen, but every caller was
  // already guarding it).
  function workingEntry(set) {
    return (set && set.entries && set.entries.length) ? set.entries[0] : null;
  }

  // Most recent working weight per exercise: the heaviest working set (see
  // workingEntry()) of the latest session that exercise appears in.
  function recentTopSetByExercise(workouts, excludeExerciseId) {
    const recent = new Map();
    for (const w of workouts) {
      for (const ex of w.exercises) {
        if (ex.exerciseId === excludeExerciseId) continue;
        let top = null;
        for (const s of ex.sets) {
          const we = workingEntry(s);
          if (!we) continue;
          const wt = we.weight;
          if (top === null || wt > top) top = wt;
        }
        if (top === null) continue;
        const prev = recent.get(ex.exerciseId);
        if (!prev || w.date > prev.date) recent.set(ex.exerciseId, { weight: top, date: w.date });
      }
    }
    return recent;
  }

  function estimateStartingWeight(exercise, workouts, exercisesById) {
    if (!exercise) return null;
    const equip = exerciseEquipment(exercise);
    const step = loadStepKg(exercise);
    const musclesById = Object.fromEntries(MUSCLES.map(m => [m.id, m]));
    const muscleName = (musclesById[exercise.primaryMuscle] || { name: 'this muscle' }).name.toLowerCase();

    // An AI estimate, if plan generation managed to get one, wins — it reasons
    // from the real strength relationships between movements rather than from
    // equipment class, which is all the tiers below have to work with. Already
    // sanity-bounded and rounded when it was stored; see
    // estimateStartingWeightsWithAI(). Self-expiring: the moment this lift has
    // a logged set, suggestForExercise() never reaches this function again.
    if (typeof exercise.startingWeightKg === 'number' && isFinite(exercise.startingWeightKg)) {
      const kg = exercise.startingWeightKg;
      return {
        weightKg: kg, tag: 'AI estimate',
        text: kg < 0
          ? `No history yet — suggested ${Math.abs(displayWeight(kg))}${weightUnit} of assist for your first session. Adjust before your first set.`
          : `No history yet — suggested ${displayWeight(kg)}${weightUnit} for your first session, from your logged lifts. Adjust before your first set.`
      };
    }

    // Bodyweight work already has a correct, safe starting load: you. Zero is
    // the right number and it is not a guess, so it gets no "estimate" tag.
    if (equip === 'bodyweight') {
      return { weightKg: 0, tag: null, text: 'No history yet — start with just bodyweight and see where the reps land.' };
    }

    const recent = recentTopSetByExercise(workouts, exercise.id);
    if (recent.size === 0) return null;

    const rows = [];
    for (const [id, r] of recent) {
      const rec = exercisesById[id];
      if (!rec) continue;
      const rEquip = exerciseEquipment(rec);
      rows.push({
        rec, weight: r.weight, equip: rEquip,
        muscle: rec.primaryMuscle,
        region: (musclesById[rec.primaryMuscle] || {}).region
      });
    }

    // Assisted movements live on their own scale — the number is negative and
    // means "help given", so it can neither seed nor be seeded by a loaded
    // lift. Matched only against other assisted work.
    if (equip === 'assisted') {
      const assisted = rows.filter(r => r.equip === 'assisted' && r.weight < 0);
      const sameMuscle = assisted.filter(r => r.muscle === exercise.primaryMuscle);
      const pool = sameMuscle.length ? sameMuscle : assisted;
      if (!pool.length) return null;
      // MORE assistance than the comparable lift, not less: this movement is
      // new, so start easier. Assistance is negative, so "more" is further
      // from zero.
      const kg = median(pool.map(r => r.weight)) * 1.15;
      const rounded = -Math.max(step, Math.round(Math.abs(kg) / step) * step);
      return {
        weightKg: rounded, tag: 'estimate',
        text: `No history yet — estimated ${Math.abs(displayWeight(rounded))}${weightUnit} of assist from your other assisted work. Adjust before your first set.`
      };
    }

    const loaded = rows.filter(r => r.weight > 0 && r.equip !== 'assisted' && r.equip !== 'bodyweight');
    if (!loaded.length) return null;

    const region = (musclesById[exercise.primaryMuscle] || {}).region;
    const ratioFor = (e) => EQUIP_LOAD_RATIO[e] || EQUIP_LOAD_RATIO.other;

    // COMPOUND vs ISOLATION, read off `secondaryMuscles`.
    //
    // Muscle and equipment together still straddle a big gap: bench press and
    // cable fly are both chest, and averaging them gives a number that is too
    // light to press and too heavy to fly. The catalog already distinguishes
    // them — a compound names the other muscles it borrows, an isolation names
    // none — so prefer candidates of the same kind before falling back to the
    // whole pool.
    //
    // Only a PREFERENCE, because the signal isn't always there: exercises
    // created by the Fitbod importer (and by AI plans naming something new)
    // get `secondaryMuscles: []` and therefore look like isolations whatever
    // they are. When nothing matches, the filter drops away and the tier
    // behaves as it did before — never worse, often better.
    const isCompound = (rec) => Array.isArray(rec.secondaryMuscles) && rec.secondaryMuscles.length > 0;
    const wantCompound = isCompound(exercise);
    const preferSameKind = (pool) => {
      const alike = pool.filter(r => isCompound(r.rec) === wantCompound);
      return alike.length ? alike : pool;
    };

    // Tiers, best first. Each returns the candidate weights already converted
    // onto this exercise's scale.
    const sameMuscleSameEquip = preferSameKind(loaded.filter(r => r.muscle === exercise.primaryMuscle && r.equip === equip));
    const sameMuscleAnyEquip = preferSameKind(loaded.filter(r => r.muscle === exercise.primaryMuscle));
    const sameRegionSameEquip = preferSameKind(loaded.filter(r => r.region === region && r.equip === equip));

    let values = null, haircut = 0, basis = '';
    if (sameMuscleSameEquip.length) {
      // No scaling at all — like for like. The confident tier.
      values = sameMuscleSameEquip.map(r => r.weight);
      haircut = 0.85;
      basis = `your other ${muscleName} work on the same equipment`;
    } else if (sameMuscleAnyEquip.length) {
      // Right muscle, wrong implement: scale across equipment classes and be
      // noticeably more timid about the result.
      values = sameMuscleAnyEquip.map(r => r.weight * (ratioFor(equip) / ratioFor(r.equip)));
      haircut = 0.75;
      basis = `your ${muscleName} training, scaled for the equipment`;
    } else if (sameRegionSameEquip.length) {
      // Never trained this muscle, but have trained this implement elsewhere
      // in the same half of the body. Weak, and priced accordingly.
      values = sameRegionSameEquip.map(r => r.weight);
      haircut = 0.65;
      basis = `your other ${region === 'lower' ? 'lower' : region === 'core' ? 'core' : 'upper'}-body work on the same equipment`;
    } else {
      return null;
    }

    const raw = median(values) * haircut;
    if (!isFinite(raw) || raw <= 0) return null;
    const rounded = Math.max(step, Math.round(raw / step) * step);
    return {
      weightKg: rounded, tag: 'estimate',
      text: `No history yet — estimated ${displayWeight(rounded)}${weightUnit} from ${basis}. Deliberately light; adjust before your first set.`
    };
  }

  // =========================================================================
  // Progression suggestion (double progression, computed from history)
  //
  // All weight math here happens in kg (canonical storage units). Only the
  // returned `text` converts to the display unit; the returned `weight` is
  // still kg — callers convert via displayWeight() when prefilling inputs.
  // =========================================================================
  // `exercisesById` is optional and only an optimisation — renderActiveWorkout
  // has already built it. The starting-weight estimator needs the whole
  // catalog to find comparable lifts, so without it this falls back to a read.
  // `experienceLevel`/`age`/`energyBalance` are read via getSettingSync()
  // rather than a `profile` parameter — the settings cache (see 02-storage.js)
  // makes that a Map lookup, not a store read, so there is no per-exercise
  // cost left to optimise away by having the caller pre-fetch them.
  async function suggestForExercise(exerciseId, repRangeMin, repRangeMax, targetSets, allWorkouts, exercisesById) {
    const workouts = allWorkouts || await getAllWorkouts();
    const history = [];
    // Each session also carries the set count that was actually PRESCRIBED
    // that day. A session shortened with the today-only set adjuster used to
    // be judged against the plan's full target, so it could never count as
    // "cleared" no matter how it went — a legitimate 2-of-3 day silently
    // blocked progression forever after.
    const sessionTargets = new Map();
    workouts.forEach(w => {
      const exEntry = w.exercises.find(ex => ex.exerciseId === exerciseId);
      if (!exEntry) return;
      const override = w.targetOverrides ? w.targetOverrides[exerciseId] : undefined;
      if (override != null) sessionTargets.set(w.date, override);
      exEntry.sets.forEach(s => {
        const we = workingEntry(s);
        if (we) history.push({ date: w.date, ts: s.ts, weight: we.weight, reps: we.reps, rir: s.rir });
      });
    });
    if (history.length === 0) {
      // Nothing logged for this lift. Try to seed a sensible opening weight
      // from comparable movements rather than handing over an empty box \u2014 see
      // estimateStartingWeight(). Returns null when nothing comparable exists,
      // in which case the field stays blank exactly as it always did.
      const byId = exercisesById
        || Object.fromEntries((await getAllRecords('exercises')).map(e => [e.id, e]));
      const est = estimateStartingWeight(byId[exerciseId], workouts, byId);
      if (est) {
        return { text: est.text, why: est.tag ? [est.tag] : [], weight: est.weightKg, reps: repRangeMin };
      }
      return { text: 'No history yet \u2014 pick a starting weight.', why: [], weight: null, reps: repRangeMin };
    }

    // Group into sessions, newest first, each capped at the prescribed set
    // count — extra/bonus sets beyond the plan's target shouldn't count
    // against progression.
    const byDate = new Map();
    history.forEach(s => {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date).push(s);
    });
    // Clamped locally too: a bad targetSets from anywhere upstream would make
    // slice() return [], and `sessions[0][0]` then throws and takes the whole
    // Log tab render down with it.
    const perSession = Math.max(1, Math.round(Number(targetSets)) || 1);
    const targetFor = (date) => {
      const o = sessionTargets.get(date);
      return o != null ? Math.max(1, Math.round(Number(o)) || 1) : perSession;
    };
    const sessions = [...byDate.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, sets]) => ({ date, sets: sets.sort((a, b) => a.ts - b.ts).slice(0, targetFor(date)) }));

    // Weights are compared with a tolerance rather than ===. Every value is
    // canonical kg produced by toKg(), so two sets entered identically match
    // exactly — but a lift logged in kg one week and lb the next lands a
    // rounding step away: displayed in lb at one decimal and logged back
    // through toKg(), the round trip lands within ~0.02kg of the original.
    // Loads move in >= 0.5kg steps, so 0.05 is still ten times below the
    // smallest loadable step while comfortably covering the round trip.
    const sameWeight = (a, b) => Math.abs(a - b) < 0.05;

    // RAMPED SESSIONS.
    //
    // This used to anchor everything on sessions[0].sets[0] — the FIRST set of
    // the last session — and require every set to reach repRangeMax. That is
    // straight-sets double progression, and it is silently wrong for anyone who
    // ramps up to a top set: log 60x8, 70x6, 80x4 and the model reads the
    // working weight as 60kg, then waits for a 60kg set to hit the top of the
    // rep range that will never come because 60 is a warm-up. The suggestion
    // freezes at "stay at 60kg" forever, and the freeze looks like a considered
    // recommendation rather than a bug.
    //
    // A session counts as ramped when its sets aren't all at one weight. The
    // set that actually decides the load is then the HEAVIEST one, so that is
    // what gets judged and what the next jump is computed from. Straight sets
    // are untouched: identical weights make topSetOf() return that weight and
    // every() still gates on the whole session.
    //
    // `>` on raw kg is correct in both sign conventions: assisted work is
    // stored negative, and -20 (less help) is both greater than -40 and the
    // harder set.
    const topSetOf = (sets) => sets.reduce((best, s) => (s.weight > best.weight ? s : best), sets[0]);
    const isRamped = (sets) => !sets.every(s => sameWeight(s.weight, sets[0].weight));

    const lastSessionSets = sessions[0].sets;
    const lastRamped = isRamped(lastSessionSets);
    const lastTopSet = topSetOf(lastSessionSets);
    const lastWeightKg = lastTopSet.weight;
    const clearedTop = (sn) => {
      if (sn.sets.length < targetFor(sn.date)) return false;
      // Ramped: only the top set has to clear, because the lighter sets were
      // never meant to. Straight: every set has to, as before.
      return isRamped(sn.sets)
        ? topSetOf(sn.sets).reps >= repRangeMax
        : sn.sets.every(s => s.reps >= repRangeMax);
    };

    const exercise = exercisesById ? exercisesById[exerciseId] : await getRecord('exercises', exerciseId);
    const muscle = MUSCLES.find(m => m.id === (exercise && exercise.primaryMuscle));
    const region = muscle && muscle.region === 'lower' ? 'lower' : 'upper';
    const globalExperience = getSettingSync('experienceLevel', 'intermediate');

    // A lift with almost no history supports faster jumps for anyone, so take
    // whichever of the two judgements is more aggressive. Never the reverse:
    // lots of history on one lift doesn't make a novice an advanced lifter.
    const liftExperience = experienceForLiftHistory(sessions.length);
    const experience = fasterExperience(globalExperience, liftExperience);
    const newLiftBoost = experience !== globalExperience;

    // THE LAST SET'S RIR, not an average across the session.
    //
    // Averaging was both more work and less accurate. Fatigue accumulates
    // within a session, so a mean of 2 might be 4 / 2 / 0 — a session whose
    // final set went to absolute failure, reported as comfortably submaximal.
    // The last set is the binding one: it is closest to failure and it is
    // what decides whether the load was right. Under double progression it is
    // also the set that gates the whole exercise.
    //
    // The old rule additionally required EVERY set to carry a value, which
    // meant logging just the last one — the sensible thing to do — was
    // silently ignored.
    //
    // On a RAMPED session the top set is the binding one instead: it is both
    // the heaviest and, on a ramp, the one the whole session was building
    // toward. It is usually also the last set, in which case these agree; when
    // it isn't (a back-off set after the top single), the top set is still what
    // the load decision is about. Falls back to the last set's value when the
    // top set carries none, so logging just the final RIR keeps working.
    const lastSet = lastSessionSets[lastSessionSets.length - 1];
    const rirOf = (s) => (s && typeof s.rir === 'number' ? s.rir : null);
    const lastRir = lastRamped
      ? (rirOf(lastTopSet) ?? rirOf(lastSet))
      : rirOf(lastSet);

    const modifiers = {
      age: Number(getSettingSync('age', 0)) || 0,
      energy: getSettingSync('energyBalance', 'maintenance'),
      rir: lastRir
    };
    const { incrementKg: increment, sessionsRequired: needed } =
      progressionPlan(lastWeightKg, region, experience, exercise, modifiers);

    // Count consecutive most-recent sessions that cleared the top of the rep
    // range AT THE SAME WEIGHT. A heavier session that also cleared the top
    // is a different rung of the ladder, not evidence about this one.
    // Compared on each session's TOP set, for the same reason the anchor is
    // the top set: on a ramp, sets[0] is a warm-up whose weight says nothing
    // about which rung of the ladder that session was on.
    let clearedStreak = 0;
    for (const sn of sessions) {
      if (!sameWeight(topSetOf(sn.sets).weight, lastWeightKg) || !clearedTop(sn)) break;
      clearedStreak++;
    }
    const metTop = clearedStreak >= needed;

    // Assisted movements are stored as a negative weight (the load taken off
    // you), so adding `increment` is already the right direction: less
    // assistance, harder set. Only the phrasing needs to change \u2014 "try
    // -27.5kg" is technically correct and completely unreadable.
    const weightPhrase = (kg) => kg < 0
      ? `${Math.abs(displayWeight(kg))}${weightUnit} of assist`
      : `${displayWeight(kg)}${weightUnit}`;

    // Say when something other than the plain rule is driving the number.
    // A suggestion that silently differs from what the user expects reads as
    // a bug; the same suggestion with its reason attached reads as a feature.
    // Terse tags, not sentences. These were full explanatory clauses joined
    // into the suggestion line, which ran to ~280 characters -- six or seven
    // lines of accent-coloured text above EVERY exercise on a phone, before
    // you reached a single input. The reason still has to be visible (a
    // number that silently differs from expectation reads as a bug), but it
    // does not have to be prose.
    const why = [];
    if (newLiftBoost) why.push('new lift');
    // Named explicitly: the numbers below are about the top set, not the whole
    // session, and someone who ramps should be able to see that is understood
    // rather than wonder why their warm-ups are being ignored.
    if (lastRamped) why.push('top set');
    if (lastRir != null && lastRir >= 2) why.push(`${lastRir === 4 ? '4+' : lastRir} RIR left`);
    if (modifiers.energy === 'deficit') why.push('cutting');
    if (modifiers.age >= 40) why.push(`age ${modifiers.age}`);

    if (metTop) {
      const nextWeightKg = lastWeightKg + increment;
      const clearedPhrase = lastRamped ? `Top set hit ${repRangeMax}+` : `Hit ${repRangeMax}+ on every set`;
      return { text: `${clearedPhrase} \u2014 try ${weightPhrase(nextWeightKg)} \u00d7 ${repRangeMin}.`, why, weight: nextWeightKg, reps: repRangeMin };
    }
    // Cleared the top but hasn't banked enough sessions yet (advanced only):
    // holding the weight for another confirming session IS the prescription,
    // so say that rather than asking for reps already achieved.
    if (clearedStreak > 0) {
      return { text: `Clean session \u2014 ${clearedStreak} of ${needed} before the weight moves. Repeat ${weightPhrase(lastWeightKg)} \u00d7 ${repRangeMax}.`, why, weight: lastWeightKg, reps: repRangeMax };
    }
    // Straight sets: the WORST set gates, so take the minimum. Ramped: the top
    // set is the one being progressed, so take its reps — a min across a ramp
    // would happen to be the top set most of the time and be badly wrong the
    // moment a back-off set went lighter and longer.
    const lastReps = lastRamped ? lastTopSet.reps : Math.min(...lastSessionSets.map(s => s.reps));
    const nextReps = Math.min(repRangeMax, lastReps + 1);
    // In a deficit, repeating last session's numbers IS the goal. Reporting
    // it as "aim for one more rep" frames a good outcome as a failure.
    if (modifiers.energy === 'deficit') {
      return { text: `Hold ${weightPhrase(lastWeightKg)} for ${lastReps}+ \u2014 keeping your numbers is the win while cutting.`, why, weight: lastWeightKg, reps: nextReps };
    }
    return { text: `Stay at ${weightPhrase(lastWeightKg)}, aim for ${nextReps} reps.`, why, weight: lastWeightKg, reps: nextReps };
  }
