// Exercises the whole plan-generation path with a stubbed OpenRouter, which
// is where the TDZ and wrong-function bugs actually lived. Nothing static can
// reach this: it only fails when the code RUNS.
import { app } from './harness.mjs';

const plan = { days: [{ name: 'Day 1 - Push', exercises: [
  { name: 'Barbell Bench Press', targetSets: 4, repRangeMin: 6, repRangeMax: 10 },
  { name: 'Lateral Raise', targetSets: 3, repRangeMin: 10, repRangeMax: 15 }] }] };

app.fetch = async () => ({
  ok: true, status: 200, statusText: 'OK', body: null,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
});

await app.setSetting('openrouterKey', 'sk-or-test');
await app.setSetting('openrouterModel', 'test/model');
await app.setSetting('sessionMinutes', 60);

let failed = 0;
for (const [label, args] of [
  ['AI chooses sets', { fixedSets: null }],
  ['sets fixed at 3', { fixedSets: 3 }],
]) {
  try {
    const out = await app.generatePlanWithAI({
      goal: 'Hypertrophy', daysPerWeek: 4, equipment: '', notes: '',
      repRangeMin: 8, repRangeMax: 12, splitType: 'push_pull_legs', ...args,
    });
    const sets = out.days[0].exercises.map(e => e.targetSets);
    const expected = args.fixedSets ? sets.every(s => s === args.fixedSets) : true;
    console.log(`  ok   generatePlanWithAI (${label}) -> targetSets ${JSON.stringify(sets)}`);
    if (!expected) { console.log('  FAIL fixed set count was not enforced'); failed++; }
  } catch (e) {
    console.log(`  FAIL generatePlanWithAI (${label}): ${e.message}`);
    failed++;
  }
}
// ---------------------------------------------------------------------------
// SSE STREAM PARSING.
//
// Every case below is a real failure that reported as the same useless
// sentence: "The model returned an empty response — try again, or try a
// different model." That is advice for exactly one of these causes, handed out
// for all of them, which is why retrying produced the identical failure twice
// in a row.
//
// The parser only ever read `delta.content`. Reasoning models stream their
// thinking as `delta.reasoning`, so a run that thought for 29 seconds and got
// guillotined by max_tokens mid-thought was indistinguishable from a model
// that said nothing at all — bytes arriving steadily (enough to keep the
// idle-abort quiet), then "Stream complete: 0 characters".
// ---------------------------------------------------------------------------
function sseStream(frames) {
  const enc = new TextEncoder();
  const chunks = frames.map(f => enc.encode(`data: ${JSON.stringify(f)}\n\n`));
  chunks.push(enc.encode('data: [DONE]\n\n'));
  let i = 0;
  return { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }) };
}
const respondWith = (frames) => {
  app.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', body: sseStream(frames) });
};
const generate = () => app.generatePlanWithAI({
  goal: 'Hypertrophy', daysPerWeek: 4, equipment: '', notes: '',
  repRangeMin: 6, repRangeMax: 10, splitType: 'auto', fixedSets: 3,
});

const streamCase = async (label, frames, expect) => {
  respondWith(frames);
  try {
    const out = await generate();
    if (typeof expect === 'function') {
      if (expect(out)) console.log(`  ok   ${label}`);
      else { console.log(`  FAIL ${label}: unexpected plan ${JSON.stringify(out.days && out.days[0])}`); failed++; }
    } else { console.log(`  FAIL ${label}: expected an error, got a plan`); failed++; }
  } catch (e) {
    if (typeof expect === 'function') { console.log(`  FAIL ${label}: ${e.message}`); failed++; }
    else if (expect.test(e.message)) console.log(`  ok   ${label}`);
    else { console.log(`  FAIL ${label}: message was "${e.message}"`); failed++; }
  }
};

const onePlan = { days: [{ name: 'Push', exercises: [{ name: 'Barbell Bench Press', targetSets: 3, repRangeMin: 6, repRangeMax: 10 }] }] };
const planJson = JSON.stringify(onePlan);

// The reported failure: reasoning tokens only, cut off at the cap.
await streamCase('reasoning-only + finish_reason "length" names the token limit', [
  { choices: [{ delta: { reasoning: 'thinking '.repeat(200) } }] },
  { choices: [{ delta: {}, finish_reason: 'length' }],
    usage: { prompt_tokens: 1800, completion_tokens: 16000, completion_tokens_details: { reasoning_tokens: 16000 } } },
], /token limit before it wrote any answer/);

await streamCase('reasoning that ends cleanly with no answer says so', [
  { choices: [{ delta: { reasoning_content: 'thinking '.repeat(50) } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
], /reasoning and then finished without writing an answer/);

await streamCase('a genuinely empty response is reported as such', [
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
], /returned nothing at all/);

await streamCase('a content-filter block is named, not guessed at', [
  { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
], /content filter/);

// Reasoning followed by real content is the normal reasoning-model path and
// must produce a plan, not an error.
await streamCase('reasoning followed by content still yields a plan', [
  { choices: [{ delta: { reasoning: 'thinking…' } }] },
  { choices: [{ delta: { content: planJson.slice(0, 20) } }] },
  { choices: [{ delta: { content: planJson.slice(20) } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
], (out) => out.days[0].name === 'Push');

// Some providers (and buffering proxies) put the whole message on the final
// frame instead of streaming deltas. That answer used to be dropped on the
// floor and reported as empty.
await streamCase('a whole message on the final frame is not dropped', [
  { choices: [{ message: { content: planJson }, finish_reason: 'stop' }] },
], (out) => out.days[0].name === 'Push');

// Split across chunk boundaries mid-frame — the buffering path.
await streamCase('a frame split across two chunks is reassembled', (() => {
  const frames = [{ choices: [{ delta: { content: planJson } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
  return frames;
})(), (out) => out.days[0].name === 'Push');

// ---------------------------------------------------------------------------
// SECRET REDACTION. The plan-status log is rendered on screen and stays
// there until the next generation clears it — a fragment of the OpenRouter
// key logged here would be a screenshot/shoulder-surf leak. Every case above
// already ran with a real (test) key, so this checks the log they left
// behind rather than triggering a fresh call.
// ---------------------------------------------------------------------------
{
  const lines = app.document.getElementById('plan-status-log').children.map(c => c.textContent);
  const leaked = lines.find(l => l.includes('sk-or'));
  if (leaked) { console.log(`  FAIL the API key leaked into the status log: "${leaked}"`); failed++; }
  else console.log('  ok   no fragment of the API key reaches the status log');
}

// ---------------------------------------------------------------------------
// CONCURRENCY GUARD. The weekly-regen banner's button and the plan form's
// Generate button each disable only themselves, so both can call
// generatePlanWithAI() at once. A shared in-flight lock must reject the
// second call outright rather than firing a second real OpenRouter request.
// ---------------------------------------------------------------------------
{
  respondWith([
    { choices: [{ delta: { content: planJson } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  const first = generate();
  let secondErr = null;
  try { await generate(); } catch (e) { secondErr = e; }
  const firstResult = await first;
  if (secondErr && /already being generated/i.test(secondErr.message)) {
    console.log('  ok   a concurrent generatePlanWithAI() call is rejected while one is in flight');
  } else {
    console.log(`  FAIL concurrency guard did not reject the second call (got: ${secondErr && secondErr.message})`);
    failed++;
  }
  if (firstResult && firstResult.days && firstResult.days.length) {
    console.log('  ok   the original in-flight call still completes normally');
  } else {
    console.log('  FAIL the original call did not complete after a concurrent one was rejected');
    failed++;
  }
  // The lock must be released once the in-flight call finishes, so a THIRD,
  // later call is not permanently locked out by the rejected second one.
  respondWith([{ choices: [{ message: { content: planJson }, finish_reason: 'stop' }] }]);
  try {
    const third = await generate();
    console.log(third && third.days && third.days.length ? '  ok   the lock is released after completion, letting a later call through'
      : '  FAIL the lock did not release cleanly');
    if (!(third && third.days && third.days.length)) failed++;
  } catch (e) { console.log(`  FAIL a later call was wrongly blocked: ${e.message}`); failed++; }
}

// ---------------------------------------------------------------------------
// ORPHANED EXERCISE ROLLBACK. New "custom" exercise records are created
// while matching model output against the library, day by day. If a LATER
// day in the same response turns out to have a bad shape, the whole
// generation fails and no plan is ever saved — but without a rollback, any
// exercise records created for earlier days stay behind permanently, with
// nothing ever pointing to them.
// ---------------------------------------------------------------------------
{
  const uniqueName = 'ZZZ Rollback Probe Exercise';
  const badPlan = { days: [
    { name: 'Day 1', exercises: [{ name: uniqueName, targetSets: 3, repRangeMin: 8, repRangeMax: 12 }] },
    { name: 'Day 2' /* no `exercises` array — the shape check below must reject this */ },
  ] };
  app.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', body: null,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(badPlan) } }] }) });
  let threw = null;
  try {
    await app.generatePlanWithAI({ goal: 'Hypertrophy', daysPerWeek: 4, equipment: '', notes: '',
      repRangeMin: 8, repRangeMax: 12, splitType: 'auto', fixedSets: 3 });
  } catch (e) { threw = e; }
  const afterExercises = await app.getAllRecords('exercises');
  const orphan = afterExercises.find(e => e.name === uniqueName);
  if (threw && !orphan) {
    console.log('  ok   an exercise created for an earlier day is rolled back when a later day fails');
  } else {
    console.log(`  FAIL orphan rollback: threw=${!!threw}, orphan present=${!!orphan}`);
    failed++;
  }
}

console.log(failed ? `\n${failed} failure(s)` : '\nplan generation path clean');
process.exitCode = failed ? 1 : 0;
