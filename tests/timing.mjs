// The two failure modes the other suites structurally cannot see: overlapping
// writes, and real elapsed time.
//
// ui.mjs fires every handler, but strictly one at a time and to completion, so
// a read-modify-write race never opens. And the harness stubs setInterval to a
// no-op, so anything that counts ticks looks perfect while anything that reads
// a clock is never exercised at all. Both of the bugs below shipped, passed
// all three suites, and only showed up on a real phone.
import { app } from './harness.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---------------------------------------------------------------------------
// Serialised workout writes.
//
// Reintroduce the bug by removing withWorkoutLock() from logSet and this fails
// with "2 records / 2 sets": both calls read the pre-write state, both take the
// "no workout for today yet" branch, and both create a record. Because the
// `date` index is not unique, getWorkoutForDate() then only ever finds the
// first, so the second day's sets are invisible in the app but present in the
// store.
// ---------------------------------------------------------------------------
const exercises = await app.getAllRecords('exercises');
const bench = exercises.find(e => e.name === 'Barbell Bench Press');

await Promise.all([
  app.logSet(bench.id, 'standard', [{ weight: 60, reps: 8 }], null),
  app.logSet(bench.id, 'standard', [{ weight: 60, reps: 7 }], null),
  app.logSet(bench.id, 'standard', [{ weight: 60, reps: 6 }], null),
]);

const today = app.todayStr();
const todayRecords = (await app.getAllRecords('workouts')).filter(w => w.date === today);
const setCount = todayRecords.reduce(
  (a, w) => a + w.exercises.reduce((b, e) => b + e.sets.length, 0), 0);

check('three concurrent logSet calls write ONE workout record',
  todayRecords.length === 1, `got ${todayRecords.length}`);
check('three concurrent logSet calls keep all three sets',
  setCount === 3, `got ${setCount}`);

// A mixed burst: the set-count override and the swap contend for the same
// record as logSet does, so they have to share the same queue.
await Promise.all([
  app.logSet(bench.id, 'standard', [{ weight: 62.5, reps: 5 }], null),
  app.adjustTodayTargetSets(bench.id, 3, 1),
  app.setSessionSwap(bench.id, bench.id + 1),
]);
const after = (await app.getAllRecords('workouts')).filter(w => w.date === today);
check('mixed concurrent mutations stay on one record',
  after.length === 1, `got ${after.length}`);
check('a concurrent override is not lost to a concurrent log',
  !!(after[0] && after[0].targetOverrides && after[0].targetOverrides[bench.id] === 4),
  JSON.stringify(after[0] && after[0].targetOverrides));
check('a concurrent swap is not lost to a concurrent log',
  !!(after[0] && after[0].exerciseSwaps && after[0].exerciseSwaps[bench.id] === bench.id + 1),
  JSON.stringify(after[0] && after[0].exerciseSwaps));

// ---------------------------------------------------------------------------
// The rest timer reads a clock rather than counting ticks.
//
// setInterval is stubbed to a no-op here, which is exactly the situation a
// backgrounded tab or a locked iOS screen creates: the callback simply is not
// delivered. A tick-counting timer therefore still reads its starting value.
// ---------------------------------------------------------------------------
const display = app.document.getElementById('timer-display');

await app.startTimer(90);
check('timer starts at the requested length', display.textContent === '1:30', display.textContent);

await sleep(2100);
app.timerTick();
check('timer follows real elapsed time with ZERO ticks delivered',
  display.textContent === '1:28', `${display.textContent} (tick-counting would say 1:30)`);

await app.startTimer(2);
await sleep(2200);
app.timerTick();
check('an expired rest reads 0:00', display.textContent === '0:00', display.textContent);

await app.startTimer(30);
app.adjustTimer(15);
await sleep(1100);
app.timerTick();
check('+15s moves the deadline, not just the label',
  display.textContent === '0:44', display.textContent);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
