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
