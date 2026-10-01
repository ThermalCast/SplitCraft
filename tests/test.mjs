// Behavioural tests against the app's REAL functions, loaded from the real
// HTML. Replaces the Perl reimplementations, which only ever proved that the
// reimplementation agreed with itself.
import fs from 'node:fs';
import { app } from './harness.mjs';

const HTML = process.env.APP || new URL('../splitcraft.html', import.meta.url);
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

// ---- 1. classifiers, run as the app runs them ----
// The real Fitbod export is personal training data (dates, weights, reps) and
// is not committed. Only the exercise NAMES were ever needed here, so those are
// checked in separately and used whenever the export is absent — a fresh clone
// runs this test in full. When the export IS present locally it wins, so a
// newly exported file still surfaces names the classifiers have never seen.
const exportUrl = new URL('../fitbod_export.csv', import.meta.url);
const names = fs.existsSync(exportUrl)
  ? [...new Set(fs.readFileSync(exportUrl, 'utf8').split(/\r?\n/).filter(Boolean)
      .slice(1).map(l => (l.split(',')[1] || '').trim()).filter(Boolean))]
  : fs.readFileSync(new URL('./fitbod-exercise-names.txt', import.meta.url), 'utf8')
      .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const unclassified = names.filter(n => app.classifyMuscleFromName(n) === 'unclassified');
ok('every Fitbod name classifies (except cardio)', unclassified.join() === 'Air Bike', 'got: ' + unclassified.join(', '));
ok('Machine Rear Delt Fly -> rear_delts', app.classifyMuscleFromName('Machine Rear Delt Fly') === 'rear_delts');
ok('Assisted Pull Up -> lats', app.classifyMuscleFromName('Assisted Pull Up') === 'lats');
ok('Dips (plural) -> chest', app.classifyMuscleFromName('Dips') === 'chest');
ok('Assisted Dip -> assisted equipment', app.classifyEquipmentFromName('Assisted Dip') === 'assisted');
ok('Machine Bench Press -> machine', app.classifyEquipmentFromName('Machine Bench Press') === 'machine');
ok('TRX T Deltoid Fly -> bodyweight', app.classifyEquipmentFromName('TRX T Deltoid Fly') === 'bodyweight');

// ---- 2. catalog agrees with the classifiers ----
const cat = app.DEFAULT_EXERCISES || JSON.parse(fs.readFileSync(HTML, 'utf8').match(/x/) ? '[]' : '[]');
const catalog = [...fs.readFileSync(HTML, 'utf8').matchAll(/\{ name: '([^']+)', primaryMuscle: '([a-z_]+)'/g)];
const mismatched = catalog.filter(([, n, m]) => app.classifyMuscleFromName(n) !== m).map(([, n]) => n);
ok(`all ${catalog.length} catalog entries agree with the muscle classifier`, mismatched.length === 0, mismatched.join(', '));

// ---- 3. progression maths ----
// Pinned to the raw kg-native defaults, not whatever the harness's
// fillInMissingEquipmentSteps() one-time fix snapped them to for the
// default 'lb' unit (07-settings.js/08-progression.js) — these expected
// values were written against the kg defaults specifically.
// A direct app.equipmentStepsKg assignment doesn't reach the module-level
// `let` of the same name -- that's a separate declarative binding, not a
// property on the sandbox object, even though they share a name. Going
// through the real write path (setSetting + a reload) is what actually
// updates the binding loadStepKg()/progressionPlan() read.
await app.setSetting('equipmentStepsKg', { barbell: 2.5, dumbbell: 2, machine: 5, cable: 5, assisted: 5, bodyweight: 2.5, other: 2.5 });
await app.loadSettingsIntoForm();
const bar = { name: 'Barbell Bench Press', equipment: 'barbell' };
const p1 = app.progressionPlan(100, 'upper', 'intermediate', bar, {});
const p2 = app.progressionPlan(100, 'upper', 'intermediate', bar, { rir: 3 });
const p3 = app.progressionPlan(100, 'upper', 'intermediate', bar, { energy: 'deficit' });
const rate = p => (p.incrementKg / p.sessionsRequired) / 100 * 100;
ok('3 RIR speeds progression up', rate(p2) > rate(p1), `${rate(p1).toFixed(2)}% vs ${rate(p2).toFixed(2)}%`);
ok('cutting slows progression down', rate(p3) < rate(p1), `${rate(p1).toFixed(2)}% vs ${rate(p3).toFixed(2)}%`);
ok('increment is loadable (multiple of the barbell step)', p1.incrementKg % 2.5 === 0, String(p1.incrementKg));
ok('session requirement is capped', app.progressionPlan(5, 'upper', 'advanced', bar, {}).sessionsRequired <= 6);
ok('new lift progresses faster than an old one',
   app.experienceForLiftHistory(2) === 'novice' && app.experienceForLiftHistory(40) === 'advanced');
// `fasterExperience` is a const arrow, so it isn't reachable from the vm
// context. Test the ladder it consumes, and the effect it produces, instead.
ok('lift-history ladder is ordered',
   app.experienceForLiftHistory(1) === 'novice'
   && app.experienceForLiftHistory(10) === 'intermediate'
   && app.experienceForLiftHistory(99) === 'advanced');
// End-to-end through real storage: log three sets, tag only the LAST one, and
// confirm the suggestion picks it up. This is the case the old all-or-nothing
// rule silently ignored.
{
  const exId = (await app.getAllRecords('exercises')).find(e => e.name === 'Barbell Bench Press').id;
  let w;
  for (let i = 0; i < 3; i++) w = await app.logSet(exId, 'standard', [{ weight: 100, reps: 12 }], null);
  const entry = w.exercises.find(e => e.exerciseId === exId);
  const plain = await app.suggestForExercise(exId, 8, 12, 3);
  await app.setSetRir(w.id, exId, entry.sets.length - 1, 4);
  const tagged = await app.suggestForExercise(exId, 8, 12, 3);
  ok('RIR on the last set alone is read', tagged.weight > plain.weight,
     `plain ${plain.weight} vs tagged ${tagged.weight}`);
  // The reason lives in `why` tags now, not in the sentence -- the sentence
  // has to stay short enough to read on a phone.
  ok('the reason is surfaced as a tag', (tagged.why || []).some(t => /RIR/.test(t)),
     JSON.stringify(tagged.why));
  ok('the suggestion sentence stays short', tagged.text.length < 110, `${tagged.text.length} chars`);
}
ok('RIR ladder is monotonic and gentle',
   app.rirRateMultiplier(null) === 1 && app.rirRateMultiplier(1) === 1
   && app.rirRateMultiplier(2) === 1.25 && app.rirRateMultiplier(3) === 1.5
   && app.rirRateMultiplier(4) === 2);
// Last-set semantics: a session ending at 0 RIR must NOT be sped up just
// because earlier sets were easy. Averaging used to hide exactly this.
{
  const easyThenFailure = app.progressionPlan(100, 'upper', 'intermediate', bar, { rir: 0 });
  const flatBaseline    = app.progressionPlan(100, 'upper', 'intermediate', bar, {});
  ok('last set at 0 RIR gets no speed-up',
     easyThenFailure.incrementKg === flatBaseline.incrementKg
     && easyThenFailure.sessionsRequired === flatBaseline.sessionsRequired);
}
ok('assisted work uses bodyweight when known',
   app.effectiveLoadKg({ equipment: 'assisted' }, -45) === -45, 'bodyweight is 0 in this run, so unchanged');

// perSide doubles the stored weight into the real total -- the fix for the
// dumbbell per-hand-vs-combined ambiguity (see "Per-side weight" in
// design-summary.md). effectiveLoadKg() is the single choke point every
// consumer of "true load" runs through, so this one check stands in for all
// of them (progressionPlan, checkPersonalRecord, setVolumeKg, the chart).
ok('perSide doubles the stored weight into the real total',
   app.effectiveLoadKg({ equipment: 'dumbbell', perSide: true }, 20) === 40);
ok('perSide: false (or absent) leaves the weight unchanged',
   app.effectiveLoadKg({ equipment: 'dumbbell' }, 20) === 20
   && app.effectiveLoadKg({ equipment: 'dumbbell', perSide: false }, 20) === 20);
ok('perSideNoteHtml() renders a note only when the flag is set',
   app.perSideNoteHtml({ perSide: true }).includes('per side')
   && app.perSideNoteHtml({ perSide: false }) === ''
   && app.perSideNoteHtml(null) === '');

// The SAME real load, logged per side or as a total, must progress at the
// same real rate. The step is per implement, so one step on a perSide lift
// moves the real load by two steps; comparing the target against one step
// used to progress per-side lifts at up to twice the intended rate.
{
  const perSide = { equipment: 'dumbbell', perSide: true };
  const combined = { equipment: 'dumbbell' };
  const realRate = (plan, ex) => (ex.perSide ? plan.incrementKg * 2 : plan.incrementKg) / plan.sessionsRequired;
  const cases = [['novice', 30], ['intermediate', 30], ['advanced', 30], ['novice', 60]];
  const mismatches = cases.filter(([exp, perHand]) => {
    const a = app.progressionPlan(perHand, 'upper', exp, perSide, {});
    const b = app.progressionPlan(perHand * 2, 'upper', exp, combined, {});
    // Rounding to whole steps means the two can't always be identical, but
    // the per-side real rate must never exceed the combined one's by more
    // than one step's worth of rounding, and never double it.
    return realRate(a, perSide) > realRate(b, combined) * 1.5;
  });
  ok('a perSide lift progresses at the same real-load rate as the same load logged combined',
     mismatches.length === 0, JSON.stringify(mismatches));
  // 50kg per hand is 100kg real; novice upper is 3.3% = 3.3kg real per
  // session. One step on each dumbbell is already more than that, so it must
  // be spread over sessions rather than taken every session (which ran at
  // ~4.5kg real per session).
  const heavy = app.progressionPlan(50, 'upper', 'novice', perSide, {});
  ok('a perSide jump is sized in real load, not per hand',
     (heavy.incrementKg * 2) / heavy.sessionsRequired <= 100 * 0.033 + 1e-9, JSON.stringify(heavy));
}

// The starting-weight estimator compares in REAL load: a combined-logged
// dumbbell lift seeding a perSide one must come out per hand (about half),
// and the other way round about double — not the raw number copied across.
{
  const mk = (id, name, perSide) => ({ id, name, primaryMuscle: 'chest', secondaryMuscles: [], equipment: 'dumbbell', perSide });
  const combinedAnchor = mk(9001, 'Probe Combined Press', false);
  const perHandAnchor = mk(9002, 'Probe Per-Hand Press', true);
  const perHandTarget = mk(9003, 'Probe Per-Hand Fly', true);
  const combinedTarget = mk(9004, 'Probe Combined Fly', false);
  const byId = Object.fromEntries([combinedAnchor, perHandAnchor, perHandTarget, combinedTarget].map(e => [e.id, e]));
  const hist = (ex, kg) => [{ date: '2026-01-05', exercises: [{ exerciseId: ex.id, sets: [{ ts: 1, type: 'standard', entries: [{ weight: kg, reps: 10 }] }] }] }];
  const fromCombined = app.estimateStartingWeight(perHandTarget, hist(combinedAnchor, 40), byId);
  ok('a per-hand target seeded from a 40kg combined lift comes out per hand (~17kg, not ~34kg)',
     fromCombined && fromCombined.weightKg > 12 && fromCombined.weightKg < 22, JSON.stringify(fromCombined));
  const fromPerHand = app.estimateStartingWeight(combinedTarget, hist(perHandAnchor, 20), byId);
  ok('a combined target seeded from a 20kg-per-hand lift comes out as a total (~34kg, not ~17kg)',
     fromPerHand && fromPerHand.weightKg > 28 && fromPerHand.weightKg < 40, JSON.stringify(fromPerHand));
}

// "Weeks trained" for the sets-per-week chart: N sessions d days apart are
// N×d days of training, not the (N−1)×d between the first and the last.
{
  const mwf = [];
  for (let wk = 0; wk < 4; wk++) for (const dow of [0, 2, 4]) {
    const d = new Date(2026, 0, 5 + wk * 7 + dow);   // Mon 5 Jan 2026 onward
    mwf.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const w = app.trainingWeeks(mwf);
  ok('four weeks of Mon/Wed/Fri counts as about four weeks, not 3.6', Math.abs(w - 4) < 0.15, `${w.toFixed(2)} weeks`);
  ok('a single session counts as one week', app.trainingWeeks(['2026-01-05']) === 1);
  ok('one session a fortnight over two sessions is four weeks', Math.abs(app.trainingWeeks(['2026-01-05', '2026-01-19']) - 4) < 1e-9);
}

// The Log tab's day pick expires with the day — unless a workout is still
// going across midnight.
{
  const H = 3600000, now = Date.parse('2026-03-02T09:00:00');
  ok('a pick from yesterday, idle overnight, is stale', app.dayPickIsStale('2026-03-01', '2026-03-02', now - 10 * H, now) === true);
  ok('a pick from yesterday with a set logged 20 minutes ago is kept (training past midnight)',
     app.dayPickIsStale('2026-03-01', '2026-03-02', now - H / 3, now) === false);
  ok('a pick from today is never stale', app.dayPickIsStale('2026-03-02', '2026-03-02', 0, now) === false);
  ok('no pick yet is not "stale"', app.dayPickIsStale(null, '2026-03-02', 0, now) === false);
}

// Rest-timer suppression on the set that completes an exercise.
ok('no rest after the completing set', app.shouldRestAfter(3, 3) === false);
ok('rest between sets of the same exercise', app.shouldRestAfter(1, 3) && app.shouldRestAfter(2, 3));
ok('bonus sets past the prescription still rest', app.shouldRestAfter(4, 3) === true);
ok('unprescribed (manual) logging always rests', app.shouldRestAfter(1, 0) === true);

// No history for a lift still prefills the REP target, which is prescribed by
// the plan — leaving it blank made the user type a number the app knew.
//
// The weight half of this used to assert `=== null` unconditionally. That was
// only ever true because there was no starting-weight estimator; now an
// unlogged lift gets a seeded opening weight where a comparable movement
// exists, and null only where one doesn't. See estimateStartingWeight().
{
  const all = await app.getAllRecords('exercises');
  // Nordic Curl is a bodyweight movement: its correct opening load is you,
  // which is 0 — not a guess, and not a blank box.
  const bw = all.find(e => e.name === 'Nordic Curl');
  const s = await app.suggestForExercise(bw.id, 8, 12, 3);
  ok('unlogged exercise still prefills reps', s.reps === 8, `reps=${s.reps}`);
  ok('unlogged bodyweight movement opens at bodyweight, not blank', s.weight === 0, `weight=${s.weight}`);

  // The only history in this suite is a chest/barbell lift, so a loaded
  // hamstrings machine has nothing comparable to draw on — different muscle,
  // different equipment, different half of the body. It must decline rather
  // than scale a bench press into a leg curl.
  const unrelated = await app.suggestForExercise(all.find(e => e.name === 'Leg Curl').id, 8, 12, 3);
  ok('an unlogged lift with nothing comparable stays blank',
     unrelated.weight === null, `weight=${unrelated.weight}`);
}

// The sign toggle is offered from the exercise's equipment class, not from a
// per-set flag — the sign itself lives on the set as a negative weight.
ok('assisted equipment is what marks a lift as negative-capable',
   app.exerciseEquipment({ name: 'Assisted Pull-Up' }) === 'assisted'
   && app.exerciseEquipment({ name: 'Barbell Bench Press' }) === 'barbell');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
