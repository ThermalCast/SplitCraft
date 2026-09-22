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

// seedDemoData's most recent session (1 day ago) is Pull (dayIndex 1) on a
// 4-day Push/Pull/Legs/Upper plan, with nothing logged today — the day
// picker's default should rotate to Legs (dayIndex 2), not reset to day 0.
// Must run before anything below logs a set for today, which would give
// today its own dayIndex and short-circuit the rotation this is checking.
check('the day picker defaults to the day after the last one trained (Pull → Legs), not day 0',
  app.document.getElementById('log-day-picker').value === '2',
  app.document.getElementById('log-day-picker').value);

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

// --- DROPMYO_ROW_ACTIONS / DROPMYO_ROW_INPUT_ACTIONS (09-workout.js) ------
// sync-dropmyo-entry before remove-dropmyo-entry: remove splices
// `dropMyoEntries` (module-level state, shared with the real app), so it
// must run last.
await fireAction('sync-dropmyo-entry', () => registries.DROPMYO_ROW_INPUT_ACTIONS['sync-dropmyo-entry'](actionStub({ idx: '0', field: 'weight' }, '42')));
{
  const { btn, input } = signPair(60);
  await fireAction('toggle-sign (dropmyo row)', () => registries.DROPMYO_ROW_ACTIONS['toggle-sign'](btn));
  check('toggle-sign negates the weight input and marks the button negative',
    Number(input.value) === -60 && btn.classList.contains('negative'));
}
await fireAction('remove-dropmyo-entry', () => registries.DROPMYO_ROW_ACTIONS['remove-dropmyo-entry'](actionStub({ idx: '0' })));

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
await fireAction('toggle-per-side', () => {
  const stub = actionStub({ exid: String(otherExId) });
  stub.checked = true;
  return registries.EXERCISE_MANAGER_CHANGE_ACTIONS['toggle-per-side'](stub);
});
{
  const ex = await app.getRecord('exercises', otherExId);
  check('toggle-per-side actually changed the store', ex.perSide === true && ex.userEdited === true);
}
{
  // The reminder tag shows up wherever a weight gets typed for a perSide
  // exercise: the drop/myo modal (per-row createElement, so checked via the
  // row's own innerHTML, not the container's -- appendChild doesn't update
  // a stub's innerHTML) and the active-workout card (a single innerHTML
  // string, checked directly).
  await fireAction('open-drop-myo (per-side)', () => registries.WORKOUT_CLICK_ACTIONS['open-drop-myo'](actionStub({ exid: String(otherExId) })));
  const rows = app.document.getElementById('dropmyo-rows-container').children;
  check('the drop/myo modal shows the per-side reminder for a perSide exercise',
    rows.some(c => c.innerHTML && c.innerHTML.includes('per-side-note')));

  await app.addExtraExercise(otherExId, 3, 8, 12);
  await app.refreshLogAndHistory();
  check('the active-workout card shows the per-side reminder for a perSide exercise',
    app.document.getElementById('active-workout-list').innerHTML.includes('per-side-note'));
  await app.removeExtraExercise(otherExId);
  await app.refreshLogAndHistory();
}
await fireAction('pin', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['pin'](actionStub({ exid: String(otherExId) })));
{
  const pref = await app.getExercisePref(otherExId);
  check('pin actually changed the store', pref && pref.pinned === true);
}
await fireAction('like', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['like'](actionStub({ exid: String(otherExId) })));
await fireAction('dislike', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['dislike'](actionStub({ exid: String(otherExId) })));

// pin/like/dislike must ALL invalidate the shared exercise-picker cache, not
// just dislike itself -- pin and like each clear `disliked` too, and a stale
// cache would keep a just-un-disliked exercise hidden from Swap/Add Exercise.
{
  await app.setExercisePref(otherExId, { pinned: false, liked: false, disliked: false });
  app.invalidateExercisePicker();
  let grouped = await app.groupedExercisesForPicker();
  check('the picker includes the exercise before it is disliked',
    grouped.some(g => g.exercises.some(e => e.id === otherExId)));

  await fireAction('dislike (picker cache)', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['dislike'](actionStub({ exid: String(otherExId) })));
  grouped = await app.groupedExercisesForPicker(); // must rebuild, not reuse the cache warmed above
  check('dislike invalidates the picker cache -- the exercise disappears without an explicit rebuild',
    !grouped.some(g => g.exercises.some(e => e.id === otherExId)),
    JSON.stringify(grouped.flatMap(g => g.exercises.map(e => e.id))));

  await fireAction('pin (undislike, picker cache)', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['pin'](actionStub({ exid: String(otherExId) })));
  grouped = await app.groupedExercisesForPicker();
  check('pinning a disliked exercise un-dislikes it AND invalidates the picker cache',
    grouped.some(g => g.exercises.some(e => e.id === otherExId)),
    JSON.stringify(grouped.flatMap(g => g.exercises.map(e => e.id))));

  await fireAction('dislike (re-arm)', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['dislike'](actionStub({ exid: String(otherExId) })));
  grouped = await app.groupedExercisesForPicker();
  await fireAction('like (undislike, picker cache)', () => registries.EXERCISE_MANAGER_CLICK_ACTIONS['like'](actionStub({ exid: String(otherExId) })));
  grouped = await app.groupedExercisesForPicker();
  check('liking a disliked exercise un-dislikes it AND invalidates the picker cache',
    grouped.some(g => g.exercises.some(e => e.id === otherExId)),
    JSON.stringify(grouped.flatMap(g => g.exercises.map(e => e.id))));

  await app.setExercisePref(otherExId, { pinned: false, liked: false, disliked: false });
  app.invalidateExercisePicker();
}

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
  const group = actionStub({ exid: String(dayExId), origExid: String(dayExId) });
  await fireAction('swap-open', () => registries.WORKOUT_CLICK_ACTIONS['swap-open'](group));
  check('swap-open opened the exercise picker', app.document.getElementById('exercise-picker-modal').hidden === false);
  // Completing the picker (as if a row had been tapped) should commit the
  // session-only swap via the picker's onSelect callback.
  await fireAction('pick-exercise (workout swap)', () => registries.EXERCISE_PICKER_ACTIONS['pick-exercise'](actionStub({ exid: String(otherExId) })));
  const afterSwap = await app.getWorkoutForDate(today);
  check('swap-open -> pick-exercise actually recorded the session swap',
    !!(afterSwap && afterSwap.exerciseSwaps && afterSwap.exerciseSwaps[dayExId] === otherExId),
    JSON.stringify(afterSwap && afterSwap.exerciseSwaps));
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

// --- Add Exercise / extra-exercise cards (09-workout.js) -------------------
{
  await app.refreshActiveWorkoutSection();
  const freshExercises = await app.getAllRecords('exercises');
  const usedIds = new Set(day0.exercises.map(e => e.exerciseId));
  usedIds.add(dayExId).add(otherExId);
  const extra = freshExercises.find(e => !usedIds.has(e.id));

  const addBtn = listeners.get('add-exercise-btn');
  await fireAction('add-exercise-btn', () => addBtn.click({ target: {} }));
  check('Add Exercise opened the picker with the right title',
    app.document.getElementById('exercise-picker-title').textContent === 'Add an exercise');

  await fireAction('pick-exercise (add exercise)', () => registries.EXERCISE_PICKER_ACTIONS['pick-exercise'](actionStub({ exid: String(extra.id) })));
  let afterAdd = await app.getWorkoutForDate(today);
  check('Add Exercise -> pick-exercise actually added the extra slot',
    !!(afterAdd && afterAdd.extraExercises && afterAdd.extraExercises.some(e => e.exerciseId === extra.id)),
    JSON.stringify(afterAdd && afterAdd.extraExercises));

  await app.refreshActiveWorkoutSection();
  const listHtml = app.document.getElementById('active-workout-list').innerHTML;
  check('the added exercise renders as a card tagged "added today" with a Remove button',
    listHtml.includes(extra.name) && listHtml.includes('added today') && listHtml.includes('data-action="remove-extra"'),
    listHtml.includes(extra.name) ? 'name present' : 'name MISSING from render');

  await fireAction('remove-extra', () => registries.WORKOUT_CLICK_ACTIONS['remove-extra'](actionStub({ exid: String(extra.id) })));
  const afterRemove = await app.getWorkoutForDate(today);
  check('remove-extra actually removed the slot (nothing was logged against it)',
    !(afterRemove.extraExercises || []).some(e => e.exerciseId === extra.id),
    JSON.stringify(afterRemove.extraExercises));
}
{
  const group = actionStub({ exid: String(dayExId) });
  await fireAction('open-drop-myo', () => registries.WORKOUT_CLICK_ACTIONS['open-drop-myo'](group));
  check('open-drop-myo opened the drop/myo modal, titled with the exercise\'s own name',
    app.document.getElementById('dropmyo-modal').hidden === false
    && app.document.getElementById('dropmyo-modal-title').textContent.includes('Bench'),
    app.document.getElementById('dropmyo-modal-title').textContent);
}

// --- PLAN_DAY_* (11-plan.js) ------------------------------------------------
await app.refreshPlanTab();
{
  const group = actionStub({ exid: String(dayExId), planid: String(plan.id), dayidx: '0' });
  await fireAction('plan-swap-open', () => registries.PLAN_DAY_CLICK_ACTIONS['plan-swap-open'](group));
  check('plan-swap-open opened the exercise picker', app.document.getElementById('exercise-picker-modal').hidden === false);
  await fireAction('pick-exercise (plan swap)', () => registries.EXERCISE_PICKER_ACTIONS['pick-exercise'](actionStub({ exid: String(otherExId) })));
  const updatedPlan = await app.getRecord('plans', plan.id);
  const stillHasOld = updatedPlan.days[0].exercises.some(e => e.exerciseId === dayExId);
  check('plan-swap-open -> pick-exercise actually rewrote the plan day', !stillHasOld);
}

// --- plan-swap-open must exclude every exercise already in the day, not
// just the slot being replaced -- two slots sharing one exerciseId would
// break setPlanPairing()'s "always unambiguous" invariant (see "Supersets"
// below), among everything else already keyed by exerciseId. Its own
// throwaway plan, since the shared `plan` fixture above has already had its
// day-0 composition rewritten by the swap test just above. ---------------
{
  const cat = await app.getAllRecords('exercises');
  const [exA, exB, exC] = cat.slice(0, 3);
  const swapPlanId = await app.addRecord('plans', {
    createdAt: Date.now(), goal: 'Swap exclude test', daysPerWeek: 3, equipment: '', notes: '',
    repRangeMin: 8, repRangeMax: 12, fixedSets: null,
    days: [{ name: 'Day', exercises: [
      { exerciseId: exA.id, name: exA.name, targetSets: 3, repRangeMin: 8, repRangeMax: 12 },
      { exerciseId: exB.id, name: exB.name, targetSets: 3, repRangeMin: 8, repRangeMax: 12 },
    ] }]
  });
  await fireAction('plan-swap-open (exclude check)', () => registries.PLAN_DAY_CLICK_ACTIONS['plan-swap-open'](
    actionStub({ exid: String(exA.id), planid: String(swapPlanId), dayidx: '0' })
  ));
  const pickerHtml = app.document.getElementById('exercise-picker-body').innerHTML;
  check('the swap picker excludes an exercise already elsewhere in the day (exB), not just the slot being replaced (exA)',
    !pickerHtml.includes(`data-exid="${exB.id}"`));
  check('the swap picker still offers an unrelated exercise (exC)',
    pickerHtml.includes(`data-exid="${exC.id}"`));

  app.document.getElementById('exercise-picker-modal').hidden = true;
  await app.deleteRecord('plans', swapPlanId);
}

// --- Supersets (11-plan.js's setPlanPairing/Plan tab UI, and the
// rest-timer exception in WORKOUT_CLICK_ACTIONS['log-set']) ----------------
// Uses its own throwaway plan rather than the shared `plan`/`day0` fixture
// above — the plan-swap-open test just replaced dayExId's slot with
// otherExId, so reusing those ids here would mean testing against exercise
// ids that no longer occupy the slots this block thinks they do.
{
  const originalCurrent = await app.getCurrentPlan();
  const cat = await app.getAllRecords('exercises');
  const [exA, exB, exC] = cat.slice(0, 3);
  const supersetPlanId = await app.addRecord('plans', {
    createdAt: Date.now(), goal: 'Superset UI test', daysPerWeek: 3, equipment: '', notes: '',
    repRangeMin: 8, repRangeMax: 12, fixedSets: null,
    days: [{ name: 'Day', exercises: [
      { exerciseId: exA.id, name: exA.name, targetSets: 3, repRangeMin: 8, repRangeMax: 12 },
      { exerciseId: exB.id, name: exB.name, targetSets: 3, repRangeMin: 8, repRangeMax: 12 },
    ] }]
  });
  await app.setCurrentPlan(supersetPlanId);
  await app.setSetting('restTimerEnabled', true);
  await app.setSetting('supersetsEnabled', true);
  app.selectedLogDayIdx = null; // force fresh auto-selection against the new (single-day) plan

  await app.refreshPlanTab();
  const pairSelect = actionStub({ exid: String(exA.id), planid: String(supersetPlanId), dayidx: '0' }, String(exB.id));
  await fireAction('plan-pair-select', () => registries.PLAN_DAY_CHANGE_ACTIONS['plan-pair-select'](pairSelect));
  let freshPlan = await app.getRecord('plans', supersetPlanId);
  check('plan-pair-select paired the two exercises symmetrically',
    freshPlan.days[0].exercises[0].pairedExerciseId === exB.id
    && freshPlan.days[0].exercises[1].pairedExerciseId === exA.id);
  check('the Plan tab shows the "Paired with" tag once paired',
    app.document.getElementById('plan-day-overview').innerHTML.includes('Paired with'));

  await app.refreshLogAndHistory();
  check('the active-workout card shows the superset tag with the setting on',
    app.document.getElementById('active-workout-list').innerHTML.includes('Superset with'));

  // First of the pair (array order: exA before exB) must skip the rest
  // timer entirely — observable via #timer-row's hidden state, exactly what
  // hideTimerSheet()/showTimerSheet() (04-timer.js) toggle.
  const firstGroup = actionStub({ exid: String(exA.id), origExid: String(exA.id), target: '3' });
  firstGroup.querySelector = (sel) => sel === '.plan-log-weight' ? actionStub({}, '60') : sel === '.plan-log-reps' ? actionStub({}, '8') : actionStub();
  const firstLogBtn = actionStub(); firstLogBtn.closest = () => firstGroup;
  await fireAction('log-set (first of pair)', () => registries.WORKOUT_CLICK_ACTIONS['log-set'](firstLogBtn));
  check('logging the FIRST exercise of an active pair suppresses the rest timer',
    app.document.getElementById('timer-row').hidden === true);

  // Second of the pair follows shouldRestAfter() exactly as before this
  // feature existed — one set logged against a target of 3 is not the
  // completing set, so a rest SHOULD start.
  const secondGroup = actionStub({ exid: String(exB.id), origExid: String(exB.id), target: '3' });
  secondGroup.querySelector = (sel) => sel === '.plan-log-weight' ? actionStub({}, '40') : sel === '.plan-log-reps' ? actionStub({}, '8') : actionStub();
  const secondLogBtn = actionStub(); secondLogBtn.closest = () => secondGroup;
  await fireAction('log-set (second of pair)', () => registries.WORKOUT_CLICK_ACTIONS['log-set'](secondLogBtn));
  check('logging the SECOND exercise of the pair rests normally',
    app.document.getElementById('timer-row').hidden === false);

  // The off switch suppresses both the tag and the rest exception without
  // touching pairedExerciseId on either slot.
  await app.setSetting('supersetsEnabled', false);
  await app.refreshLogAndHistory();
  check('turning supersetsEnabled off removes the tag',
    !app.document.getElementById('active-workout-list').innerHTML.includes('Superset with'));
  const stillPaired = await app.getRecord('plans', supersetPlanId);
  check('...without altering pairedExerciseId on either slot',
    stillPaired.days[0].exercises[0].pairedExerciseId === exB.id);

  await app.setSetting('supersetsEnabled', true);
  await app.refreshLogAndHistory();
  check('turning it back on immediately restores the tag with nothing to reconfigure',
    app.document.getElementById('active-workout-list').innerHTML.includes('Superset with'));

  // Swapping a paired exercise clears the pairing on the OTHER (untouched)
  // side too and falls back to normal (no tag).
  await fireAction('plan-swap-open (paired exercise)', () => registries.PLAN_DAY_CLICK_ACTIONS['plan-swap-open'](
    actionStub({ exid: String(exA.id), planid: String(supersetPlanId), dayidx: '0' })
  ));
  await fireAction('pick-exercise (breaks the pairing)', () => registries.EXERCISE_PICKER_ACTIONS['pick-exercise'](actionStub({ exid: String(exC.id) })));
  const afterSwapPlan = await app.getRecord('plans', supersetPlanId);
  check('swapping a paired exercise clears the pairing on the OTHER (untouched) side too',
    afterSwapPlan.days[0].exercises.find(e => e.exerciseId === exB.id).pairedExerciseId === undefined);
  await app.refreshLogAndHistory();
  check('after the swap, no pairing tag renders',
    !app.document.getElementById('active-workout-list').innerHTML.includes('Superset with'));

  // Clean up: restore the original current plan for anything after this block.
  await app.setCurrentPlan(originalCurrent.id);
  await app.deleteRecord('plans', supersetPlanId);
  app.selectedLogDayIdx = null;
  await app.refreshLogAndHistory();
}

// --- Personal records (announcePersonalRecord(), 09-workout.js) ------------
// dayExId ("Barbell Bench Press") has real logged history from
// seedDemoData. Weights below are deliberately extreme (300 / 1) so the
// comparison is unambiguous regardless of the current display unit
// (kg vs lb) — the point is "obviously heavier/lighter than any realistic
// prior set," not a precise value.
{
  await app.refreshLogAndHistory();
  const toastHost = app.document.getElementById('toast-host');
  const hasNewBestToast = (fromIndex) =>
    toastHost.children.slice(fromIndex).some(t => typeof t.textContent === 'string' && t.textContent.includes('New best'));

  const beforePR = toastHost.children.length;
  const heavyGroup = actionStub({ exid: String(dayExId), origExid: String(dayExId), target: '3' });
  heavyGroup.querySelector = (sel) => sel === '.plan-log-weight' ? actionStub({}, '300') : sel === '.plan-log-reps' ? actionStub({}, '5') : actionStub();
  const heavyLogBtn = actionStub(); heavyLogBtn.closest = () => heavyGroup;
  await fireAction('log-set (PR weight)', () => registries.WORKOUT_CLICK_ACTIONS['log-set'](heavyLogBtn));
  check('logging a clearly heavier set produces a "New best" toast', hasNewBestToast(beforePR));

  const beforeNonPR = toastHost.children.length;
  const lightGroup = actionStub({ exid: String(dayExId), origExid: String(dayExId), target: '3' });
  lightGroup.querySelector = (sel) => sel === '.plan-log-weight' ? actionStub({}, '1') : sel === '.plan-log-reps' ? actionStub({}, '5') : actionStub();
  const lightLogBtn = actionStub(); lightLogBtn.closest = () => lightGroup;
  await fireAction('log-set (not a PR)', () => registries.WORKOUT_CLICK_ACTIONS['log-set'](lightLogBtn));
  check('logging a lighter set produces no PR toast', !hasNewBestToast(beforeNonPR));
}

// --- Plan history (11-plan.js's renderPlanHistory / setCurrentPlan) --------
{
  const before = await app.getCurrentPlan();
  // Pinned explicitly rather than relying on createdAt ordering against the
  // fixture below — activePlanId is the actual mechanism that decides
  // "current" now, and leaving it to timestamp comparison would make this
  // test racy.
  await app.setCurrentPlan(before.id);
  const someExercise = (await app.getAllRecords('exercises'))[0];
  const pastPlanId = await app.addRecord('plans', {
    createdAt: Date.now() - 5000, goal: 'Old Goal', daysPerWeek: 3, equipment: '', notes: '',
    repRangeMin: 8, repRangeMax: 12, fixedSets: null,
    days: [{ name: 'Old Day', exercises: [{ exerciseId: someExercise.id, name: someExercise.name, targetSets: 3, repRangeMin: 8, repRangeMax: 12 }] }]
  });
  // Trained, so this fixture reads as real history — renderPlanHistory()
  // itself doesn't filter by training (pruning only ever runs inside
  // generatePlanWithAI()), but this matches what a genuine entry looks like.
  const pastWorkoutId = await app.addRecord('workouts', {
    date: '2020-01-01', ts: Date.now(), planId: pastPlanId, dayIndex: 0, dayName: 'Old Day',
    exercises: [{ exerciseId: someExercise.id, sets: [{ weight: 10, reps: 5 }] }]
  });

  await app.refreshPlanTab();
  const historyDetails = app.document.getElementById('plan-history-disclosure');
  check('renderPlanHistory shows the disclosure once a past (non-current) plan exists',
    historyDetails.hidden === false);
  check('renderPlanHistory\'s summary counts exactly the one past plan',
    app.document.getElementById('plan-history-summary').textContent === 'Past plans (1)',
    app.document.getElementById('plan-history-summary').textContent);
  check('renderPlanHistory lists the past plan\'s goal',
    app.document.getElementById('plan-history-list').innerHTML.includes('Old Goal'));

  await fireAction('make-plan-active', () => registries.PLAN_HISTORY_ACTIONS['make-plan-active'](actionStub({ planid: String(pastPlanId) })));
  const nowCurrent = await app.getCurrentPlan();
  check('make-plan-active switches getCurrentPlan() to the selected past plan', nowCurrent.id === pastPlanId);

  // Clean up: restore the original current plan and remove the fixture.
  await app.setCurrentPlan(before.id);
  await app.deleteRecord('workouts', pastWorkoutId);
  await app.deleteRecord('plans', pastPlanId);
  await app.refreshPlanTab();
  check('the disclosure hides itself again once no past plan remains',
    app.document.getElementById('plan-history-disclosure').hidden === true);
}

// --- Apple Fitness button visibility (04-timer.js's refreshSessionCard) ----
{
  await app.setSetting('appleFitnessShortcutName', '');
  await app.refreshSessionCard();
  check('the Apple Fitness button is absent with no shortcut name configured',
    app.document.getElementById('apple-fitness-btn').style.display === 'none');

  await app.setSetting('appleFitnessShortcutName', 'Start Strength Workout');
  await app.refreshSessionCard();
  check('the Apple Fitness button appears once a shortcut name is configured',
    app.document.getElementById('apple-fitness-btn').style.display === 'block');

  app.location.href = 'file:///x';
  await fireAction('apple-fitness-btn', () => listeners.get('apple-fitness-btn').click({ target: {} }));
  check('clicking the Apple Fitness button fires the Shortcuts deep link',
    app.location.href === 'shortcuts://run-shortcut?name=Start%20Strength%20Workout', app.location.href);

  await app.setSetting('appleFitnessShortcutName', '');
  app.location.href = 'file:///x';
}

// --- Birthday-derived age (07-settings.js's refreshAgeFromBirthday) --------
{
  const ageInput = app.document.getElementById('setting-age');
  const birthdayInput = app.document.getElementById('setting-birthday');
  const birthdayListener = listeners.get('setting-birthday');

  await app.clearSetting('birthday');
  await app.setSetting('age', 50);
  await app.loadSettingsIntoForm();
  check('with no birthday, the Age field is editable and shows the stored value',
    ageInput.disabled === false && ageInput.value === 50, `disabled=${ageInput.disabled} value=${ageInput.value}`);

  const today = app.todayStr();
  const twentyFiveYearsAgo = `${Number(today.slice(0, 4)) - 25}${today.slice(4)}`;
  birthdayInput.value = twentyFiveYearsAgo;
  await fireAction('setting-birthday change', () => birthdayListener.change({ target: birthdayInput }));
  check('setting a birthday disables the Age field and auto-fills the derived value',
    ageInput.disabled === true && ageInput.value === 25,
    `disabled=${ageInput.disabled} value=${ageInput.value}`);

  birthdayInput.value = '';
  await fireAction('setting-birthday change (cleared)', () => birthdayListener.change({ target: birthdayInput }));
  check('clearing the birthday re-enables manual age entry', ageInput.disabled === false);
  check('clearing the birthday restores the field to the STORED age, not the stale derived one',
    ageInput.value === 50, `value=${ageInput.value}`);

  await app.clearSetting('birthday');
  await app.clearSetting('age');
}

console.log(`\nregistry actions fired: ${actionsFired}, failures: ${actionsFailed}`);
console.log(`checks: ${passed} passed, ${failed} failed`);

process.exitCode = (failedHandlers || actionsFailed || failed) ? 1 : 0;
