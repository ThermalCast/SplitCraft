// Does design-summary.md still describe the code?
//
// This project treats the design summary as a real artefact — it explains why
// things are the way they are, and people (and models) act on it. That makes a
// stale claim worse than a missing one: a reader has no way to tell that the
// document confidently describing `max_tokens: 4000` is describing a value that
// changed months ago, or that the settings list is missing a third of its keys.
//
// Documentation rot is silent by nature, so the mechanically checkable parts
// are checked here. Prose can't be tested and isn't; constants, store fields
// and key lists can be, and those are exactly the parts that go stale first
// because they change without anyone thinking of the doc.
//
// This suite reads the FILES, not the app — no harness, no DOM.
import fs from 'node:fs';

const APP = process.env.APP || new URL('../splitcraft.html', import.meta.url);
const code = fs.readFileSync(APP, 'utf8');
const doc = fs.readFileSync(new URL('../design-summary.md', import.meta.url), 'utf8');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ' — ' + detail : ''}`); }
}
const constant = (re) => { const m = code.match(re); return m ? m[1] : null; };

// Boundary-aware, because plain substring matching is far too generous with
// numbers: "about 16 minutes" contains "6 min", so a claim about a 6-minute
// default would be satisfied by a sentence that has nothing to do with it.
// Verified by deliberately drifting a constant and confirming this fails.
const mentions = (needle) => {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`).test(doc);
};

// --- Named constants the doc quotes back at the reader ---
const constants = [
  ['DB version', /const DB_VERSION = (\d+)/, (v) => `version ${v}`],
  ['idle timeout', /const IDLE_MS = (\d+)/, (v) => `${v / 1000}s`],
  ['hard cap', /const HARD_CAP_MS = (\d+)/, (v) => `${v / 1000}s`],
  // Lives as aiChat's default parameter, not a top-level const.
  ['max_tokens', /maxTokens = (\d+)/, (v) => String(v)],
  ['sameWeight tolerance', /Math\.abs\(a - b\) < ([\d.]+)/, (v) => String(v)],
  ['backup format version', /BACKUP_FORMAT_VERSION = (\d+)/, (v) => `version: ${v}`],
  ['PBKDF2 iterations (encrypted backups)', /const PBKDF2_ITERATIONS = (\d+)/, (v) => `${v} iterations`],
  ['backup staleness threshold', /const BACKUP_STALE_DAYS = (\d+)/, (v) => `${v}) days`],
  ['setup default', /DEFAULT_SETUP_MINUTES = ([\d.]+)/, (v) => `${v} min`],
  ['overhead default', /DEFAULT_OVERHEAD_MINUTES = ([\d.]+)/, (v) => `${v} min`],
  ['transition sample floor', /TRANSITION_MIN_SAMPLES = (\d+)/, (v) => `${v} changes`],
  ['transition outlier cap', /TRANSITION_MAX_MIN = (\d+)/, (v) => `${v} min`],
];
for (const [label, re, render] of constants) {
  const value = constant(re);
  if (value === null) { check(`${label}: constant still exists in the code`, false, 'not found'); continue; }
  const expected = render(Number(value));
  check(`${label} (${expected}) is stated in the design summary`,
    mentions(expected), `code says ${value}; doc has no "${expected}"`);
}

// --- The bundled catalog size, quoted in two places ---
const catalog = code.match(/const DEFAULT_EXERCISES = \[([\s\S]*?)\n {2}\];/);
const exerciseCount = catalog ? (catalog[1].match(/\{ name:/g) || []).length : 0;
check(`the ${exerciseCount}-entry exercise catalog size is current in the doc`,
  mentions(`${exerciseCount} entries`), `code has ${exerciseCount}`);

// --- The number of mutators serialised by withWorkoutLock(), stated in prose ---
// Prose isn't testable, but a count is, and this one had already drifted: the
// doc said "eight" in two places after setSessionSwap became the ninth. Both
// the correct count must appear and no stale count may survive, so rewording
// one sentence and forgetting the other still fails. Matched against a
// whitespace-flattened copy, since the doc wraps ("The nine\nmutators").
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const mutatorCount = (code.match(/return withWorkoutLock\(/g) || []).length;
const docFlat = doc.replace(/\s+/g, ' ');
const mutatorWord = NUMBER_WORDS[mutatorCount] || String(mutatorCount);
const statedRight = new RegExp(String.raw`\b${mutatorWord} mutators\b`).test(docFlat);
const statedStale = NUMBER_WORDS.filter((w) => w !== mutatorWord)
  .filter((w) => new RegExp(String.raw`\b${w} mutators\b`).test(docFlat));
check(`the ${mutatorCount} lock-guarded mutators are counted correctly in the doc`,
  statedRight && statedStale.length === 0,
  `code has ${mutatorCount} ("${mutatorWord}")` +
  (statedRight ? '' : '; doc never states that count') +
  (statedStale.length ? `; doc still says: ${statedStale.join(', ')}` : ''));

// --- Every settings key is documented ---
// The most mechanical check and the one that was actually wrong: nine keys had
// accumulated in the code with the doc's list untouched.
const keys = [...new Set([...code.matchAll(/etSetting\('([a-zA-Z]+)'/g)].map(m => m[1]))].sort();
const undocumented = keys.filter(k => !doc.includes('`' + k + '`'));
check(`all ${keys.length} settings keys appear in the design summary`,
  undocumented.length === 0, `undocumented: ${undocumented.join(', ')}`);

// --- Every persisted field on an exercise record is documented ---
const exerciseFields = ['name', 'primaryMuscle', 'secondaryMuscles', 'equipment',
  'custom', 'userEdited', 'startingWeightKg'];
const missingFields = exerciseFields.filter(f => !doc.includes('`' + f + '`'));
check('the exercises-store fields are all described',
  missingFields.length === 0, `missing: ${missingFields.join(', ')}`);

// --- Claims that must NOT survive, because the thing they describe is gone ---
const retired = [
  ['maximum-scale is still in the viewport tag', /maximum-scale=1, /.test(code)],
  ['the app is still called workout-tracker.html', doc.includes('`workout-tracker.html`')],
  ['the app is still called pushing_iron.html', doc.includes('`pushing_iron.html`')],
  ['a per-row unit dropdown still exists', /class="set-edit-unit"/.test(code)],
];
for (const [label, stillTrue] of retired) {
  check(`retired claim is not asserted: ${label}`, !stillTrue);
}

// --- The gym presets, which the doc gives concrete numbers for ---
const gym = code.match(/GYM_SETUP_MINUTES = \{([\s\S]*?)\};/);
if (gym) {
  const vals = Object.fromEntries([...gym[1].matchAll(/(\w+):\s*([\d.]+)/g)].map(m => [m[1], m[2]]));
  check('the commercial-gym preset value is stated in the doc',
    mentions(`commercial gym (${vals.commercial} min)`), `code says ${vals.commercial}`);
  check('the two home-gym preset values are stated in the doc',
    mentions(`(${vals.home_combo} min)`) && mentions(`(${vals.home_dedicated} min)`),
    `code says combo ${vals.home_combo}, dedicated ${vals.home_dedicated}`);
}

// --- Features that exist in the code must be findable in the doc ---
// Names, not prose: if a reader greps the summary for a function they found in
// the source, it should be there.
const documentedIdentifiers = [
  'withWorkoutLock', 'getAllWorkouts', 'weightToStore', 'restorePut',
  'validateBackup', 'applyRestore', 'aiChat', 'estimateSessionMinutes',
  'sessionSetBudget', 'estimateStartingWeight', 'nameKey', 'syncDefaultExercises',
];
const undocumentedIds = documentedIdentifiers.filter(fn =>
  new RegExp(String.raw`\bfunction ${fn}\b|const ${fn}\b`).test(code) && !doc.includes(fn));
check('load-bearing functions are named in the design summary',
  undocumentedIds.length === 0, `not mentioned: ${undocumentedIds.join(', ')}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
