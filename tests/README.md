# tests

Runs the app's **real** `<script>` in Node against a stub DOM, so the shipping
code is exercised rather than a reimplementation of it.

    node tests/run.mjs                       # all suites
    APP=/path/to/variant.html node tests/run.mjs   # check a modified copy

| file | what it covers |
| --- | --- |
| `harness.mjs` | Loads `splitcraft.html`, extracts the script, runs it in a `vm` context with a stub DOM. IndexedDB is deliberately absent, which drives the in-memory fallback. Exports the app's top-level functions. |
| `test.mjs` | Classifiers against the real Fitbod export, catalog/classifier agreement, and the progression maths. |
| `gen.mjs` | The whole plan-generation path with a stubbed OpenRouter, including that a fixed set count is actually enforced. |
| `ui.mjs` | Seeds demo data, re-renders every tab, then **fires every handler** the render paths left behind — both `onclick`/`onchange`/`oninput` properties and every delegated `data-action` handler, called directly via `actionRegistries()`. |
| `timing.mjs` | Overlapping writes and real elapsed time — the two things the suites above structurally cannot see. |
| `features.mjs` | Backup round-trip and validation, encrypted backups, the share-sheet/download/Dropbox delivery paths, ramped-set progression, the session time model, and the start-of-week plan prompt. |
| `docs.mjs` | Whether `design-summary.md` still describes the code. Reads the files, not the app. |

## Why it is shaped this way

Top-level `function` declarations attach to the vm context, so the tests call
the app's own implementations. `const` arrows do not — anything defined that
way has to be tested through a function that uses it.

Two details were each found the hard way:

- **Handlers must be fired, not merely assigned.** Wrong-variable bugs throw
  only when the handler runs. `ui.mjs` invokes every `onclick`/`onchange`/
  `oninput` property left on a stub element, and — since most render
  functions now wire one delegated listener per container instead of one
  property per control (see `delegate()` and "Event wiring" in
  `design-summary.md`) — also calls every named handler in every
  `*_ACTIONS` registry directly, via the accessor `actionRegistries()`
  (`12-init.js`; only top-level `function`s attach to the `vm` sandbox, so a
  `const` registry has no other way out), each with a stub element carrying
  plausible `data-*` values.
- **Stub inputs need values.** Handlers guard on
  `isNaN(parseFloat(input.value))` and bail early, so an empty stub input
  means the interesting half never executes.

Each suite was validated by reintroducing a real bug and confirming it fails:

| bug | caught by |
| --- | --- |
| `budget` read before its `const` (TDZ) | `gen.mjs` — *Cannot access 'budget' before initialization* |
| `setsInstruction` defined in the wrong function | `gen.mjs` — *setsInstruction is not defined* |
| `row` used where the variable is `group` | `ui.mjs` — *row is not defined* |
| `logSet` without its write lock | `timing.mjs` — *ONE workout record — got 3* |
| rest timer counting ticks instead of reading a clock | `timing.mjs` — *1:29 (tick-counting would say 1:30)* |
| progression anchored on `sets[0]` instead of the top set | `features.mjs` — *suggested 60kg (must exceed the 80kg top set)* |
| a reps-only edit rewriting the stored weight | `features.mjs` — *54.4kg x 9* |
| `Date.now()` set timestamps colliding | `features.mjs` — *1 distinct of 7* |
| catalog sync reverting a hand-edited built-in | `features.mjs` — *front_delts/barbell* |
| shallow backup validation | `features.mjs` — *a damaged backup is refused: ...* |
| a plan day repeating one exercise | `features.mjs` — *[1,17,1]* |
| the session estimate ignoring setup time | `features.mjs` — *48 vs 85* |
| a constant drifting away from the design summary | `docs.mjs` — *doc has no "6 min"* |
| a new setting never documented | `docs.mjs` — *undocumented: brandNewUndocumentedKey* |
| API key allowed into the backup file | `features.mjs` — *backup EXCLUDES the OpenRouter API key* |
| week dismissal stored as a boolean, not a week key | `features.mjs` — *a dismissal from an earlier week does NOT carry over* |

None of the first three is visible to static analysis: the brackets balance,
and in two of them the identifier genuinely exists — just not there, or not yet.

## The blind spot `timing.mjs` exists for

`ui.mjs` fires every handler, but strictly **one at a time and to completion**,
so a read-modify-write race never gets a chance to open. And the harness stubs
`setInterval` to a no-op, which means anything that counts ticks looks perfect
while anything that reads a clock is never exercised at all.

Both of those properties are what made the harness fast and deterministic, and
both of them hid a real bug that shipped:

- Two overlapping `logSet` calls each created their own workout record for the
  same day. The `date` index is not unique, so `getWorkoutForDate()` only ever
  found the first — the second day's sets were invisible in the app and present
  in the store.
- The rest timer decremented once per tick, so a phone that locked its screen
  mid-rest came back showing whatever number the OS had stopped it on.

`timing.mjs` attacks both directly: `Promise.all` over the mutators for the
first, and real `await sleep()` with **zero ticks delivered** for the second —
which is precisely the backgrounded-tab case, since the stubbed `setInterval`
never calls anything back.
