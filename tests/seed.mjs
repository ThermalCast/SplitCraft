// Test-only demo data seeder.
//
// Used to live in the shipping app as `seedDemoData()` (TEMP DEMO SEEDING,
// gated behind ?seed=demo) purely so the test suites could call it. It never
// belonged in the shipped file — it's fixture data for exercising the UI and
// progression paths, not a feature — so it lives here instead and drives the
// app entirely through its own sandboxed functions (`app.getAllRecords`,
// `app.addRecord`, `app.setSetting`), the same surface a real caller would
// use.
//
// Populates ~3 weeks of fake workout history + a matching plan, for
// exercising render paths and progression logic against real data shapes.
export async function seedDemoData(app) {
  const exercises = await app.getAllRecords('exercises');
  const byName = (name) => {
    const ex = exercises.find(e => e.name === name);
    if (!ex) throw new Error(`Exercise not found: ${name}`);
    return ex;
  };
  function dateAt(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(18, 0, 0, 0);
    return d;
  }
  function dateStrOf(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const DAY_TYPES = {
    Push: [
      { name: 'Barbell Bench Press', targetSets: 3, repRangeMin: 8, repRangeMax: 12, occurrences: [
        { weight: 60, reps: [8, 8, 7] }, { weight: 62.5, reps: [8, 7, 7] }, { weight: 62.5, reps: [9, 8, 8] }
      ]},
      { name: 'Overhead Press', targetSets: 3, repRangeMin: 8, repRangeMax: 12, occurrences: [
        { weight: 40, reps: [8, 7, 7] }, { weight: 40, reps: [9, 8, 7] }, { weight: 42.5, reps: [8, 7, 7] }
      ]},
      { name: 'Triceps Pushdown', targetSets: 2, repRangeMin: 10, repRangeMax: 15, occurrences: [
        { weight: 25, reps: [12, 11] }, { weight: 27.5, reps: [11, 10] }, { weight: 27.5, reps: [12, 11] }
      ]}
    ],
    Pull: [
      { name: 'Barbell Row', targetSets: 3, repRangeMin: 8, repRangeMax: 12, occurrences: [
        { weight: 50, reps: [8, 8, 7] }, { weight: 52.5, reps: [8, 7, 7] }, { weight: 52.5, reps: [9, 8, 7] }
      ]},
      { name: 'Lat Pulldown', targetSets: 3, repRangeMin: 8, repRangeMax: 12, occurrences: [
        { weight: 45, reps: [10, 9, 9] }, { weight: 47.5, reps: [9, 9, 8] }, { weight: 47.5, reps: [10, 9, 9] }
      ]},
      { name: 'Barbell Curl', targetSets: 2, repRangeMin: 8, repRangeMax: 12, occurrences: [
        { weight: 20, reps: [10, 9] }, { weight: 20, reps: [11, 10] }, { weight: 22.5, reps: [12, 12] }
      ]}
    ],
    Legs: [
      { name: 'Back Squat', targetSets: 3, repRangeMin: 6, repRangeMax: 10, occurrences: [
        { weight: 80, reps: [8, 8, 7] }, { weight: 85, reps: [8, 7, 7] }
      ]},
      { name: 'Romanian Deadlift', targetSets: 2, repRangeMin: 8, repRangeMax: 12, occurrences: [
        { weight: 70, reps: [10, 9] }, { weight: 72.5, reps: [9, 9] }
      ]},
      { name: 'Calf Raise', targetSets: 2, repRangeMin: 12, repRangeMax: 15, occurrences: [
        { weight: 60, reps: [15, 14] }, { weight: 65, reps: [14, 13] }
      ]}
    ],
    Upper: [
      { name: 'Incline Dumbbell Press', targetSets: 3, repRangeMin: 8, repRangeMax: 12, occurrences: [
        { weight: 24, reps: [10, 9, 9] }, { weight: 26, reps: [9, 8, 8] }
      ]},
      { name: 'Seated Cable Row', targetSets: 2, repRangeMin: 8, repRangeMax: 12, occurrences: [
        { weight: 55, reps: [10, 9] }, { weight: 57.5, reps: [9, 9] }
      ]},
      { name: 'Lateral Raise', targetSets: 2, repRangeMin: 10, repRangeMax: 13, occurrences: [
        { weight: 10, reps: [14, 13] }, { weight: 12, reps: [12, 11] }
      ]}
    ]
  };
  const SESSIONS = [
    [20, 'Push'], [18, 'Pull'], [16, 'Legs'], [14, 'Upper'],
    [11, 'Push'], [9, 'Pull'], [7, 'Legs'], [5, 'Upper'],
    [3, 'Push'], [1, 'Pull']
  ];
  const occurrenceCount = { Push: 0, Pull: 0, Legs: 0, Upper: 0 };

  const plan = {
    createdAt: dateAt(20).getTime(),
    goal: 'Hypertrophy', daysPerWeek: 4, equipment: 'Full commercial gym', notes: '',
    days: ['Push', 'Pull', 'Legs', 'Upper'].map(type => ({
      name: `${type} Day`,
      exercises: DAY_TYPES[type].map(ex => ({
        exerciseId: byName(ex.name).id, name: ex.name,
        targetSets: ex.targetSets, repRangeMin: ex.repRangeMin, repRangeMax: ex.repRangeMax
      }))
    }))
  };
  const planId = await app.addRecord('plans', plan);

  for (const [daysAgo, type] of SESSIONS) {
    const idx = occurrenceCount[type]++;
    const dayIndex = ['Push', 'Pull', 'Legs', 'Upper'].indexOf(type);
    const base = dateAt(daysAgo);
    const workout = { date: dateStrOf(base), ts: base.getTime(), planId, dayIndex, dayName: `${type} Day`, exercises: [] };
    let minuteOffset = 0;
    for (const ex of DAY_TYPES[type]) {
      const occ = ex.occurrences[Math.min(idx, ex.occurrences.length - 1)];
      const exRecord = byName(ex.name);
      const sets = occ.reps.map(reps => {
        minuteOffset += 3;
        return { ts: base.getTime() + minuteOffset * 60000, type: 'standard', entries: [{ weight: occ.weight, reps }] };
      });
      workout.exercises.push({ exerciseId: exRecord.id, sets });
    }
    await app.addRecord('workouts', workout);
  }

  await app.setSetting('planDaysPerWeek', 4);
  await app.setSetting('planSplitType', 'ppl_upper_lower');
  console.log('Demo data seeded: 1 plan, 10 past workouts. Today left empty.');
}
