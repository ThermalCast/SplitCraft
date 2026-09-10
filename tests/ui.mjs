// Seeds real data, re-renders, then fires every handler the render paths left
// behind. This is the only check that reaches the click/change handlers --
// the wrong-variable bugs live there and throw only when the handler runs.
//
// Render functions used to leave `.onclick`/`.onchange` PROPERTIES on stub
// elements, which the loop below fired directly. They now wire ONE listener
// per container via delegate() (03-helpers.js) against a registry of named
// `data-action` handlers instead — see design-summary.md, "Event wiring".
// That means most containers have nothing left for the loop below to find:
// the interesting half now lives in the registries exposed by
// app.actionRegistries() (12-init.js), so this suite calls every named
// handler directly with a stub element instead, the same "give a plausible
// value" approach the loop below already used for onclick/onchange.
import { app, allEls, errors, listeners } from './harness.mjs';
import { seedDemoData } from './seed.mjs';

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ' — ' + detail : ''}`); }
}

await seedDemoData(app);
await app.refreshLogAndHistory();
await app.refreshPlanTab();
await app.renderExerciseManager();
// panel-exercises' whole content is this one render — a stand-in for
// "every tab renders without throwing" now that the exercise list has its
// own tab instead of living inside Settings.
check('panel-exercises (renderExerciseManager) rendered without throwing',
  typeof app.document.getElementById('exercise-manager-list').innerHTML === 'string'
  && app.document.getElementById('exercise-manager-list').innerHTML.length > 0);

// Handlers guard on `isNaN(parseFloat(input.value))` and bail early, so an
// empty stub input means the interesting half of the handler never runs.
// Give everything a plausible number first.
for (const el of allEls) if (el.value === '') el.value = '10';

let fired = 0, failedHandlers = 0;
for (const el of allEls.slice()) {
  for (const h of ['onclick', 'onchange', 'oninput']) {
    if (typeof el[h] !== 'function') continue;
    fired++;
    try { await el[h]({ preventDefault(){}, target: el, stopPropagation(){} }); }
    catch (e) { failedHandlers++; console.log(`  FAIL ${h} on ${el.id}: ${e.message}`); }
  }
}
await new Promise(r => setTimeout(r, 300));
for (const e of errors) { if (/handler|Rejection/.test(e)) { failedHandlers++; console.log('  FAIL ' + e.split('\n')[0]); } }
console.log(`\nhandlers fired (onclick/onchange/oninput properties): ${fired}, failures: ${failedHandlers}`);

// ---------------------------------------------------------------------------
// delegate() itself — wired once per container/event-type, and an action
// name absent from the registry is ignored rather than throwing. Built with
// hand-crafted fake elements (not harness stubs): the harness's own
// querySelectorAll/closest stubs return a FRESH element per call with no
// real parent/child links, which is fine for exercising render loops but
// can't stand in for "this click's target resolves to that data-action".
// ---------------------------------------------------------------------------
{
  const testContainer = app.document.getElementById('__delegate_test__');
  let calls = 0;
  const actions = { 'known': () => { calls++; } };
  app.delegate(testContainer, 'click', actions);
  app.delegate(testContainer, 'click', actions); // second call must be a no-op (guarded)

  const wired = listeners.get('__delegate_test__');
  check('delegate() wires a container once',
    !!wired && typeof wired.click === 'function' && Object.keys(wired).length === 1);

  const knownEl = { dataset: { action: 'known' } };
  knownEl.closest = () => knownEl;
  await wired.click({ target: knownEl });
  check('a known action is invoked when its element is the event target', calls === 1);

  const unknownEl = { dataset: { action: 'nope-not-registered' } };
  unknownEl.closest = () => unknownEl;
  await wired.click({ target: unknownEl });
  check('an action outside the registry is ignored (no throw, handler not called)', calls === 1);
}

// ---------------------------------------------------------------------------
// Every delegated-action registry, fired directly with a stub element.
//
// One shared stub shape (actionStub) covers every action: a generous
// dataset (exercise/workout ids, indices, deltas, plan ids — the "stub
// inputs need values" rule from tests/README.md, extended to data-*), a
// self-referential closest() (an action's `.closest('.foo')` is looking for
// an ancestor row/group that, for a stub built to represent exactly that
// row/group, IS the element doing the finding), and a querySelector() that
// hands back a fresh child stub per selector — the same "one stub per
// selector" idea the harness itself uses for querySelectorAll.
// ---------------------------------------------------------------------------
const registries = app.actionRegistries();
const exercises = await app.getAllRecords('exercises');
const plan = await app.getCurrentPlan();
const today = app.todayStr();
const day0 = plan.days[0];
const dayExId = day0.exercises[0].exerciseId;
const otherExId = exercises.find(e => e.id !== dayExId).id;

function actionStub(datasetOverrides = {}, valueOverride) {
  const classes = new Set();
  const el = {
    value: valueOverride !== undefined ? valueOverride : '65',
    disabled: false,
    style: {},
    dataset: Object.assign({
      exid: String(dayExId), origExid: String(dayExId), idx: '0',
      wid: '', kg: '60', delta: '1', planTarget: '3',
      planid: String(plan.id), dayidx: '0', field: 'weight', rendered: '',
    }, datasetOverrides),
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, force) => { const on = force !== undefined ? force : !classes.has(c); on ? classes.add(c) : classes.delete(c); return on; },
    },
    setAttribute() {}, getAttribute() { return null; },
    querySelectorAll() { return []; },
    dispatchEvent() { return true; },
  };
  const children = {};
  el.querySelector = (sel) => { if (!children[sel]) children[sel] = actionStub(datasetOverrides); return children[sel]; };
  el.closest = () => el;
  return el;
}
// Wires a sign-btn <-> weight-input sibling pair, the DOM contract
// TOGGLE_SIGN_ACTIONS and the sync actions both rely on.
function signPair(weightValue) {
  const btn = actionStub();
  btn.classList.add('sign-btn');
  const input = actionStub({}, String(weightValue));
  btn.nextElementSibling = input;
  input.previousElementSibling = btn;
  return { btn, input };
}

async function logFreshSet(exerciseId, weight = 60, reps = 8) {
  const workout = await app.logSet(exerciseId, 'standard', [{ weight, reps }], { planId: plan.id, dayIndex: 0, dayName: day0.name });
  const entry = workout.exercises.find(e => e.exerciseId === exerciseId);
  return { workout, idx: entry.sets.length - 1 };
}

let actionsFired = 0, actionsFailed = 0;
async function fireAction(label, fn) {
  actionsFired++;
  try { await fn(); }
  catch (e) { actionsFailed++; console.log(`  FAIL action ${label}: ${e.message}`); }
}

// --- ENTRY_ROW_ACTIONS / ENTRY_ROW_INPUT_ACTIONS (03-helpers.js) ----------
// sync-entry before remove-entry: remove-entry splices `currentEntries`
// (module-level state, shared with the real app), so it must run last.
await fireAction('sync-entry', () => registries.ENTRY_ROW_INPUT_ACTIONS['sync-entry'](actionStub({ idx: '0', field: 'weight' }, '42')));
{
  const { btn, input } = signPair(60);
  await fireAction('toggle-sign (entry row)', () => registries.ENTRY_ROW_ACTIONS['toggle-sign'](btn));
  check('toggle-sign negates the weight input and marks the button negative',
    Number(input.value) === -60 && btn.classList.contains('negative'));
}
await fireAction('remove-entry', () => registries.ENTRY_ROW_ACTIONS['remove-entry'](actionStub({ idx: '0' })));

// --- HISTORY_* (05-history.js) — a PAST day's workout, so it's independent
// of the "today" workout the WORKOUT_* actions below also mutate. ----------
{
  const workouts = await app.getAllWorkouts();
  const pastWorkout = workouts.find(w => w.date !== today);
  const pastEntry = pastWorkout.exercises.find(e => e.sets.length > 0);
  const beforeCount = pastEntry.sets.length;

  const editRow = actionStub({ wid: String(pastWorkout.id), exid: String(pastEntry.exerciseId), idx: '0', kg: String(pastEntry.sets[0].entries[0].weight) });
  editRow.querySelector = (sel) => {
    if (sel === '.set-edit-weight') return actionStub({}, '77');
    if (sel === '.set-edit-reps') return actionStub({}, '9');
    return actionStub();
  };
  const editEl = actionStub();
  editEl.closest = () => editRow;
  await fireAction('HISTORY edit-set', () => registries.HISTORY_CHANGE_ACTIONS['edit-set'](editEl));
  const afterEdit = (await app.getAllWorkouts()).find(w => w.id === pastWorkout.id);
  const editedEntry = afterEdit.exercises.find(e => e.exerciseId === pastEntry.exerciseId);
  check('HISTORY edit-set actually rewrote the set',
    editedEntry.sets[0].entries[0].reps === 9, JSON.stringify(editedEntry.sets[0]));

  await fireAction('HISTORY delete-set', () => registries.HISTORY_CLICK_ACTIONS['delete-set'](
    actionStub({ wid: String(pastWorkout.id), exid: String(pastEntry.exerciseId), idx: '0' })
  ));
  const afterDelete = (await app.getAllWorkouts()).find(w => w.id === pastWorkout.id);
  const deletedEntry = afterDelete ? afterDelete.exercises.find(e => e.exerciseId === pastEntry.exerciseId) : null;
  check('HISTORY delete-set actually removed a set',
    (deletedEntry ? deletedEntry.sets.length : 0) === beforeCount - 1);
}
await fireAction('HISTORY load-more', () => registries.HISTORY_CLICK_ACTIONS['load-more'](actionStub()));
{
  const { btn, input } = signPair(-30);
  await fireAction('HISTORY toggle-sign', () => registries.HISTORY_CLICK_ACTIONS['toggle-sign'](btn));
  check('HISTORY toggle-sign un-negates and clears the negative class',
    Number(input.value) === 30 && !btn.classList.contains('negative'));
}
{
  const { input } = signPair(-15);
  registries.HISTORY_INPUT_ACTIONS['edit-set'](input); // cosmetic sync only, must not throw
}

// --- EXERCISE_MANAGER_* (06-catalog-import-backup.js) ----------------------
await fireAction('expand-exercise', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['expand-exercise'](actionStub({ exid: String(otherExId) })));
await fireAction('set-muscle', () => registries.EXERCISE_MANAGER_CHANGE_ACTIONS['set-muscle'](actionStub({ exid: String(otherExId) }, 'calves')));
{
  const ex = await app.getRecord('exercises', otherExId);
  check('set-muscle actually changed the store', ex.primaryMuscle === 'calves' && ex.userEdited === true, ex.primaryMuscle);
}
await fireAction('set-equipment', () => registries.EXERCISE_MANAGER_CHANGE_ACTIONS['set-equipment'](actionStub({ exid: String(otherExId) }, 'dumbbell')));
{
  const ex = await app.getRecord('exercises', otherExId);
  check('set-equipment actually changed the store', ex.equipment === 'dumbbell', ex.equipment);
}
await fireAction('pin', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['pin'](actionStub({ exid: String(otherExId) })));
{
  const pref = await app.getExercisePref(otherExId);
  check('pin actually changed the store', pref && pref.pinned === true);
}
await fireAction('like', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['like'](actionStub({ exid: String(otherExId) })));
await fireAction('dislike', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['dislike'](actionStub({ exid: String(otherExId) })));

// --- WORKOUT_* (09-workout.js) — needs renderActiveWorkout's context; a
// refresh right before this block guarantees activeWorkoutCtx is current. --
await app.refreshLogAndHistory();
{
  // log-set: group carries target/exid; el (the Log button) needs sibling
  // .plan-log-weight/.plan-log-reps reachable via closest -> querySelector.
  const group = actionStub({ exid: String(dayExId), target: '3' });
  group.querySelector = (sel) => {
    if (sel === '.plan-log-weight') return actionStub({}, '65');
    if (sel === '.plan-log-reps') return actionStub({}, '8');
    return actionStub();
  };
  const logBtn = actionStub();
  logBtn.closest = () => group;
  const before = await app.getWorkoutForDate(today);
  const beforeCount = before ? (before.exercises.find(e => e.exerciseId === dayExId) || { sets: [] }).sets.length : 0;
  await fireAction('log-set', () => registries.WORKOUT_CLICK_ACTIONS['log-set'](logBtn));
  const after = await app.getWorkoutForDate(today);
  const afterCount = after.exercises.find(e => e.exerciseId === dayExId).sets.length;
  check('log-set actually logged a set', afterCount === beforeCount + 1, `${beforeCount} -> ${afterCount}`);
}
await fireAction('toggle-exercise', () => registries.WORKOUT_CLICK_ACTIONS['toggle-exercise'](actionStub({ exid: String(dayExId) })));
{
  const { idx } = await logFreshSet(dayExId);
  const before = await app.getWorkoutForDate(today);
  const beforeCount = before.exercises.find(e => e.exerciseId === dayExId).sets.length;
  await fireAction('WORKOUT delete-set', () => registries.WORKOUT_CLICK_ACTIONS['delete-set'](actionStub({ exid: String(dayExId), idx: String(idx) })));
  const after = await app.getWorkoutForDate(today);
  const afterCount = after.exercises.find(e => e.exerciseId === dayExId).sets.length;
  check('WORKOUT delete-set actually removed a set', afterCount === beforeCount - 1, `${beforeCount} -> ${afterCount}`);
}
{
  const el = actionStub({ exid: String(dayExId) });
  el.style = {};
  const panel = actionStub();
  panel.style = {};
  el.querySelector = (sel) => sel === '.ex-history' ? panel : actionStub();
  await fireAction('show-history', () => registries.WORKOUT_CLICK_ACTIONS['show-history'](el));
  check('show-history rendered the history panel', typeof panel.innerHTML === 'string' && panel.dataset.rendered === 'yes');
}
{
  const group = actionStub({ exid: String(dayExId) });
  const picker = actionStub();
  picker.style = {};
  const sel = actionStub();
  picker.querySelector = () => sel;
  group.querySelector = (s) => s === '.swap-picker' ? picker : actionStub();
  await fireAction('swap-open', () => registries.WORKOUT_CLICK_ACTIONS['swap-open'](group));
}
{
  const { idx } = await logFreshSet(dayExId, 60, 8);
  const row = actionStub({ exid: String(dayExId), idx: String(idx), kg: '60' });
  row.querySelector = (sel) => {
    if (sel === '.set-edit-weight') return actionStub({}, '70');
    if (sel === '.set-edit-reps') return actionStub({}, '5');
    return actionStub();
  };
  const el = actionStub();
  el.closest = () => row;
  await fireAction('WORKOUT edit-set', () => registries.WORKOUT_CHANGE_ACTIONS['edit-set'](el));
  const after = await app.getWorkoutForDate(today);
  const entry = after.exercises.find(e => e.exerciseId === dayExId);
  check('WORKOUT edit-set actually rewrote the set', entry.sets[idx].entries[0].reps === 5);
}
await fireAction('swap-select', () => registries.WORKOUT_CHANGE_ACTIONS['swap-select'](
  actionStub({ origExid: String(dayExId), exid: String(dayExId) }, String(otherExId))
));
{
  const before = await app.getWorkoutForDate(today);
  const beforeOverride = before && before.targetOverrides ? before.targetOverrides[dayExId] : undefined;
  await fireAction('adjust-sets', () => registries.WORKOUT_CLICK_ACTIONS['adjust-sets'](
    actionStub({ exid: String(dayExId), delta: '1', planTarget: '3' })
  ));
  const after = await app.getWorkoutForDate(today);
  const afterOverride = after && after.targetOverrides ? after.targetOverrides[dayExId] : undefined;
  check('adjust-sets actually changed today\'s target override', afterOverride !== beforeOverride, `${beforeOverride} -> ${afterOverride}`);
}
{
  const { btn, input } = signPair(45);
  await fireAction('WORKOUT toggle-sign', () => registries.WORKOUT_CLICK_ACTIONS['toggle-sign'](btn));
  check('WORKOUT toggle-sign negates the weight input', Number(input.value) === -45);
}
{
  const { input } = signPair(-8);
  registries.WORKOUT_INPUT_ACTIONS['sync-sign'](input); // cosmetic, must not throw
}

// --- PLAN_DAY_* (11-plan.js) ------------------------------------------------
await app.refreshPlanTab();
{
  const group = actionStub({ exid: String(dayExId) });
  const picker = actionStub();
  picker.style = {};
  const sel = actionStub();
  picker.querySelector = () => sel;
  group.querySelector = (s) => s === '.swap-picker' ? picker : actionStub();
  await fireAction('plan-swap-open', () => registries.PLAN_DAY_CLICK_ACTIONS['plan-swap-open'](group));
}
{
  const group = actionStub({ exid: String(dayExId) });
  const el = actionStub({ planid: String(plan.id), dayidx: '0' }, String(otherExId));
  el.closest = () => group;
  await fireAction('plan-swap-select', () => registries.PLAN_DAY_CHANGE_ACTIONS['plan-swap-select'](el));
  const updatedPlan = await app.getRecord('plans', plan.id);
  const stillHasOld = updatedPlan.days[0].exercises.some(e => e.exerciseId === dayExId);
  check('plan-swap-select actually rewrote the plan day', !stillHasOld);
}

console.log(`\nregistry actions fired: ${actionsFired}, failures: ${actionsFailed}`);
console.log(`checks: ${passed} passed, ${failed} failed`);

process.exitCode = (failedHandlers || actionsFailed || failed) ? 1 : 0;
