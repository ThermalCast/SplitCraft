  // 01-data.js — Reference data: MUSCLES, EQUIPMENT, DEFAULT_EXERCISES, KG_PER_LB
  // =========================================================================
  // Reference data — muscles are static app constants, not stored in the DB.
  // Exercises are seeded into IndexedDB from DEFAULT_EXERCISES on first run,
  // and reference a muscle by its string id below.
  // =========================================================================
  const MUSCLES = [
    { id: 'chest', name: 'Chest', region: 'upper', pattern: 'push' },
    { id: 'front_delts', name: 'Front Delts', region: 'upper', pattern: 'push' },
    { id: 'side_delts', name: 'Side Delts', region: 'upper', pattern: 'push' },
    { id: 'rear_delts', name: 'Rear Delts', region: 'upper', pattern: 'pull' },
    { id: 'triceps', name: 'Triceps', region: 'upper', pattern: 'push' },
    { id: 'lats', name: 'Lats', region: 'upper', pattern: 'pull' },
    { id: 'upper_back', name: 'Upper Back / Traps', region: 'upper', pattern: 'pull' },
    { id: 'biceps', name: 'Biceps', region: 'upper', pattern: 'pull' },
    { id: 'forearms', name: 'Forearms', region: 'upper', pattern: 'pull' },
    { id: 'quads', name: 'Quadriceps', region: 'lower', pattern: 'push' },
    { id: 'hamstrings', name: 'Hamstrings', region: 'lower', pattern: 'pull' },
    { id: 'glutes', name: 'Glutes', region: 'lower', pattern: 'push' },
    { id: 'calves', name: 'Calves', region: 'lower', pattern: 'push' },
    { id: 'adductors', name: 'Adductors', region: 'lower', pattern: 'pull' },
    { id: 'abs', name: 'Abs / Core', region: 'core', pattern: 'core' },
    { id: 'lower_back', name: 'Lower Back', region: 'core', pattern: 'pull' },
    { id: 'unclassified', name: 'Unclassified', region: 'upper', pattern: 'push' }
  ];

  // The built-in catalog. Grouped by primary muscle purely for readability --
  // syncDefaultExercises() matches by name, so order here means nothing.
  //
  // Coverage rule: every muscle in MUSCLES gets at least three entries, and
  // each muscle's set spans the equipment someone might actually have
  // (barbell / dumbbell / machine / cable / bodyweight). Before this pass
  // adductors, forearms and lower_back had ZERO defaults and five more
  // muscles had exactly one, so the weekly-sets chart showed bars for
  // muscles a fresh install had no way to train, and the AI planner had
  // nothing to reach for when it wanted a lower-back or grip movement.
  //
  // `secondaryMuscles` is advisory: it feeds the AI prompt and the picker,
  // and is deliberately NOT counted in the weekly-sets chart (a bench press
  // scores as chest, not chest + triceps + delts).
  // Equipment class — what the exercise is loaded with. Exists for exactly one
  // reason: the smallest jump you can add is a property of the IMPLEMENT, not
  // of the lifter. A barbell with 1.25kg plates moves in 2.5kg steps; a
  // dumbbell rack moves in 2kg (or 5lb) steps whatever you want; a pin stack
  // moves in 5kg steps and doesn't care how strong you are. One global
  // "smallest jump" setting is wrong for at least two of those at all times.
  //
  // `defaultStepKg` is only a seed for the per-class setting (Settings →
  // Workout), which the user can override per class. Values are the common
  // case, not a claim about every gym:
  //   barbell    2.5kg — a PAIR of 1.25kg plates. 0.5kg microplates give 1kg.
  //   dumbbell   2.0kg — fixed racks step 2kg or 5lb; adjustables vary wildly.
  //   machine    5.0kg — pin stacks, often with a 2.5kg add-on magnet.
  //   cable      5.0kg — same stacks, same caveat.
  //   assisted   5.0kg — assist stacks are usually the coarsest thing in the gym.
  //   bodyweight 2.5kg — the jump is whatever you hang off a belt, so plates.
  const EQUIPMENT = [
    { id: 'barbell', name: 'Barbell', defaultStepKg: 2.5 },
    { id: 'dumbbell', name: 'Dumbbell', defaultStepKg: 2 },
    { id: 'machine', name: 'Machine (pin stack)', defaultStepKg: 5 },
    { id: 'cable', name: 'Cable (pin stack)', defaultStepKg: 5 },
    { id: 'assisted', name: 'Assisted (counterweight)', defaultStepKg: 5 },
    { id: 'bodyweight', name: 'Bodyweight', defaultStepKg: 2.5 },
    { id: 'other', name: 'Other / free', defaultStepKg: 2.5 }
  ];

  const DEFAULT_EXERCISES = [
    // ---- Chest ----
    { name: 'Barbell Bench Press', primaryMuscle: 'chest', secondaryMuscles: ['triceps', 'front_delts'] },
    { name: 'Dumbbell Bench Press', primaryMuscle: 'chest', secondaryMuscles: ['triceps', 'front_delts'] },
    { name: 'Incline Barbell Bench Press', primaryMuscle: 'chest', secondaryMuscles: ['front_delts', 'triceps'] },
    { name: 'Incline Dumbbell Press', primaryMuscle: 'chest', secondaryMuscles: ['front_delts', 'triceps'] },
    { name: 'Machine Chest Press', primaryMuscle: 'chest', secondaryMuscles: ['triceps', 'front_delts'] },
    { name: 'Dips', primaryMuscle: 'chest', secondaryMuscles: ['triceps'] },
    { name: 'Assisted Dip', primaryMuscle: 'chest', secondaryMuscles: ['triceps'] },
    { name: 'Push-Up', primaryMuscle: 'chest', secondaryMuscles: ['triceps', 'front_delts'] },
    { name: 'Cable Fly', primaryMuscle: 'chest', secondaryMuscles: [] },
    { name: 'Dumbbell Fly', primaryMuscle: 'chest', secondaryMuscles: [] },
    { name: 'Pec Deck', primaryMuscle: 'chest', secondaryMuscles: [] },

    // ---- Front delts ----
    { name: 'Overhead Press', primaryMuscle: 'front_delts', secondaryMuscles: ['triceps'] },
    { name: 'Dumbbell Shoulder Press', primaryMuscle: 'front_delts', secondaryMuscles: ['triceps'] },
    { name: 'Machine Shoulder Press', primaryMuscle: 'front_delts', secondaryMuscles: ['triceps'] },
    { name: 'Arnold Press', primaryMuscle: 'front_delts', secondaryMuscles: ['side_delts', 'triceps'] },
    { name: 'Front Raise', primaryMuscle: 'front_delts', secondaryMuscles: [] },

    // ---- Side delts ----
    { name: 'Lateral Raise', primaryMuscle: 'side_delts', secondaryMuscles: [] },
    { name: 'Cable Lateral Raise', primaryMuscle: 'side_delts', secondaryMuscles: [] },
    { name: 'Machine Lateral Raise', primaryMuscle: 'side_delts', secondaryMuscles: [] },
    { name: 'Upright Row', primaryMuscle: 'side_delts', secondaryMuscles: ['upper_back'] },

    // ---- Rear delts ----
    { name: 'Face Pull', primaryMuscle: 'rear_delts', secondaryMuscles: ['upper_back'] },
    { name: 'Reverse Pec Deck', primaryMuscle: 'rear_delts', secondaryMuscles: ['upper_back'] },
    { name: 'Rear Delt Fly', primaryMuscle: 'rear_delts', secondaryMuscles: ['upper_back'] },
    { name: 'Bent-Over Reverse Fly', primaryMuscle: 'rear_delts', secondaryMuscles: ['upper_back'] },

    // ---- Triceps ----
    { name: 'Triceps Pushdown', primaryMuscle: 'triceps', secondaryMuscles: [] },
    { name: 'Skull Crusher', primaryMuscle: 'triceps', secondaryMuscles: [] },
    { name: 'Overhead Triceps Extension', primaryMuscle: 'triceps', secondaryMuscles: [] },
    { name: 'Close-Grip Bench Press', primaryMuscle: 'triceps', secondaryMuscles: ['chest', 'front_delts'] },
    { name: 'Bench Dip', primaryMuscle: 'triceps', secondaryMuscles: ['chest'] },
    { name: 'Triceps Kickback', primaryMuscle: 'triceps', secondaryMuscles: [] },

    // ---- Lats ----
    { name: 'Pull-Up', primaryMuscle: 'lats', secondaryMuscles: ['biceps'] },
    { name: 'Assisted Pull-Up', primaryMuscle: 'lats', secondaryMuscles: ['biceps'] },
    { name: 'Chin-Up', primaryMuscle: 'lats', secondaryMuscles: ['biceps'] },
    { name: 'Lat Pulldown', primaryMuscle: 'lats', secondaryMuscles: ['biceps'] },
    { name: 'Barbell Row', primaryMuscle: 'lats', secondaryMuscles: ['biceps', 'upper_back'] },
    { name: 'Dumbbell Row', primaryMuscle: 'lats', secondaryMuscles: ['biceps', 'upper_back'] },
    { name: 'T-Bar Row', primaryMuscle: 'lats', secondaryMuscles: ['upper_back', 'biceps'] },
    { name: 'Machine Row', primaryMuscle: 'lats', secondaryMuscles: ['upper_back', 'biceps'] },
    { name: 'Inverted Row', primaryMuscle: 'lats', secondaryMuscles: ['upper_back', 'biceps'] },
    { name: 'Seated Cable Row', primaryMuscle: 'lats', secondaryMuscles: ['upper_back', 'biceps'] },
    { name: 'Chest-Supported Row', primaryMuscle: 'lats', secondaryMuscles: ['upper_back', 'rear_delts'] },
    { name: 'Straight-Arm Pulldown', primaryMuscle: 'lats', secondaryMuscles: [] },

    // ---- Upper back / traps ----
    { name: 'Shrug', primaryMuscle: 'upper_back', secondaryMuscles: ['forearms'] },
    { name: 'Dumbbell Shrug', primaryMuscle: 'upper_back', secondaryMuscles: ['forearms'] },
    { name: 'Rack Pull', primaryMuscle: 'upper_back', secondaryMuscles: ['lats', 'lower_back'] },

    // ---- Biceps ----
    { name: 'Barbell Curl', primaryMuscle: 'biceps', secondaryMuscles: ['forearms'] },
    { name: 'Dumbbell Curl', primaryMuscle: 'biceps', secondaryMuscles: ['forearms'] },
    { name: 'Hammer Curl', primaryMuscle: 'biceps', secondaryMuscles: ['forearms'] },
    { name: 'Preacher Curl', primaryMuscle: 'biceps', secondaryMuscles: [] },
    { name: 'Incline Dumbbell Curl', primaryMuscle: 'biceps', secondaryMuscles: [] },
    { name: 'Cable Curl', primaryMuscle: 'biceps', secondaryMuscles: ['forearms'] },

    // ---- Forearms ----
    { name: 'Wrist Curl', primaryMuscle: 'forearms', secondaryMuscles: [] },
    { name: 'Reverse Curl', primaryMuscle: 'forearms', secondaryMuscles: ['biceps'] },
    { name: 'Farmers Walk', primaryMuscle: 'forearms', secondaryMuscles: ['upper_back'] },

    // ---- Quads ----
    { name: 'Back Squat', primaryMuscle: 'quads', secondaryMuscles: ['glutes'] },
    { name: 'Front Squat', primaryMuscle: 'quads', secondaryMuscles: ['glutes'] },
    { name: 'Goblet Squat', primaryMuscle: 'quads', secondaryMuscles: ['glutes'] },
    { name: 'Hack Squat', primaryMuscle: 'quads', secondaryMuscles: ['glutes'] },
    { name: 'Leg Press', primaryMuscle: 'quads', secondaryMuscles: ['glutes'] },
    { name: 'Leg Extension', primaryMuscle: 'quads', secondaryMuscles: [] },
    { name: 'Walking Lunge', primaryMuscle: 'quads', secondaryMuscles: ['glutes'] },
    { name: 'Bulgarian Split Squat', primaryMuscle: 'quads', secondaryMuscles: ['glutes'] },
    { name: 'Step-Up', primaryMuscle: 'quads', secondaryMuscles: ['glutes'] },

    // ---- Hamstrings ----
    { name: 'Deadlift', primaryMuscle: 'hamstrings', secondaryMuscles: ['glutes', 'lower_back', 'lats'] },
    { name: 'Romanian Deadlift', primaryMuscle: 'hamstrings', secondaryMuscles: ['glutes'] },
    { name: 'Stiff-Legged Deadlift', primaryMuscle: 'hamstrings', secondaryMuscles: ['glutes', 'lower_back'] },
    { name: 'Leg Curl', primaryMuscle: 'hamstrings', secondaryMuscles: [] },
    { name: 'Seated Leg Curl', primaryMuscle: 'hamstrings', secondaryMuscles: [] },
    { name: 'Good Morning', primaryMuscle: 'hamstrings', secondaryMuscles: ['glutes', 'lower_back'] },
    { name: 'Nordic Curl', primaryMuscle: 'hamstrings', secondaryMuscles: [] },

    // ---- Glutes ----
    { name: 'Hip Thrust', primaryMuscle: 'glutes', secondaryMuscles: ['hamstrings'] },
    { name: 'Glute Bridge', primaryMuscle: 'glutes', secondaryMuscles: ['hamstrings'] },
    { name: 'Cable Glute Kickback', primaryMuscle: 'glutes', secondaryMuscles: ['hamstrings'] },
    { name: 'Hip Abduction Machine', primaryMuscle: 'glutes', secondaryMuscles: [] },

    // ---- Calves ----
    { name: 'Calf Raise', primaryMuscle: 'calves', secondaryMuscles: [] },
    { name: 'Seated Calf Raise', primaryMuscle: 'calves', secondaryMuscles: [] },
    { name: 'Leg Press Calf Raise', primaryMuscle: 'calves', secondaryMuscles: [] },

    // ---- Adductors ----
    { name: 'Hip Adduction Machine', primaryMuscle: 'adductors', secondaryMuscles: [] },
    { name: 'Copenhagen Plank', primaryMuscle: 'adductors', secondaryMuscles: ['abs'] },
    { name: 'Cable Hip Adduction', primaryMuscle: 'adductors', secondaryMuscles: [] },

    // ---- Abs / core ----
    { name: 'Plank', primaryMuscle: 'abs', secondaryMuscles: [] },
    { name: 'Side Plank', primaryMuscle: 'abs', secondaryMuscles: [] },
    { name: 'Crunch', primaryMuscle: 'abs', secondaryMuscles: [] },
    { name: 'Cable Crunch', primaryMuscle: 'abs', secondaryMuscles: [] },
    { name: 'Hanging Leg Raise', primaryMuscle: 'abs', secondaryMuscles: [] },
    { name: 'Ab Wheel Rollout', primaryMuscle: 'abs', secondaryMuscles: ['lower_back'] },
    { name: 'Pallof Press', primaryMuscle: 'abs', secondaryMuscles: [] },
    { name: 'Russian Twist', primaryMuscle: 'abs', secondaryMuscles: [] },
    { name: 'Dead Bug', primaryMuscle: 'abs', secondaryMuscles: [] },

    // ---- Lower back ----
    { name: 'Back Extension', primaryMuscle: 'lower_back', secondaryMuscles: ['glutes', 'hamstrings'] },
    { name: 'Reverse Hyperextension', primaryMuscle: 'lower_back', secondaryMuscles: ['glutes'] },
    { name: 'Superman', primaryMuscle: 'lower_back', secondaryMuscles: ['glutes'] }
  ];

  // Canonical storage unit for every weight value in the database is
  // kilograms, always — see "Weight unit (display only)" below. This is the
  // exact lb<->kg conversion factor (1 lb = 0.45359237 kg).
  const KG_PER_LB = 0.45359237;
