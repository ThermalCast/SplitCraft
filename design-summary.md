# SplitCraft — Design Summary

A weight-training workout tracker. Personal tool first, built with an eye toward
other people using it later. Single-file PWA, no backend.

> ⚠️ **Open security issue before this goes to anyone else:** the OpenRouter
> API key is stored unencrypted on the device. Accepted knowingly for the
> testing phase. See **KNOWN SECURITY ISSUE — OpenRouter API key at rest**
> in Part 1 for the full write-up and the fix options.

This document has two parts. **Part 1** describes the app as it exists today —
present tense, no history. **Part 2** is a decision log: places where the
current design replaced something else, kept because the reasoning is the
valuable part of a design doc and shouldn't be lost just because the code
moved on.

---

# Part 1 — Current design

## Architecture & files

- **No backend, by design.** Every feature is filtered through "can this run
  entirely client-side." Where something needed a backend-shaped capability
  (AI calls), the app picks providers whose APIs are CORS-enabled for direct
  browser calls.
- **`splitcraft.html`** is the app: vanilla HTML/CSS/JS, no framework, no
  build step, no external dependencies. Fonts, icons and the rest-timer beep
  are all generated in-code rather than fetched.
- **The source is split under `src/`** (`src/page.html` plus twelve files under
  `src/js/`) purely for editability — a ~7,400-line single file was unwieldy to
  navigate and diff. `tools/build.mjs`, a dependency-free Node script,
  concatenates them back into `splitcraft.html` in file order; no bundler,
  no transform, no ES modules. **The built file is the deliverable**: it still
  ships as one classic `<script>` tag, `splitcraft.html` stays checked in
  and is what the service worker precaches and the README tells people to
  double-click, and `tests/run.mjs` runs the build before every test run so
  the suite always exercises the built file, never a stale one.
- **PWA.** Installable via "Add to Home Screen," offline-capable.
  `manifest.webmanifest` covers Android/Chrome; iOS ignores the manifest and
  is served instead by the `apple-mobile-web-app-*` meta tags plus a real
  `apple-touch-icon` PNG. `sw.js` precaches the app shell (cache-first, with a
  background refresh so the *next* launch is current) and calls
  `self.skipWaiting()` unconditionally at install, so a new deploy takes over
  immediately rather than waiting for every open tab to close; the page shows
  a toast ("Update ready — reopen the app to apply it") that is purely
  informational, not a gate. Icons are generated from code by
  `tools/make-icons.mjs` — a dependency-free PNG encoder — so there are no
  unexplainable binary blobs in the repo.
  - A service worker is registered by URL and derives its scope from its own
    path, so it cannot be inlined, and only runs over `https://` or
    `localhost`. That is why the project is no longer literally one file.
  - The single-file property is preserved where it matters: every added file
    is optional at runtime. Open `splitcraft.html` on its own, off the
    filesystem, and registration is skipped by a feature check — the app
    behaves exactly as it always did. The extras are an enhancement layer,
    never a dependency.
- **Storage is local-only, via IndexedDB** — chosen over `localStorage`
  (5–10MB cap, synchronous, strings only) for async access, structured data
  and a much larger quota. Cloud sync (Drive/Dropbox/OneDrive, all of which
  support client-only OAuth PKCE with CORS-enabled APIs) remains a viable
  future transport; pCloud/WebDAV was rejected because its endpoint sends no
  CORS headers, which would require a backend proxy.
- Logging a set persists immediately — there's no separate "save workout"
  step; each "Log Set" tap is the save.
- **Fallback:** if IndexedDB isn't available (some sandboxed preview contexts
  don't support it), the app degrades to an in-memory-only store for that
  session via a shared `dbAvailable` flag, so the UI never hard-fails — it
  just won't persist across a reload in that environment.

## Storage & data model

IndexedDB database `ironlog`, `DB_VERSION = 5` (version 5), five stores.

**`workouts`** (keyPath `id` autoIncrement; index on `date`) — one record per
calendar day trained:
- `date` — `YYYY-MM-DD`, local time. At most one workout per date (no
  multi-session-per-day support — see Non-goals).
- `ts` — epoch ms of the day's first logged set, for sorting.
- `planId`, `dayIndex`, `dayName` — set the first time a set that day is
  logged from the Plan tab's quick-log; stay `null` for a day logged purely
  via the free-form entry form.
- `exercises` — `[{exerciseId, sets: [{ts, type, entries}]}]`. `entries`
  length >1 for drop sets and myo reps. **`entries[].weight` is always
  kilograms** — sets carry no `unit` field; display/input unit is one global
  setting (see "Weight unit" below).
- `startedAt`, `endedAt`, `durationMs` — set by the Start Warm-up/Complete
  Workout buttons; `null`/absent until a session starts. `startedAt` is also
  set automatically by `logSetLocked()` on the first set logged that day, if
  nothing has started the session yet.
- `startedAuto` — `true` when `startedAt` was set by the auto-start above
  rather than by the Start Warm-up button; absent/`false` for an explicit
  start. Read by `sessionOverheadSamples()` (excludes auto-started sessions)
  and by `deleteSetLocked()`'s cleanup guard (an auto-started, now-empty
  record is deleted; an explicitly-started one is kept).
- `targetOverrides` — `{exerciseId: number}`, today-only set-count
  adjustments, keyed by the *effective* (post-swap) exercise; absent unless
  adjusted for that day.
- `exerciseSwaps` — `{originalExerciseId: newExerciseId}`, today-only
  exercise substitutions; absent unless swapped that day.

**`exercises`** (keyPath `id` autoIncrement; index on `primaryMuscle`)
- `name`
- `primaryMuscle` — string id referencing the static `MUSCLES` constant (not
  a DB record).
- `secondaryMuscles` — array of muscle ids; also read as a **compound vs
  isolation** signal by the starting-weight estimator (a compound names the
  muscles it borrows, an isolation names none).
- `equipment` — one of the `EQUIPMENT` class ids (`barbell`, `dumbbell`,
  `machine`, `cable`, `assisted`, `bodyweight`, `other`). Decides the
  smallest loadable jump and is the load-scale signal the starting-weight
  estimator leans on. Absent on rows predating the field, which fall back to
  `classifyEquipmentFromName()`.
- `custom` — `false` for rows mirroring `DEFAULT_EXERCISES` (the bundled
  "central source" list, 92 entries), re-synced on every load — see
  "Exercise catalog & sync" below. `true` for anything the user added
  (quick-add, Settings, CSV import, or an AI-generated plan naming something
  new); never touched by the sync.
- `userEdited` — set when the muscle or equipment dropdown in Settings is
  used on a row. Stops the catalog sync from managing it thereafter.
- `startingWeightKg` / `startingWeightSource` — an opening weight for a lift
  with no history, written by the AI pass after plan generation.
  Self-expiring: once the lift has a logged set, the progression path takes
  over and never reads them again.

**`exercisePrefs`** (keyPath `exerciseId`, one row per exercise with any
preference set) — `{ exerciseId, pinned, liked, disliked }` (booleans). A
separate store from `exercises`, not fields on it, so the catalog can be
freely added-to/corrected/re-synced without ever touching what the user has
pinned/liked/disliked.

**`plans`** (keyPath `id` autoIncrement)
- `createdAt`, `goal`, `daysPerWeek`, `equipment`, `notes`
- `days` — `[{name, exercises: [{exerciseId, name, targetSets, repRangeMin, repRangeMax}]}]`
- `daysPerWeek` here is a snapshot of the global setting at generation time
  (display only); the live weekly-progress countdown reads the *current*
  global setting instead.
- Permanently editable from the Plan tab (which exercise fills a slot, via
  `updatePlanDayExercise()`) without a full regeneration.

**`settings`** (keyPath `key`) — plain key/value, mirrored into
`localStorage` under `ironlog.setting.*`, and cached in memory
(`settingsCache`, a `Map`) so a read never touches storage: `loadSettings()`
reads every row (IndexedDB or the in-memory fallback, then the
`localStorage` mirror for any key the primary store has nothing for at all)
into the map once, from `init()`, before anything else reads a setting.
`getSetting()` and the synchronous `getSettingSync()` (for hot paths — see
Data integrity) both just read the map; `getSetting()` stays `async` in name
only, so existing call sites are unaffected. `setSetting()`/`clearSetting()` write
the map first, then IndexedDB (or memory) and the `localStorage` mirror
exactly as before, so nothing downstream of a write ever sees a stale cached
value — the mirror is consulted only once, at load, never per read:

- **OpenRouter** — `openrouterKey`, `openrouterModel`
- **Workout** — `restDefault` (seconds), `restTimerEnabled`,
  `rirPromptEnabled`, `equipmentStepsKg`
- **Time model** — `secondsPerSet`, `exerciseSetupSeconds`, `gymType`
  (`commercial` | `home_combo` | `home_dedicated`), `sessionMinutes`
- **Profile** — `experienceLevel`, `sex`, `age`, `bodyweightKg`,
  `energyBalance`
- **Training** — `planDaysPerWeek`, `planSplitType`, `planSplitCustom`
- **Plan form (remembered between generations)** — `planGoal`,
  `planEquipment`, `planNotes`, `planRepMin`, `planRepMax`, `planFixedSets`
- **Plan scheduling** — `planWeekDismissed` (the week-start a regeneration
  prompt was dismissed for; expires by itself next Monday)
- **Display** — `weightUnit` ('kg' | 'lb', display-only)
- **Backup** — `lastBackupAt` (epoch ms of the last export/share/Dropbox
  upload that actually completed; feeds the "Last backup" reminder in
  Settings), `dropboxRefreshToken` (present only once Dropbox is connected —
  see "Cloud backup: Dropbox" below)

`openrouterKey`, `lastBackupAt`, and `dropboxRefreshToken` are all
**excluded from backups**, each for its own reason — see "Backup & restore"
and "Cloud backup: Dropbox".

### Upgrade path

- **v2 → v3**: on upgrade, existing per-set `sets` records are read via
  cursor inside the versionchange transaction, grouped by date → exerciseId,
  written into the `workouts` shape above, and the old `sets` store is
  dropped.
- **v3/v4 → v5**: existing per-set `unit:'lb'` weights are converted to kg
  (rounded to 2 decimals) and the `unit` field is stripped from every set.
  The `date` index on `workouts` — created only in the branch that builds a
  fresh store — is **backfilled** for any database upgrading from v3/v4,
  where the store already existed (`if (!workoutsStore.indexNames.contains('date')) workoutsStore.createIndex('date', ...)`).
  `getWorkoutForDate()` still defensively checks `indexNames.contains('date')`
  and falls back to a full-store scan if it is somehow missing, but on a
  normal upgrade the index is present and indexed lookups are used.
- All upgrade branches are gated on `e.oldVersion`, so a brand-new install
  runs none of them.

## Muscle taxonomy (static constant, not persisted)

16 muscles plus an `unclassified` fallback bucket, each tagged with:
- `region`: `upper | lower | core`
- `pattern`: `push | pull | core`

Used to (a) group the exercise picker into optgroups by muscle, and (b) pick
the progression weight increment base (2.5% for upper-body lifts, 5% for
lower-body, before modifiers).

**Muscle reassignment**: Settings → Exercise list gives every exercise (default
or custom) a `<select>` next to its name to change its `primaryMuscle`
directly (writes through `putRecord('exercises', ...)`). Added because the
CSV importer's keyword classifier can't always guess right, and there needs
to be a way to fix a misclassified or `unclassified` exercise without
deleting and re-adding it, which would orphan any sets already logged
against its old `exerciseId`.

**There is no delete button on this list.** Reassigning the muscle is the
operation this screen is for; deletion of an exercise with history is not
recoverable and shouldn't be one mis-tap away. Set-level `×` buttons in the
active workout and History are unaffected — those delete a single set, are
scoped to one workout, and are trivially re-enterable.

## Exercise catalog & sync

- `DEFAULT_EXERCISES` is the canonical/"central source" list — a static JS
  array bundled in the HTML file, kept single-file deliberately: the
  practical way to ship an "updateable from a central source" catalog
  without a backend is to ship a new version of the file, and existing
  users pick up the changes automatically via the sync below.
- **Coverage rule: every muscle in `MUSCLES` gets at least three entries**,
  spanning barbell / dumbbell / machine / cable / bodyweight as available.
  The catalog holds **92 entries** to satisfy this across all 16 muscles.
  Assisted Pull-Up and Assisted Dip are defaults specifically because the
  negative-weight convention (see "Assisted movements") needs something to
  attach to out of the box.
- **The catalog and `classifyMuscleFromName()` are cross-checked**: every
  default name is run through the classifier and its answer must equal the
  entry's declared `primaryMuscle`. The catalog is authoritative for names it
  contains; the classifier only ever guesses for names it doesn't. The check
  currently passes 92/92.
- `syncDefaultExercises()` runs on **every load**: for each entry in
  `DEFAULT_EXERCISES`, match against local `exercises` by `nameKey()` — add
  it if missing; if it exists and is `custom:false` and not `userEdited`,
  refresh its `primaryMuscle`/`secondaryMuscles`/`equipment` to match.
  `custom:true` rows and `userEdited:true` rows are never touched. The write
  spreads the existing record before overriding the three managed fields, so
  `startingWeightKg` and similar extra fields survive a refresh.
- **Name matching uses `nameKey()`**: lowercased, apostrophes stripped,
  hyphens/underscores folded to spaces, whitespace runs collapsed.
  Deliberately *not* stemmed — "Hammer Curls" won't match "Hammer Curl" —
  because over-merging (a default silently never created) is harder to
  notice than a visible duplicate.
- **`nameKey()` is the key for every path that resolves a name to a
  record**: the catalog sync, the CSV importer, the AI plan matcher, and
  manual exercise creation (quick-add and the Exercises tab's "Add an
  exercise" disclosure) all use it, so a name that differs only in
  punctuation or case resolves to the same exercise everywhere rather than
  forking a near-miss duplicate. Quick-add (the inline "+ Add new exercise"
  flow) reuses an existing match silently; the Exercises tab's Add form
  blocks the add and toasts `"<name>" already exists` instead.
- This means shipping an updated `DEFAULT_EXERCISES` (new exercises, fixed
  muscle tags) reaches everyone's existing local data on their next load,
  with zero migration code needed.
- **Explicitly deferred**: fetching the catalog from a real remote URL
  (updateable without shipping a new HTML file). The HTML must keep working
  standalone off `file://`, so a fetch would need to be optional, cached and
  CORS-configured, and sync-on-load already delivers catalog updates
  whenever a new HTML file ships.

## Exercises tab

The exercise list (`renderExerciseManager()`, 06-catalog-import-backup.js)
has its own bottom tab rather than living inside Settings — a Fitbod import
can push it past 100 rows, each with two selects and three buttons, which is
heavy to render permanently inside a settings page dominated by one-off
forms. The tab sits between Plan and Settings.

**Search-first.** The panel is, top to bottom: `#exercise-filter` (a
`type="search"` box, placeholder "Search exercises…"), a `.hint` line with
the count ("92 exercises · 3 custom"), a `<details class="disclosure">` "Add
an exercise" holding the existing `#new-exercise-form`, then the list itself
(`#exercise-manager-list`). The filter matches on `nameKey()`, the same
match the History search uses, not a bare `toLowerCase()` — so "Pull-Up"
finds "Pull Up".

**Expand-on-tap.** Each row shows just the name, a muscle chip (`.sugg-tag`
style, muscle name) and small indicators for pinned/liked/disliked (📌 👍 👎,
shown only when set) — a glance-scan list rather than a form per row.
Tapping a row (`data-action="expand-exercise"` on the row itself, in
`EXERCISE_MANAGER_CLICK_ACTIONS`) reveals the muscle/equipment selects and
the three pref buttons underneath it in `.ex-row-details`, tracked by a
module-level `expandedExerciseRows` Set (same pattern as `expandedExercises`
in 09-workout.js), one row open at a time. The underlying action names
(`set-muscle`, `set-equipment`, `pin`, `like`, `dislike`) and their
registries are unchanged from when this lived in Settings.

**What stayed in Settings**: Import Data and Backup & restore. Those are
whole-device operations, not exercise data — an import or restore touches
workouts, plans and settings too, so they belong with the rest of
device-level Settings rather than a tab about one store.

## Equipment taxonomy & classifiers

Exercises carry an `equipment` field (`barbell | dumbbell | machine | cable |
assisted | bodyweight | other`); each class has its own configurable step
(Settings → Workout, `equipmentStepsKg`) and is guessed from the exercise
name by `classifyEquipmentFromName()` when the field is absent, via
`exerciseEquipment()`. Records predating the field need no migration.

Both `classifyMuscleFromName()` and `classifyEquipmentFromName()` are
**first-match-wins**, ordered lists of keyword/regex rules, verified against
the full 92-entry catalog and the full Fitbod export vocabulary. Rule order
is load-bearing — several rules exist only to shield a broad pattern from a
name it would wrongly claim:

| Must come first | Or else |
| --- | --- |
| calves | `/raise/` variants claim "Calf Raise" |
| hamstrings | `/\bglute/` claims "Glute Ham Raise" |
| rear delts | `/\bfly\b/` claims "Rear Delt Fly", "Reverse Fly", "TRX Y Deltoid Fly" |
| side delts | `/\brow\b/` claims "Upright Row" |
| front delts | `/push-?up/` claims "Pike Push Up" |
| triceps | `/bench press/` claims "Close-Grip Bench Press"; `/\bdip\b/` claims "Bench Dip" |
| upper back | `/pull-?up/` claims "Scap Pull Up" |
| adductors | *(adduction only — `abduct` routes to glutes, matching the catalog's "Hip Abduction Machine"; the schema has no abductors bucket)* |
| everything | the bare `/\bcurl\b/ → biceps` last resort claims leg curls, wrist curls, reverse curls, Jefferson curls |

**A miss returns `unclassified` rather than a guess.** An obviously empty
muscle field in Settings → Exercise list is cheap to spot and fix, while a
set silently credited to the wrong muscle corrupts the weekly-sets chart
with nothing visibly wrong. Pure cardio ("Treadmill Run", "Stationary Bike",
"Rowing Machine", "Elliptical", "Jump Rope") is *correctly* left
unclassified — it isn't resistance work and shouldn't score against any
muscle. `/\brow\b/` does not match "Rowing Machine" (no word boundary after
`row`), which keeps the erg out of the lats bucket.

The equipment/muscle-select dropdowns in Settings → Exercise list are how the
user fixes whatever a classifier still gets wrong; best-effort, not
exhaustive.

## Set logging UX

- Exercise is chosen from a `<select>` grouped by primary muscle — not free
  text — plus an inline "+ Add new exercise" flow (name + primary muscle
  only; secondary muscles are editable afterward in Settings).
- A set-type toggle (Standard / Drop / Myo) changes the entry-rows UI:
  standard is a single weight+reps row; drop/myo show repeatable rows with an
  "Add Drop" / "Add Myo Cluster" button, filled in after finishing the whole
  set in real life.
- **History is delete-locked.** `renderExerciseGroup()` takes an
  `allowDelete` flag (default `true`); the History tab passes `false`, so
  past days render without a delete button — once a day isn't today anymore,
  it's locked in. Inline editing of standard sets' weight/reps is unaffected
  — only deletion is restricted to today.
- **Set rows are `[n] [weight] [reps] [Log]`**, single-line
  (`flex-wrap: nowrap`), so every set is the same height and a list of them
  scans as a column. There are no reps-stepper buttons — see Part 2.
- **The sign toggle (±) is conditional.** The sign is not stored on the
  exercise — a negative weight on a set *is* the assistance (see "Assisted
  movements") — so the control is offered only when:
  - the exercise's equipment class is `assisted`, or
  - any logged set for it today is already negative, or
  - the suggestion itself is negative (so it can be undone).

  It isn't removed outright because `inputmode="decimal"` keypads have no
  minus key on either iOS or Android, so a negative would be untypable on
  the device this app is for. A shared `'toggle-sign'` delegated action (see
  "Event wiring" below) flips the sign of whatever is in the field, lights
  up in accent when negative, and does nothing on an empty field. The manual
  free-form entry form keeps the toggle **unconditionally**, since its
  exercise dropdown can change after the rows are drawn and there is no
  equipment class to key off at render time.
- **Prefill with no history.** `suggestForExercise()` returns
  `{ weight: null, reps: repRangeMin }` when nothing is logged yet — the
  weight box stays empty (nothing to suggest) but the rep target is
  prescribed by the plan, so it's never left blank for no reason.
- **Warm-up ramp.** `warmupSets(workingKg, exercise)` (`08-progression.js`)
  proposes up to three warm-up sets at 50%×8, 70%×5 and 85%×2 of the
  suggested working weight, each rounded to the exercise's loadable step
  (`loadStepKg`). Shown as a dim chip row under the suggestion, only before
  the first set of that exercise is logged today (`doneCount === 0`). Skips
  entirely for `bodyweight`/`assisted` equipment (nothing to load onto the
  body beforehand), for barbell work at 30kg or under (an empty 20kg bar
  already *is* the warm-up), and for any other equipment class where the
  working weight is at most 4 of its own loadable steps (too light to ramp
  into meaningfully). A candidate is dropped if it rounds to zero or below,
  to the working weight or above, below the empty-bar floor on a barbell, or
  onto a weight an earlier candidate already produced.

### Event wiring

Every render function builds an HTML string (or a handful of DOM nodes) and
then has to attach handlers to whatever it just built. That used to be a
`container.querySelectorAll('.foo').forEach(el => { el.onclick = ... })` pass
per class of control, re-run on every repaint — cheap to write, but it
re-walks and re-closures the whole subtree on every single logged set, and
it's the exact shape that produced the "wired-but-unreachable class" bug in
Part 2 (a selector wired in one function but rendered by another, silently
inert because the wiring `forEach` just ran zero times).

Instead, markup carries `data-action="name"` (plus whatever `data-*` a
handler needs — exercise/workout ids, indices, deltas, plan ids), and each
container gets exactly **one** listener per event type, attached once by
`delegate(container, eventType, actions)` (`03-helpers.js`):

- The listener does `e.target.closest('[data-action]')`, looks the resulting
  action name up in `actions` (a plain object of NAMED functions — never
  anonymous closures), and calls it with the matched element.
- Wiring is idempotent: a flag on the container's own `dataset`
  (`delegated_<eventType>`) means re-rendering a container via
  `.innerHTML =` — which replaces the children but leaves the container NODE
  and its listeners in place — attaches the listener exactly once rather
  than stacking a new one on every repaint.
- Handlers are named and exported per render function as a `const
  X_ACTIONS = { 'action-name': async (el) => {...}, ... }` registry (e.g.
  `WORKOUT_CLICK_ACTIONS`, `HISTORY_CHANGE_ACTIONS`, `PLAN_DAY_CLICK_ACTIONS`)
  rather than a closure, specifically so a test can call each handler
  directly with a stub element instead of needing to simulate a real DOM
  click bubbling through a delegated listener — an anonymous
  `e => e.target.closest(...)` listener would give a test nothing to invoke.
  `actionRegistries()` (`12-init.js`) exposes every registry for exactly
  this reason: only top-level `function` declarations attach to the test
  harness's `vm` sandbox, so a `const` registry otherwise has no path out.
- Per-set state that a closure used to capture directly (which plan, which
  day, the pre-loaded `workouts`/`exercises` lookups, today's date string)
  lives on a small module-level "render context" object instead — e.g.
  `activeWorkoutCtx` in `09-workout.js`, set at the top of every
  `renderActiveWorkout()` call and read by its action registries. Small
  per-row values (an exercise id, a set index, a stored kg, a plan target)
  travel on the markup as `data-*` rather than on the context object, since
  they differ row to row within one render.
- The same `data-action` value can serve two independent registries when an
  element participates in two event types with related but different
  behaviour — e.g. a set-edit row's weight input carries
  `data-action="edit-set"` for both `change` (commits the edit) and `input`
  (only keeps a preceding sign-btn's `.negative` class in sync); each event
  type has its own `delegate()` call and its own actions object, so the
  same string is just two independent lookups, not a collision.
- `wireSignButtons(container)` — the per-render `querySelectorAll('.sign-btn')`
  pass this replaced — is gone; its behaviour is now the shared
  `'toggle-sign'` action (the click) plus a `syncSignClass()` helper (the
  `input`-driven `.negative` sync), reused by every container that renders a
  sign toggle (entry rows, History, the active workout). The class's
  *initial* state, previously set by an eager `sync()` call at wiring time,
  is instead baked directly into the button's markup — every render already
  knows the sign of the value it's about to draw.

### Workout session (auto-start, or Start/Complete Warm-up)

A card at the top of the workout tab shows the session clock. The session
starts itself: `logSet()` stamps `startedAt` (the logged set's own
timestamp) and `startedAuto: true` on today's `workouts` record the first
time a set is logged, if nothing has started it yet. The "Start Warm-up"
button remains for anyone who wants the clock running before their first
set — pressing it stamps `startedAt` immediately (creating the record if
needed) the same way it always did, and does *not* set `startedAuto`.
Whichever comes first wins: `startWorkoutSessionLocked()` only stamps
`startedAt` `if (!workout.startedAt)`, so a Start press after an auto-start
keeps the earlier, auto-stamped time rather than resetting the clock, and
leaves `startedAuto` alone (the start time is still the auto one, whichever
flag says how it got there). "Complete Workout" behaves as before: stamps
`endedAt` and stores `durationMs`.

Deliberately decoupled from set-logging — sets save immediately on every
"Log Set" tap regardless of session state; Start/Complete only capture *when*
the session happened and *how long* it took. Pressing Start again after
Complete keeps the original `startedAt` and clears `endedAt`/`durationMs`,
so completing early and resuming still gives an accurate total duration.
Weekly-progress and History both exclude workouts with zero logged
exercises, so a session with no set logged still doesn't inflate either.

`deleteSet()`'s cleanup guard keeps a `workouts` record whenever it was
*explicitly* started (`startedAt` present and `startedAuto` not set), even
with no exercises left — clearing the day's only logged set can't silently
wipe a running timer someone started on purpose. An auto-started record gets
no such protection: its `startedAt` IS the first logged set's timestamp, so
once every set (and every override/swap) is gone there is nothing left the
record is for, and deleting the last set deletes the record, same as before
auto-start existed.

The session time model (`collectPaceSamples()` / `sessionOverheadSamples()`,
below) excludes `startedAuto` records from the *fixed-overhead* measurement
only — an auto-started session's `startedAt` already sits at the first set,
so there is no arrival/warm-up gap left to measure, and treating the short
tail after the last set as the whole overhead would bias that term low. The
per-set and per-exercise-setup measurements still use auto-started sessions
normally: those come from gaps between sets within the day, which auto-start
does not touch, and excluding them would have thrown away most of the
history the model most needs — precisely the sessions where Start was
forgotten.

### Active workout (logging against a plan)

Once a plan exists, the workout tab's active-workout section — day-picker
("Today's session"), then one card per exercise with an auto-suggested
weight/reps — is where sets get logged against it.

**Each exercise card renders one row per set**, not just a running list:
- Rows before the next unlogged set: the actual logged weight/reps, editable
  inline for standard sets.
- The next row (`doneCount` index): an active weight/reps input with a "Log"
  button — always exactly one row, whether it's the next planned set or a
  bonus set past `targetSets` (labeled "(bonus)").
- Any further not-yet-reached planned sets: dim placeholder rows ("not
  logged yet"), so the full `targetSets` count is visible up front.
- Row count is `Math.max(effectiveTarget, doneCount + 1)` when incomplete;
  once complete it stops at `doneCount` — no trailing blank "4+" row on a
  finished exercise. A bonus set adds a row via the `+` in the meta row.
- Logging goes through the same `logSet()` helper as the free-form entry
  form, additionally tagging the day's `workouts` record with
  `planId`/`dayIndex`/`dayName`.
- Scoped to `type: 'standard'` — drop sets and myo reps go through the
  free-form entry form only.

**Finished exercises collapse where they sit.** A finished exercise becomes
a tick, its name, and a one-line digest of the sets; it does not move in the
list, so the running order stays the order on the screen. A chevron expands
it again — done rows keep their inline weight/rep editing and delete button.
`expandedExercises` survives the re-render every log triggers, so re-opening
one doesn't snap shut. **The next incomplete exercise is scrolled into
view** after a log, using `block: 'nearest'` (a no-op if already visible),
gated behind `revealNextOnRender` so it never fires on first paint.

Row state reads at a glance: `.plan-log-row.done-set` (logged: green wash and
rail, green-tinted set-number chip), `.plan-log-row.next-set` (the one row
with a Log button: amber wash and rail), `.set-row.pending` (dimmed,
italic). The `sets × reps` prescription and the progression suggestion live
in a dedicated `.meta-row` (`.meta-row.suggestion` amber-tinted), not a
generic `.set-row`. `suggestForExercise()` returns `why` as an array of
terse tags (`new lift`, `4+ RIR left`, `cutting`, `age 55`) rendered as dim
chips beside a sentence kept under ~110 characters — the reason a suggestion
differs from expectation is still visible, just not as prose.

**Day-picker stickiness**: which day the workout tab is showing
(`selectedLogDayIdx`, a plain in-memory variable) is preserved across
re-renders triggered by logging/deleting sets. It resets to the plan's
default (today's workout's stored `dayIndex`, or day 0) on page load and
after generating a new plan — not on every `refreshPlanTab()` call, which
also runs after settings saves, equipment changes, a unit switch, import and
restore, none of which should knock the picker back to today.

**Manual entry.** A free-form entry form below the active-workout section —
exercise picker, any set type — for logging things off-plan (warm-ups,
extra accessory work) without needing a plan slot. It is collapsed into a
`<details>` disclosure by default; with a plan loaded the active-workout
list is the main way to log, and the form is the escape hatch.

**Per-exercise History panel.** Each exercise card has a History button
opening an inline panel of previous sessions (date, days-ago, sets, volume)
— answering "what did I do last time?" without leaving the workout or
switching tabs. Today's sets are excluded (already on screen above), it's
capped at ten sessions with a pointer to the History tab, and it renders on
first open rather than every repaint.

### Editing a logged set

- **Standard sets are inline-editable** wherever shown as a row — the active
  workout, History (weight/reps only; deletion is disabled there), and the
  free-form entry form's logged rows all use the same row markup and the
  same `updateStandardSet()` write path. Editing a weight or reps field
  commits on `change` (blur/Enter).
- **Editing the reps does not rewrite the weight.** The inputs render weight
  at one decimal (`displayWeight` rounds there) but stored weights carry
  more precision (the Fitbod importer rounds to two decimals; an lb set
  converts to something like `45.359237`). `weightToStore()` keeps the
  stored value byte-for-byte when the number in the box still matches what
  the box was rendered with, so touching only the reps field can't quietly
  round the weight.
- **Drop sets and myo reps stay delete-and-re-add only** — they carry
  multiple weight/reps entries per set, and inline-editing a variable-length
  list isn't worth the UI complexity. They render as read-only rows with
  just a delete button.
- Implemented as a full commit to the new set's numbers
  (`set.entries = [{ weight, reps }]`), not a diff/undo-able edit — no edit
  history is kept.
- **Deleting a set offers a 6-second Undo toast.** `deleteSet()` returns the
  removed set; the delete handler (active workout and History) passes it to
  a `toast()` action button that calls `restoreSet()` to put it back. Plain
  deletes elsewhere in the app (a whole workout via restore/clear-history)
  stay undo-free — this is specifically about the one-tap, no-confirm delete
  on a single set.

## Rest timer & RIR prompt

Both share a single fixed **bottom sheet** (`#bottom-sheet`) above the tab
bar, `hidden` until a set is logged. It holds two independent rows — the
timer row and the RIR-prompt row — each shown or hidden on its own
(`syncSheet()`), with the container visible while either wants to be.
`body.sheet-up` pads the page while the sheet is open, so it never covers
the row you just logged or the next exercise underneath it.

### Rest timer

- Auto-starts after any set is logged, unless suppressed by
  `shouldRestAfter()` or the `restTimerEnabled` opt-out below.
  `startRestTimer()` always restarts from the full configured rest length
  (`restDefault`, default 90s) rather than resuming whatever was left.
- **`shouldRestAfter(setsDone, prescribed)`** — not after the set that
  *completes* an exercise: the walk to the next machine is its own
  self-paced rest, and timing it produces a countdown nobody is waiting on.
  Exactly-equal rather than `>=`, so bonus sets past the prescription still
  get a timer (once off-script, the app can't know which set is genuinely
  last, and an unwanted-but-dismissable rest beats withholding one that was
  wanted — there is no manual start). A prescription of 0 (manual, off-plan
  logging) always rests.
- **It counts down from a deadline, not by ticking.** `timerDeadline` is an
  epoch-ms end time; `timerTick()` recomputes `Math.ceil((deadline - now) /
  1000)` every second, so the display is correct however long a backgrounded
  tab or locked screen suspended `setInterval`. A `visibilitychange`
  listener forces an immediate resync on return. `±15s` (`adjustTimer`)
  moves the deadline, not just the label, and restarts a countdown that had
  already run out, so `+15` after the beep buys more time. A rest expiring
  more than ~3s in the past doesn't beep (already taken while the phone was
  in a pocket); the 0:00 display happens either way. The sheet
  auto-dismisses ~4s after the beep, cancelled if another rest starts.
- It is a **single row**: clock, inline progress bar (`.timer-track` /
  `.timer-fill`, driven by `timerTotal`), then `−` / `+` / `×`. There is no
  Start/Pause/Reset — a rest timer that starts itself doesn't need a Start,
  and there's no permanent card for Reset to matter on. `×` dismisses. The
  buttons are 36px rather than the 44px `--tap` floor: secondary controls
  sitting directly above a 60px tab bar, where a mis-tap is harmless.
- Beep via a lazily-created Web Audio oscillator (880Hz, ~0.3s), reused
  across the session (not one `AudioContext` per beep) and `resume()`d on
  use to cover the OS suspending it in the background; plus
  `navigator.vibrate` where supported. **`unlockAudio()`** is called from
  `startRestTimer()` — still inside the Log tap's user gesture — because iOS
  only unlocks Web Audio when the context is created/resumed synchronously
  inside a gesture handler; building it lazily on the first beep (which
  fires from a `setInterval` tick, not a gesture) is silently ignored there.
- **Optional, defaulting on** (`restTimerEnabled`, default `true`). Off:
  logging a set records it and nothing else happens — no countdown, no
  sheet, no beep. The opt-out lives inside `startRestTimer()` rather than at
  each call site.
- The rest length control lives only in Settings → Workout, and updates the
  idle clock immediately.

### RIR prompt

- A prompt card in the sheet — 0 / 1 / 2 / 3 / 4+ and a skip — appears once
  a set is recorded, not before it (there is no `<select>` in the logging
  row). It carries its own `{workoutId, exerciseId, setIndex}`; `setSetRir()`
  re-reads and guards the record since the set can be deleted between
  logging it and answering.
- The plan path asks once per exercise, when the post-write set count
  reaches the prescribed target (decided from the data, not the row's
  position, so a skipped or added set can't desynchronise it). Manual
  logging asks every time (no notion of "last"). `rirPromptEnabled`
  (default `true`) turns it off entirely.
- **Read from the binding set, not averaged.** On a straight-set session,
  that's the last set logged — closest to failure, and what double
  progression gates on. On a ramped session the **top set** is the binding
  one instead (falling back to the last set if the top set carries no
  value), since the top set is both the heaviest and, on a ramp, the one the
  session was building toward.
- **Entirely optional, absent by default.** A missing value is `null`, never
  `0` (`Number('')` is `0`, which would read as taken to failure). Used only
  when the counted set in the session actually carries a value.

## Progression algorithm — deliberately programmatic, not AI

Double progression, recomputed fresh from logged history every time rather
than stored as separate mutable state, so it can't drift out of sync with
what was actually logged:

1. Group logged sets into sessions by date, newest first, each capped at the
   session's *own* prescribed set count (the plan target, or that day's
   `targetOverrides` value if one was set) — bonus sets beyond it don't
   count either way.
2. Count consecutive recent sessions that hit `repRangeMax` **at the same
   weight** (compared on each session's top set — see "Ramped sessions"
   below). A heavier session that also cleared the top is a different rung
   of the ladder, not evidence about this one.
3. If that streak reaches the count required for the lifter's experience
   level → suggest weight + increment, reps reset to `repRangeMin`.
4. If the streak is non-zero but short of the requirement (advanced only) →
   hold the weight and say so explicitly.
5. Otherwise → same weight, aim for one more rep (capped at `repRangeMax`).

`suggestForExercise(exerciseId, repRangeMin, repRangeMax, targetSets,
allWorkouts, exercisesById)` reads `experienceLevel`, `age` and
`energyBalance` via `getSettingSync()` — a synchronous Map lookup against
the settings cache (see "Storage & data model" and Data integrity), not a
storage read, so there is no per-exercise cost to avoid by having the
caller pre-fetch them the way `allWorkouts`/`exercisesById` still are.

### Ramped sessions

A session counts as **ramped** when its sets aren't all at one weight (e.g.
60×8, 70×6, 80×4). The set that decides the load and the next jump is then
the **heaviest** one (`topSetOf`), not the first — a straight-sets anchor
would read the working weight as the warm-up and wait forever for a warm-up
set to hit the top of the rep range. Only the top set has to clear
`repRangeMax` to count the session as cleared (`clearedTop`); straight-set
sessions still require every set to clear. `>` on raw kg is correct for
assisted work too, since −20 (less assistance) is genuinely greater than
−40.

### Progression rate: what drives the increment

**Training age drives it, and that part has evidence.** Rate of strength
gain falls off sharply as training age rises — it's why novice programs add
load every session, intermediate programs weekly, and advanced programs per
block. Rhea et al.'s 2003 dose-response meta-analysis found trained and
untrained lifters require materially different intensities and volumes to
keep progressing at all, with effect sizes shrinking as experience
accumulates.

**Increments are a percentage of the working weight, not a fixed plate
jump.** +2.5kg is 2.5% of a 100kg squat and 12.5% of a 20kg overhead press —
a flat increment silently over-prescribes on every light lift.

**The levels are defined by recovery, not by calendar time.** Novice /
intermediate / advanced is *how long you need to recover enough to add
load* — a session, a week, or a block. Calendar time is only a loose proxy
(novice linear progression typically runs 3–9 months, but people exhaust it
anywhere from 8 weeks to well over a year), so the picker describes the
observable behaviour ("still adding weight nearly every session") rather
than a duration.

It is also genuinely **per-lift** — most people are still novices on
overhead press long after their squat isn't — which is what the derived
per-lift training age below is for.

| Experience | Lower body | Upper body | Clean sessions before load moves |
| --- | --- | --- | --- |
| Novice | 5.0% | 3.3% | 1 |
| Intermediate | 2.5% | 2.0% | 1 |
| Advanced | 1.5% | 1.0% | 2 |

**Why a session count as well as a percentage.** Percentages stop
discriminating once the rounding floor binds — an advanced lifter's 1% of a
100kg bench rounds up to the same 2.5kg an intermediate gets. The lever that
actually separates advanced lifters in practice is *frequency*: load moves
after repeated successful sessions, not the first one.

**Equipment class decides the increment floor, not the lifter.** A barbell
with 1.25kg plates moves in 2.5kg steps, a dumbbell rack in 2kg (or a
preferred lb-based step), a pin stack in 5kg steps — regardless of how
strong the lifter is. `equipmentStepsKg` (Settings → Workout) holds a
configurable step per class.

### The rounding floor and the frequency conversion

Rounding to a loadable jump is non-negotiable, but rounding the target
*percentage* up to the nearest step (as opposed to converting a sub-step
target into frequency) collapses every modifier onto the same number — see
Part 2. Instead, **a sub-step target is a statement about frequency, not
size**: "you should add less than one plate per session" becomes "add one
plate, less often." `progressionPlan()` returns both the jump and, when the
target falls below one step, `ceil(step / target)` clean sessions before
that jump is taken:

| Case (100kg bench, barbell) | Jump | Sessions | Average rate |
| --- | --- | --- | --- |
| Intermediate | 2.5kg | 2 | 1.25% |
| + 3 RIR reported | 2.5kg | 1 | 2.50% |
| + cutting | 2.5kg | 3 | 0.83% |
| + treated as a new lift | 2.5kg | 1 | 2.50% |
| + advanced | 2.5kg | 3 | 0.83% |

Average rate tracks the target percentage at any load, on any equipment, and
every modifier stays visible. Session count is capped at 6 — past that, what
a lifter needs is a deload or a different exercise, not a longer wait.

**Measured across the three experience levels**, the floor's size decides
whether the percentages mean anything at all:
- At a **2.5kg** floor (standard plates, no microplates), novice,
  intermediate and advanced receive *identical* increments on every
  upper-body lift below ~125kg, and on lower-body lifts below ~50kg.
- At a **1.25kg** floor the three levels separate from ~60kg upward.
- At a **0.5kg** floor they separate almost everywhere.

The frequency conversion is what rescues the sub-floor cases; the per-class
step is what stops a dumbbell or a pin stack being modelled as a barbell.
Both are needed.

### The other modifiers

| Modifier | Source | Effect | Evidence |
| --- | --- | --- | --- |
| Per-lift training age | Derived: count of sessions logged for that exercise | `<8` sessions → treated as novice, `<25` → intermediate. Can only ever *speed up*, never slow (the faster of the global and per-lift judgement wins). | Strong. Early gains are substantially motor learning, which is movement-specific — a three-year lifter is a novice at a lift they've never done. |
| Reps in reserve | Optional, last/binding set only | ≥2 RIR → ×1.25, ≥3 → ×1.5, ≥4 → ×2 | Strongest available signal: it measures the headroom every other variable estimates. Applied gently because self-reported RIR runs optimistic and calibrates with experience. |
| Bodyweight | Optional setting, entered in the display unit | Bodyweight and assisted exercises compute the percentage off `bodyweight + logged`, not the logged number | Not really an evidence question — a pull-up at +10 is not a 10 lift. |
| Age | Optional setting | ×0.95 from 40, ×0.85 from 50, ×0.75 from 60 | Direction is solid — rate and recovery decline while gains continue at every age. **The coefficients are a judgment call**, not a literature value; no meta-analysis publishes a per-decade progression multiplier. |
| Nutrition phase | Setting | Deficit ×0.6, surplus ×1.1. In a deficit the "didn't progress" message is reworded, since holding load while cutting is a good outcome, not a miss. | Direction well established; magnitudes are a judgment call. |

**Every non-obvious suggestion says why**, appended in parentheses — "only 3
sessions logged on this lift, so it's treated as new", "slowed for the
calorie deficit."

**Bodyweight follows the canonical-kg rule like every other weight**: stored
as `bodyweightKg`, entered and displayed in whatever `weightUnit` is set,
converted at the boundary. Label, placeholder, step and value all come from
`refreshBodyweightField()` so they cannot disagree, and a unit switch
re-*renders* the field rather than re-reading it — the stored value is kg
and doesn't change just because the display did.

**Sex is stored but deliberately does not scale the rate.** Roberts, Nuckols
& Krieger's 2020 meta-analysis (*J Strength Cond Res*) found women's
*relative* strength gains equal to men's in the lower body and slightly
greater in the upper body; absolute gains differ only because absolute
starting loads differ, which the load-relative increment already handles
for everyone. `sex` is passed to the AI planner as context only. See
`SEX_NOTE` in the source.

**Weight comparison uses a 0.05kg tolerance** (`sameWeight`), not `===`.
Every value is canonical kg from `toKg()`, so identical entries match
exactly — but a lift logged in kg one week and lb the next lands one
rounding step away (displayed in lb at one decimal, logged back through
`toKg()`, a value lands within ~0.02kg of the original), and 0.05kg is ten
times below the smallest loadable step while comfortably covering that
round trip.

**Sessions are judged against the target they were actually given.** Each
past session's `clearedTop` check uses the set-count override stored on its
own `workouts` record (`targetOverrides`), falling back to the plan target —
so a day shortened with the today-only adjuster is judged on what it was
actually asked to do, not the plan's full count.

**Rep-based, not volume-based.** The "today's volume" figure (Σ weight×reps)
shown in the workout tab is informational only and doesn't feed the
algorithm.

**Drop sets and myo-rep sets count as one working set each, judged by their
FIRST entry.** `workingEntry(set)` (in `08-progression.js`) returns
`set.entries[0]` — the weight and reps actually done at the working weight,
before the myo clusters or drops that follow it deliberately extend the set
past that point. `recentTopSetByExercise()` and the `history` built in
`suggestForExercise()` both read every set via `workingEntry()`, not just
`type: 'standard'` ones, so a session logged entirely as myo or drop sets is
no longer invisible to progression. On a ramped session a drop set can be the
top set like any other — `topSetOf()` and `isRamped()` already compare on
each set's (now type-agnostic) working weight. The History tab's exercise
progress chart (its picker and its two series) reads the same way, for the
same reason: an exercise logged only as drop/myo sets used to vanish from the
picker entirely. Volume (`setVolumeKg`) is unaffected — it already sums
every entry of every set, regardless of type.

### Not implemented, and why

- **Proximity to a strength standard.** Bodyweight is stored, so the input
  exists, but turning "this lift is 1.4× bodyweight" into a rate multiplier
  means picking threshold tables and asserting where someone's ceiling is —
  inventing numbers and presenting them as analysis. Reps-in-reserve
  measures the same underlying thing directly and honestly.
- **Per-exercise increment override.** Equipment class covers the real
  variation (barbell vs dumbbell vs stack); a per-exercise number would only
  help oddities like one unusual machine, at the cost of a numeric field on
  all ~90 rows of the Exercise list.
- **Sex as a rate multiplier.** Not an omission — see above, a finding.

## Assisted movements (negative weight)

Assisted pull-ups, assisted dips and similar are logged with a **negative
weight**: the number is how much load is taken *off* the lifter. No new
field, no `isAssisted` flag on the exercise record — the sign carries the
meaning.

This falls out well almost everywhere:
- **Progression needs no special case.** Adding `increment` on an assisted
  set (−30 → −27.5) is *less* assistance, a harder set — right direction,
  same code.
- **Top set = max weight** still means "best": the maximum of a set of
  negatives is the one closest to zero, i.e. the least assisted.

Three places need explicit handling:
- **Volume floors each entry at zero** (`setVolumeKg`), matching how
  bodyweight sets (weight 0) have always counted.
- **Estimated 1RM is dropped** for any exercise whose logged weights aren't
  all positive (Epley runs backwards on a negative load), unless bodyweight
  is known — see "Bodyweight in charts" below.
- **Coaching text is phrased as assistance** — "try 27.5kg of assist × 8"
  rather than "try -27.5kg × 8."

### Charting a negative load

The progress chart plots the **stored (signed) value** and always keeps
**zero in view** when any value is negative:
- `if (rawMin >= 0) vMin = Math.max(0, vMin); else vMax = Math.max(vMax, 0);`
  — normal loads sit on a zero floor; negative data extends the top of the
  range to zero instead.
- A dashed `.chart-zero` baseline is drawn whenever zero lands on screen;
  when every value is negative it coincides with the labelled top gridline,
  reading as a ceiling the line is climbing toward.
- The legend swaps to `Assisted load (kg) · 0 = unassisted`, and the trend
  line reads in assistance terms ("Assistance down 10kg across 6 sessions").

This keeps **"up is better" true for every exercise**: plotting assistance
as a positive magnitude (30 → 25 → 20) would make the line fall as the
lifter improves, the opposite of every other chart. A history that crosses
zero (assisted → bodyweight → weighted) draws as one continuous line through
the baseline.

The **volume chart is unaffected** — `setVolumeKg` floors each entry at
zero, so volume can never go negative.

### Bodyweight in charts

`effectiveLoadKg()` (weight + bodyweight for bodyweight/assisted exercises)
is used by both progression and by the volume/strength charts, so an
assisted pull-up at −45 with 80kg bodyweight registers everywhere as the
35kg set it is, not as zero. The `Math.max(0, …)` floor in `setVolumeKg`
still applies only to the case it's actually guarding: an assisted set with
no bodyweight on file, where the true load is unknown. With bodyweight
known, Epley also becomes valid on those lifts and the est-1RM series is no
longer suppressed; the chart notes this rather than silently changing what
its axis means.

### Entering a negative on a phone

`inputmode="decimal"` numeric keypads have no minus key on either iOS or
Android. Each weight input where the sign toggle is offered gets a `±`
button immediately to its left (the shared `'toggle-sign'` delegated action
— see "Event wiring" — same DOM-sibling contract as other row-local
wiring). The `min="0"` attribute is not present on these weight inputs,
since it would silently block a negative even where one could legitimately
be typed.

## Weight unit (kg canonical storage, display-only preference)

- **Every stored weight is kilograms, full stop.** `weightUnit` ('kg' | 'lb',
  Settings → Units) is purely a display/input preference. All business logic
  — progression increments, volume, the CSV importer, demo-seeding — works
  in kg internally and only converts at the UI edge.
- **Conversion helpers**: `toKg(displayValue)` and `fromKg(weightKg)` (exact
  factor `KG_PER_LB = 0.45359237`), plus `displayWeight(weightKg)` which
  wraps `fromKg` and rounds to 1 decimal for populating input values.
  `weightUnit` is a cached module-level variable (loaded once at init,
  updated on save) rather than re-read on every render.
- **Where conversion happens**: reading a weight input → `toKg()` before
  `logSet()`/`updateStandardSet()` (both take/store kg only); rendering a
  stored weight → `displayWeight()` for input values, `formatSetLine()` for
  read-only set-line text, `fromKg()` for the aggregate volume figure.
  `suggestForExercise()`'s progression math runs entirely in kg — only its
  returned `text` string is converted for display.
- **No per-set unit control anywhere** — there is exactly one global
  setting rather than a kg/lb `<select>` next to each weight field. Weight
  input placeholders show the current unit (e.g. "Weight (lb)").
- Switching the setting is instant and non-destructive — it only changes how
  existing kg values are displayed/entered going forward, never rewrites
  stored data. The units-save handler explicitly does **not** call
  `readIncrementGrid()`/`setSetting('equipmentStepsKg', ...)` — it only
  re-*displays* `equipmentStepsKg` in the new unit
  (`renderIncrementGrid()`); the stored kg values change only when the user
  actually saves Workout Settings, so flipping the unit toggle can't quietly
  re-round and rewrite every configured step (2kg → nearest lb option → back
  to a different kg value).

## AI plan generation (OpenRouter)

- Kept deliberately out of the per-set hot path — AI only generates plan
  *structure* (days, exercises, target sets/rep ranges); progression is
  100% the algorithm above.
- Called directly from the browser (`fetch` →
  `https://openrouter.ai/api/v1/chat/completions`) — confirmed
  CORS-enabled, so no backend/proxy is needed.
- API key + model string are user-supplied in Settings. **Plaintext,
  readable by any script running on the page.** Fine for single-user
  personal use; see the security section below.
- **Key persistence.** Saved on `change` (blur) — every setting in the app
  saves this way; there are no Save buttons anywhere in the Settings tab, so
  the value a field holds is always the value in effect — and the generator
  reads the **stored** key, never the input element. Mirrored into
  `localStorage` (`LS_PREFIX = 'ironlog.setting.'`) as well as IndexedDB,
  covering all settings: IndexedDB stays authoritative, `localStorage` is
  consulted only once, at load (see the settings cache under Storage & data
  model), and written on every save so it can't serve a stale value. Every
  access is wrapped in try/catch. A **Forget key** button (`clearSetting()`)
  removes it from all three places (IndexedDB, `localStorage`, in-memory) at
  once, and a live status line under the field states whether a key is
  stored, its length and last four characters, which stores it lives in, and
  that it is unencrypted.
- **Inputs sent to the model**: goal, a user-set target rep range
  (min/max, defaults 8–12), equipment, and free-text notes/constraints — set
  fresh per generation on the Plan tab's form — plus days/week and split
  type, which are **global settings** (Settings tab → Training Plan) rather
  than re-entered per generation.
- **Split type is prompt text and nothing else.** `planSplitType` builds one
  sentence ("Structure the split as: X.") and nothing else branches on it.
  The presets (Full Body / Upper-Lower / Push-Pull-Legs / Bro Split /
  PPL+Upper-Lower hybrid) are shorthand for sentences someone would
  otherwise type. A **Custom** option (`planSplitCustom`) accepts free text
  and substitutes for the preset label; both `'auto'` and a blank custom
  description resolve to the same empty string ("choose whatever fits").
  Custom text is kept when switching to a preset and back.
- **The request is streamed** (`stream: true`, SSE frames), with three
  separate limits doing three different jobs: `IDLE_MS` (60s) aborts only
  when nothing at all has arrived; `HARD_CAP_MS` (240s) is the backstop
  against a stream that never ends; `max_tokens` (16000) stops a rambling
  model reaching either. The abort path reports which limit fired and how
  many characters had arrived. OpenRouter's `: OPENROUTER PROCESSING` SSE
  comments count as activity for the idle timer (proving the request is
  alive), which is why the hard cap still has to exist independently —
  inactivity alone never fires during a long reasoning phase.
- **Reasoning tokens are tracked separately from content** (`delta.reasoning`
  / `reasoning_content`, never concatenated into the answer — scratch work
  is not an answer, and appending it would feed prose to `JSON.parse`).
  `finish_reason` and `usage` are captured too, so an unhelpful result is
  reported as one of: hit the token limit while reasoning, finished cleanly
  without emitting an answer, blocked by a content filter, or genuinely
  empty. The heartbeat has a "Thinking… N characters of reasoning" state
  distinct from "still waiting." A whole message arriving on the **final
  frame** (rather than as deltas) is also handled, since some providers and
  buffering proxies do this.
- **`aiChat()`** owns the request, SSE parsing, both timeouts, the
  reasoning/content split and the empty-response diagnoses; plan generation
  and the starting-weight pass both call it, and neither passes a `provider`
  argument. It reads its endpoint, headers, request body and HTTP-status
  error map from a small `AI_PROVIDERS` registry (`aiProvider(id)`) instead
  of hardcoding them — the registry, not `aiChat()` itself, is where a future
  service would be added. Every entry has to speak the same OpenAI-compatible
  SSE frame shape `aiChat()` parses (`choices[0].delta.content` /
  `.finish_reason`, `usage`, `data: {...}` / `data: [DONE]` lines); a
  provider whose stream doesn't match that shape would need a `parseFrame`
  hook added to the client. OpenRouter is the only entry the registry ships
  with, and there is no settings UI to pick another one.
- **Exercise selection is constrained to the existing library**: the full
  current `exercises` list (names only, minus disliked ones), embedded in
  the prompt with an instruction to choose exclusively from it. Matching
  against the store is case-insensitive with an auto-create fallback
  (tagged `unclassified`) if the model deviates anyway.
- **Previous plan is included for variety**: the most recently generated
  plan (day names and exercise lists only) is summarized into the prompt
  with an instruction to vary from it. First-ever generation skips this.
- Prompt requests strict JSON against a documented schema; response is
  parsed defensively (strips markdown fences, try/catch, validates `days` is
  an array), with user-facing errors mapped from OpenRouter's documented
  status codes (400 / 401 / 402 / 403).
- Per-exercise `repRangeMin`/`repRangeMax` in the response are honored if
  present; otherwise fall back to the plan-form rep range.

### Exercise preferences feeding generation (pinned / liked / disliked)

Managed from the Exercises tab: 📌 pin / 👍 like / 👎 dislike toggles,
backed by the separate `exercisePrefs` store. Like and dislike are mutually
exclusive with each other; disliking clears any pin (can't pin something
excluded); pinning clears any dislike.

All three are **prompt-only** — no post-processing of the AI's response,
keeping generation behavior legible from the prompt itself, at the cost of
inclusion relying on the model following instructions.
- **Disliked → hard exclusion**: filtered out of the prompt's exercise list
  entirely, so the model cannot choose them. Applies to manual Plan-tab Swap
  too, not just generation.
- **Pinned → always required**: every pinned exercise is listed with an
  explicit "you MUST include every single one of these," every generation.
- **Liked → required about half the time, per exercise**: each liked
  exercise independently gets a `Math.random() < 0.5` roll each generation;
  a hit gets the same "REQUIRED" wording as pinned for that request, a miss
  gets no mention that round. Deliberately not "always required" — that's
  what pinning is for — so plans stay varied instead of the same liked
  exercises appearing every time. An exercise that's both liked and pinned
  is treated as pinned only.

### Fixed set count per exercise

A Plan-tab control, defaulting to "let AI decide," **enforced on parse, not
merely requested** — still also sent in the prompt, since the model needs it
to balance the rest of the day. It interacts with the session-length budget
(next section): sets and exercise count are the model's two levers for
hitting a duration, so pinning one means the prompt names the other as the
remaining adjustment.

### The plan form remembers itself

The "Generate a new plan" form lives in a `<details class="disclosure">`
(`#plan-form-disclosure`) rather than a permanently-open section: `open =
!plan` in `refreshPlanTab()`, so it starts open when there's no plan yet
(the form IS the empty state) and collapses itself once one exists, out of
the way of the day-by-day view above it. It never forces itself shut on a
user who has opened it on purpose this session, though — a module-level
`planFormUserOpened` flag, set the moment the disclosure is toggled or the
form is submitted, tells `refreshPlanTab()` to stop touching `open` at all,
so reviewing the status log right after generating (which also calls
`refreshPlanTab()`, now that a plan exists) can't collapse the panel out
from under you.

Goal, equipment, rep range, set count and notes describe the lifter, not one
request. Each field saves on `change` (blur, if the value actually changed)
— the value must be safe by the time Generate is tapped, not only if a Save
button was pressed first — and the form reloads from those settings on
start-up. This is the same pattern every setting in the Settings tab now
uses: every field there saves on `change` too, and there are no Save buttons
left anywhere in Settings — a form with some fields live and others waiting
on a button made it impossible to tell which state was actually in effect.

The start-of-week regeneration prompt (see below) reads every input
**live**, falling back to the old plan's snapshot only where nothing has
been saved: if a constraint has been resolved and the note deleted, this
week's plan reflects what the form says today. The banner reads and quotes
the same live values it will send.

## Session time model

The plan generator and the Plan tab's per-day estimate share one model,
`estimateSessionMinutes()` / `sessionSetBudget()`, so they can never drift
apart.

### Asked in minutes, used as sets, converted from measurement

The user gives **minutes** (the real constraint — "an hour before work," not
"five exercises") rather than a set or exercise count (checkable by the
generator, but pushes an unnatural conversion onto the user). The app
converts using the user's own observed pace: sessions are already timed
(`startedAt` / `endedAt` / `durationMs`), so the terms are measured, not
assumed. The derived set-budget number is shown live in Settings as the
minutes are typed.

### Three terms

```
minutes = fixed + exercises × setup + sets × perSet
```

Splitting within-exercise gaps from between-exercise gaps is the crux:
resting between two sets of one lift is the rest interval; moving to the
next lift is that plus walking, waiting, reloading, and usually a warm-up
set. Each term is measured independently once there's history for it, so
partial data still helps:

| term | measured from | needs | outlier cap | fallback |
| --- | --- | --- | --- | --- |
| `perSet` | gaps between sets **of the same exercise** | 8 gaps | 10 min | `restDefault + 30s` |
| `setup` | gaps **between different exercises** | 5 changes | 20 min | the "where you train" preset |
| `fixed` | `durationMs` minus first-set→last-set span | 3 sessions | 0–60 min | 5 min |

Only sessions with `startedAt` are sampled; imported Fitbod sets carry
synthetic 1s-apart timestamps that would otherwise read as one-second sets.
An explicit **seconds per set** (`secondsPerSet`) or **setup seconds**
(`exerciseSetupSeconds`) override, if set, always wins over measurement.
Per-exercise pace has its own resolution ladder: an exercise's own median
once it has 3 intervals, otherwise the global `perSet` figure — an exercise
created five minutes ago still produces a sensible number. The Plan tab
shows the per-exercise estimate on each row and the summed total per day.

Medians rather than means throughout, with sessions filtered to 10–240
minutes (forgetting to press Complete leaves one session recorded at nine
hours, which a mean would carry forever).

**The model deliberately carries a small margin.** Gaps sit *between* sets,
so n sets yield n−1 rests, and the walk to the first station is already
inside `fixed`; charging every set a rest and every exercise a setup
over-counts by about one rest per exercise. The exact reconstruction,
`fixed + (exercises−1) × setup + (sets−exercises) × perSet`, is not shipped
— the measurement it would reconstruct is itself blind to real time (waits
past the cap are discarded, warm-up sets appear in no gap, the final set
plus walking away falls outside the last interval), and erring long is the
safer direction: an over-long estimate is visible and adjustable, an
over-short one silently prescribes a session that won't fit.

### "Where you train" — a prior, not a rival

The `setup` term takes a preset for its cold start: **commercial gym (4 min)
/ home gym with one bar and an adjustable bench (3.5 min) / home gym with
dedicated stations (2 min)**. Precedence is *typed override → measured
transitions → this preset*, so it only decides the window in which the
estimate is otherwise most wrong, and stops mattering once real transitions
have been observed. It is deliberately **not** a second variable feeding the
model — one number, several ways of arriving at it, measurement wins.

The naive framing ("home is faster") is wrong: a commercial gym's cost is
**contention** (waiting for a station at six o'clock); a home gym has none
of that, but one barbell and one adjustable bench makes every exercise
change a real **changeover** (strip and reload the bar, move the pins,
convert the rack). A combo home setup therefore lands nearer a commercial
gym than a fully-equipped one, and only dedicated stations are genuinely
quick. Across an eight-exercise day the choice is worth about 16 minutes.

## Plan tab vs Workout tab — editing vs doing

The core split: **Plan tab = shaping the plan** (permanent, affects every
future occurrence of that day). **Workout tab = doing today's workout**
(session-only, affects only today, self-reverting by construction).

**Plan tab** (`refreshPlanTab()` → `renderPlanDayOverview()`): a
read-only-ish structural view — every day, every exercise, its prescribed
`targetSets` × rep range, and a **Swap** button. No suggestion text, no
set-logging rows, no progress counts. Swap reveals a muscle-grouped
`<select>` of the full library (disliked exercises excluded) and writes
through `updatePlanDayExercise()`, replacing that slot's `exerciseId`/`name`
in the `plans` record permanently.

**Workout tab** (`refreshActiveWorkoutSection()` → `renderActiveWorkout()`):
the active-workout experience described under "Set logging UX" above. It
gets its own Swap, scoped to today only:
- **Session-only swap**: stored as
  `workouts.exerciseSwaps[originalExerciseId] = newExerciseId`, keyed by
  the plan slot's original exercise so the slot identity survives the swap.
  `renderActiveWorkout()` resolves this once per exercise
  (`effectiveExerciseId`/`effectiveName`) and uses the effective values
  everywhere. Shows "(swapped, today only)" next to the name. Written
  through `setSessionSwap()`, never touches the `plans` record.
- **Today-only target-set overrides**: `−`/`+` next to "N sets × min-max
  reps," stored as `workouts.targetOverrides[effectiveExerciseId]`.
  Self-reverting — a different date means a different `workouts` record
  with no override. Floor is whatever's already logged that day; no
  ceiling. Landing back on the plan's original value deletes the override
  key rather than storing a no-op.
- `deleteSet()`'s cleanup guard (don't delete an empty `workouts` record)
  also checks for `exerciseSwaps`, same reasoning as
  `targetOverrides`/`startedAt`.

## History tab — range, search, charts, collapsed sessions

### One range picker drives everything

A single `Showing:` select (30 days / 90 days / 6 months / 1 year / all
time, defaulting to **30 days**) filters both the charts and the session
list, so the graphs always describe exactly the sessions listed underneath
them. `historyRangeDays = null` means all time; the cutoff comparison is a
plain string compare against `YYYY-MM-DD`. **Today is included** in the
range, in both the charts and the list, labelled "Today," and is
edit-but-not-delete like every other history row.

### Search narrows the same set the range picker produces

Filtering happens at the **exercise** level, not the set level — it answers
"how has my bench gone?" rather than showing whole squat days that happened
to include a bench set, and set indices stay valid for the delete/inline-edit
handlers, which address a set by its position in `exEntry.sets`. The
filtered workouts are shallow copies, so nothing writes through to the
cached store. Debounced at 200ms.

### Sessions are collapsed by default

Each session is a `<details class="session">` with an always-visible
summary digest — date, plan day name, `N exercises · N sets · N kg ·
duration` — one tap from the full set-by-set detail. Expanded state is
tracked in an `openSessions` Set keyed by date, so editing a set inside an
expanded session doesn't snap it shut. The list is soft-capped at 40
sessions with a "Show all N sessions" button (`historyShowAll`).

### Charts

Hand-rolled inline SVG plus flex bars — no charting library, so nothing to
fetch and offline use is unaffected. Everything is sized by `viewBox` with
`width: 100%`, never measured pixel dimensions (these render while the
History panel is `display: none`). Five blocks, all fed from the same
in-range set (`historyRanged`):

- **Summary strip** — sessions, working sets, total volume, average session
  duration.
- **Training volume** (`barChartSVG`) — bucketed weekly up to a ~120-day
  span, monthly beyond it. Empty buckets draw as a 1px dim stub so a gap in
  training reads as a gap, not missing data.
- **Weekly sets per muscle** — horizontal bars, counted against each
  exercise's `primaryMuscle`. Sets, not volume (volume is dominated by heavy
  compounds and zero for bodyweight work). Per week, not a raw total —
  normalised against the ~10–20 hard-sets/week guidance in the strength and
  hypertrophy literature — divided by weeks actually **trained** (first to
  last session in range), not the calendar length of the range. Shows all
  16 muscles rather than a top 10, since the absent ones are the point.
  Built from flex/grid rows (not SVG) so muscle names stay real, selectable
  text; `.bar-track` and `.bar-fill` both set `display: block` explicitly
  plus a `min-width`, so a very small value still shows as a visible dot.
- **Sets per muscle over time** (`renderMuscleTrendChart`, `barChartSVG`) —
  the muscle chart above answers "everything, right now"; this answers
  "trending which way, for the one I picked." One selected muscle
  (`#history-muscle`, sticky across re-renders like the exercise picker
  below), bucketed identically to training volume via the shared
  `timeBuckets()` helper (see below) so the two bar charts can't disagree
  about where a week or month starts. Sets, not volume, for the same reason
  as the chart above — the legend and a hint line say so. The picker lists
  only muscles with at least one set in range, ordered by set count so the
  default is whatever's most trained.
- **Exercise progress** (`lineChartSVG`) — two series per session date for
  one selected exercise: top set weight (solid, with dots) and estimated
  1RM (dashed, Epley `w × (1 + reps/30)`). The picker lists every exercise
  with sets in range, ordered by set count, selection sticky across
  re-renders. Changing the exercise re-renders only this chart, not the
  whole `refreshLogAndHistory()` path.

**`timeBuckets(dates)`** is the bucket-boundary logic shared by the two
bar charts (training volume and sets-per-muscle-over-time): weekly buckets up
to a ~120-day span, monthly beyond it, plus one tick per month boundary.
Extracted from what used to be `renderVolumeChart()`'s own private bucket
construction so a second bucketed chart couldn't quietly land on different
week/month edges. Returns `{ mode, buckets, idx, ticks, keyOf }` — `keyOf(date)`
buckets one more date the same way, `idx` maps a bucket key back to its
index, and the caller accumulates into `buckets[i].value`. The **exercise
progress** line chart doesn't bucket at all (`lineChartSVG` plots one point
per session date on a continuous axis), so it builds its own ticks via
`monthStarts()` instead — both still render tick marks through the shared
`tickMarksSVG()`.

Every time-axis chart ticks on **month boundaries**, thinning labels to clear
a ~28-unit spacing; the year is appended (`Aug 26`) only when the range spans
more than one calendar year. Bars and dots carry SVG `<title>` elements for
desktop hover values. An empty range hides the whole `#history-charts` block
rather than stacking near-identical "no data" cards.

## CSV import (Fitbod export)

Settings → Import Data. Brings in workout history exported from Fitbod (one
row per completed set).

- Format assumptions were derived from a real export: columns `Date,
  Exercise, Reps, Weight(kg), Duration(s), Distance(m), Incline, Resistance,
  isWarmup, Note, multiplier`. Only `Date`, `Exercise`, `Reps`, `Weight(kg)`
  are required; the rest fall back to sensible defaults if missing.
- Every row in one session shares the exact same `Date` value (the session's
  start, not a per-set timestamp); rows are grouped by the local calendar
  date derived from it.
- **`multiplier` scales `Weight(kg)` to total load lifted**: 2.0 for
  dual-implement exercises (per-side weight), 1.0 for single-total-weight
  exercises, 0.0 for bodyweight/assisted/stretch work. Effective weight =
  `Weight(kg) * multiplier`, rounded to 2 decimals.
- **`multiplier: 0` splits into two cases, decided by `Weight(kg)`**, keyed
  off `multiplier === 0 && weight > 0` rather than a name regex:
  - `Weight(kg) > 0` — assisted machine work; that column holds the
    *assistance* and is stored as **negative** (`-45.36`), matching the
    app's convention.
  - `Weight(kg) == 0` — genuinely unloaded (stretches, Air Bike); these also
    carry `Reps: 0` and are skipped by the no-reps rule.
  The preview reports the count ("18 assisted set(s) detected and stored as
  negative weight") before committing.
- Warmup sets (`isWarmup: true`) are excluded, reported as a count.
- Rows with `Reps: 0` are skipped (duration-only cardio/stretch entries).
- Synthetic per-set timestamps: `sessionTs + rowIndexWithinThatDate *
  1000ms`, in original file order, purely to keep sets orderable within a
  day/exercise.
- **Exercise matching/creation** mirrors the AI-plan-generation path:
  case-insensitive (`nameKey()`) match against existing `exercises`;
  unmatched names get created as `custom:true`. Unlike AI generation, the
  importer runs each new name through `classifyMuscleFromName()` (see
  Equipment taxonomy & classifiers above) rather than tagging
  `unclassified`.
- **Preview-then-confirm**: selecting a file parses entirely client-side and
  shows a summary (set/day counts, date range, skip counts) without writing
  anything; "Confirm Import" commits it.
- **Merge or Replace, chosen per import** (`#import-mode`):
  - **Merge** (default): if a `workouts` record already exists for an
    imported date, imported sets are appended.
  - **Replace**: for each date in the file, the existing sets of each
    exercise *the file covers on that date* are cleared before the file's
    sets are written — scoped per exercise per day, so anything logged
    in-app for exercises the file doesn't mention survives untouched. The
    success message reports how many sets were replaced.

## Starting weight for a lift with no history

`estimateStartingWeight()` fills the blank box a new plan otherwise hands
the lifter. **Equipment class is the load scale** — "chest" alone spans a
barbell bench and a cable fly, an order of magnitude apart, but a chest
*cable* movement is reliably near other chest cable work, so the tiers stay
within one load scale wherever possible:

| tier | match | scaling | haircut |
| --- | --- | --- | --- |
| 1 | same muscle + same equipment | none | ×0.85 |
| 2 | same muscle, any equipment | `EQUIP_LOAD_RATIO` | ×0.75 |
| 3 | same region + same equipment | none | ×0.65 |
| — | nothing comparable | — | returns `null`, box stays blank |

**Compound vs isolation** is read off `secondaryMuscles` (a compound names
the muscles it borrows; an isolation names none) and preferred within each
tier — a new Pec Deck matches the fly (30kg), not an average with the bench
(50kg). It's only a *preference*: importer- and AI-created exercises get
`secondaryMuscles: []` and look like isolations regardless, so when nothing
matches the filter drops away and the tier behaves as before.

**It errs low, on purpose.** A too-light first set costs one set; a
too-heavy one on an unfamiliar movement costs a failed rep, which is where
people get hurt. **It refuses when it can't tell** — a confident wrong
number is worse than an empty field. Bodyweight movements open at **0**
(correct, not a guess, not tagged as an estimate); assisted work is matched
only against other assisted work and opens with *more* help, never less.

### The AI pass on top

Plan generation runs a **second, separate call** estimating starting
weights for any exercise in the new plan with no logged history. Kept
separate from the plan-structure call because the two questions want
different inputs — choosing exercises needs the catalog, guessing a load
needs the lifter's own numbers — and because a model knows real
cross-exercise relationships (an incline press runs ~80% of a flat press, a
hip thrust outweighs nearly everything) that the equipment-class taxonomy
alone cannot encode.

The heuristic stays as the floor, since the AI path is unavailable more
often than it's available (no API key, offline, a mid-session swap, a
hand-added exercise, a model returning nonsense).

**Guard rails**, because model output is untrusted:
- an estimate above **1.25× the heaviest set ever logged** is dropped;
- a negative weight on a non-assisted lift is dropped; assisted work must be
  negative and within a bodyweight-scaled bound;
- failures are **rejected, never clamped**, and the status log names each
  rejection;
- rejected exercises fall through to the heuristic, never to a blank box;
- the whole pass runs after the plan is saved and is wrapped, so a failure
  costs a nicety, never the plan.

Estimates are stored on the exercise record (`startingWeightKg`), so they
apply wherever the exercise appears and expire on their own: the moment a
set is logged, `suggestForExercise()` takes the history path and never
consults them again.

`EQUIP_LOAD_RATIO` values are judgement calls in the same spirit as
`ageRateMultiplier` — a defensible shape, not numbers from a study.
Dumbbells carry a real ambiguity: the Fitbod importer stores them as
*total* load (multiplier 2.0) while hand-entry is almost certainly *per
hand*, and nothing in the store distinguishes the two — which cancels
within tier 1 and is the main reason tiers 2 and 3 are deliberately timid.

## Weekly progress ("it's Wednesday, X to go")

Global settings (Settings tab → Training Plan): `planDaysPerWeek` (default
4) and `planSplitType` (default "let AI decide") — read by plan generation
and the weekly-progress readout alike, one standing answer to "how many
days a week am I training." The Plan tab shows a "This week" card: today's
weekday name, workouts completed since the most recent Monday, and how many
are left against the target (or "Target hit!"). Week boundary is
Monday-start (ISO-style), computed locally from the device's date. Counts
*any* workout day this week, not only ones tied to the active plan.
Recomputed fresh from the `workouts` store on every log/delete/settings-save.

## Start-of-week plan regeneration

It is a **prompt, never an automatic call** — generation spends real
OpenRouter credit, and a plan that rewrote itself in the background would
change the exercises out from under a half-finished week. The banner offers
one tap, reusing the previous plan's goal/equipment/notes/rep-range (stored
on the plan record) while reading days-per-week and split live. "This week"
is the same Monday-based week the weekly-progress counter uses. Dismissal
is stored as **the week it applies to**, not a boolean, so it expires by
itself next Monday with no cleanup — the same trick the today-only set
overrides use by living on a dated record.

## Persistent storage

Every IndexedDB origin starts out "best-effort" — a browser under storage
pressure can evict the whole database with no warning and nothing to catch
(Safari is the most aggressive about this, but it isn't the only one).
`requestPersistentStorage()` (02-storage.js), called once from `init()`
(12-init.js) after the database opens, asks the browser to move this origin
into the persistent bucket instead, where ordinary storage pressure won't
silently clear it alongside cache data.

- **Checks `navigator.storage.persisted()` first** and only calls
  `persist()` when it isn't already granted — once granted it stays granted
  (revoking it is a browser site-settings action, not something the app can
  see), so re-asking on every launch would just be noise.
- **Feature-detected (`navigator.storage && navigator.storage.persist`) and
  wrapped end to end in try/catch**, returning a plain `{supported,
  persisted}` result rather than ever throwing. A browser with no Storage
  API, or one that denies the request outright, loads exactly as it did
  before this existed — the same degrade-not-fail philosophy as the
  `dbAvailable` IndexedDB fallback above, one layer further out. The call
  itself is fire-and-forget from `init()` (`.then(renderStorageStatus)`,
  not awaited), so a slow or hung permission check can never delay startup.
- **The result is surfaced, not silent.** `renderStorageStatus()`
  (06-catalog-import-backup.js) paints a status line in Settings, next to
  the backup section — "Storage: persistent — the browser will not evict
  this data automatically" or "Storage: best-effort — export a backup
  regularly" — plus a usage/quota line (e.g. "1.2 MB of 60.0 GB quota
  used") from the separate, independently feature-detected
  `getStorageEstimate()` when `navigator.storage.estimate()` exists.
- Best-effort mode doesn't disable or degrade any feature — it's purely
  informational, a nudge toward the export button that already exists to
  insure against exactly this risk.

## Backup & restore

- **Export** writes one versioned JSON document (`format:
  "ironlog-backup"`, `version: 1`) holding workouts, exercises, prefs, plans
  and settings, plus `appDbVersion` so a future reader knows which schema
  wrote it.
- **The OpenRouter API key is deliberately excluded**, and restore never
  overwrites the key already on the device.
- **Restore is replace-only, by design.** Records are written back with
  their original ids, which is what keeps every cross-reference intact —
  plans reference exercises by id, and so do workouts. Merging two devices
  would mean remapping every id in both directions, a different and far
  more dangerous feature; the Fitbod importer is what *adds* history,
  restore is for a new phone or a wipe.
- Plain, human-readable JSON, so it outlives this app.
- **Validation is deep**, because restore clears every store and *then*
  writes: `validateBackup()` walks every workout, exercise entry, set and
  weight/reps pair before the destructive button is even offered, naming
  the first offender ("workout 3 (2026-01-14) has a set with no
  weight/reps entries. Nothing has been changed.").
- **`restorePut()`** preserves original ids across both storage backends
  (IndexedDB preserves them on its own; the in-memory fallback would
  otherwise assign fresh ones and shred every cross-reference), advancing
  the in-memory id counter past every restored id.
- **`applyRestore()`** is split out from the click handler so it is
  directly testable.
- **Delete All Workout History** (`clearWorkoutHistory()`, same file) sits in
  the same form, below restore. It clears only the `workouts` store — the
  exercise catalog, prefs, plans and settings survive — downloads a backup
  first by default (`safetyBackup()`), and confirms before running.

### Delivery: Share, as well as Download

"Download Backup" always works and never changes behavior — that path stays
the guaranteed fallback for desktop and for anyone on a phone who genuinely
wants the file in Downloads (to move it by cable, keep a local copy, or just
because that's what they're used to). A second button, "Share Backup…",
appears ALONGSIDE it (not replacing it) wherever the browser can hand a file
to the OS share sheet — the fastest way to get a backup off the device and
into whatever cloud app, chat or mail client the user actually uses, with no
account, no OAuth, and no API key for this app to manage.

- **`canShareFiles`** feature-detects once at load, with a throwaway probe
  file, not the real backup — building the real one may cost 600,000 rounds
  of PBKDF2 first (see "Encrypted backups" below), which is a poor price for
  deciding whether a button should render. It checks `navigator.canShare()`
  **with a file**, not just whether `navigator.share` exists: a browser can
  support sharing text/links while refusing files outright, and only asking
  about a file specifically catches that gap. The Share button is absent
  (not disabled) when the probe fails.
- **Re-checked at share time, on the real file**, with an unconditional
  fallback to `downloadFile()` if that check now fails, or if
  `navigator.share()` itself rejects for anything other than a cancel — the
  load-time probe is a best guess, and a share that turns out not to work
  still has a good file sitting in memory that deserves to reach the user
  some way.
- **`AbortError` — the user closing the share sheet — is not a failure.** No
  error is shown, and no backup is recorded. Any other rejection falls
  back to a plain download rather than leaving the user with nothing.
- **`buildExportPayload()`** is the one place that decides plaintext vs.
  encrypted content, shared by both buttons, so Share and Download can never
  drift into two slightly different builds of the same file. Works
  identically for encrypted exports — the `.enc.json` file shares (or
  downloads) exactly like the plain one.

### The "Last backup" reminder

A cloud backup nobody remembers to make isn't a backup. `lastBackupAt`
(epoch ms) is written by `recordBackupCompleted()` **only** when a download
or a share genuinely completes — never on a cancelled share sheet, and never
if encryption or the write throws first.

- Shown in Settings as a plain relative phrase — "Last backup: today",
  "Last backup: 34 days ago", or "No backup yet" — via `formatBackupAge()`,
  never a raw timestamp.
- **Stale at `BACKUP_STALE_DAYS` (30) days**, or if no backup has ever been
  made: the line gets a color change (`.stale`, reusing the app's existing
  accent color) and nothing else. No border, no card, no red banner — this
  app's voice is calm and factual, and a forgotten backup is worth noticing,
  not alarming.
- **`safetyBackup()`** (the pre-destructive-action download before "Delete
  All Workout History") also calls `recordBackupCompleted()` — it produces a
  real, complete backup file exactly like the Export button does, so the
  reminder has no reason to treat it as not counting.
- **Excluded from the backup file itself** (`BACKUP_EXCLUDED_SETTINGS`), and
  restored as a deliberate special case rather than as an ordinary setting:
  the restore-button handler sets it to the restored FILE's own
  `exportedAt`, not to "now". That's the honest value — restoring proves a
  backup exists as of that date, because the file just proved it, but
  crediting the moment of restore instead would overstate freshness: pulling
  in a nine-month-old file doesn't mean nine months of risk just vanished. A
  file too old or malformed to carry a valid `exportedAt` leaves whatever
  timestamp the device already had rather than guess.

### Encrypted backups (optional)

Export can OPTIONALLY encrypt the file with a passphrase — an unchecked
"Encrypt this backup with a passphrase" checkbox, plaintext left as the
default. Deliberately: the whole reason the plain format exists is that it
survives this app (readable in a text editor in ten years); mandatory
encryption would take that property away from every user to protect the
minority who want it.

- **WebCrypto only, no libraries.** `deriveAesKey()` runs PBKDF2/SHA-256 at
  600000 iterations over the passphrase and a fresh 16-byte random salt to
  derive a 256-bit AES-GCM key; `encryptBackupData()` generates a fresh
  12-byte random IV for every single encryption. Salt and IV are never
  reused — both come from `crypto.getRandomValues()` on every export, so two
  backups of identical data produce completely different ciphertext.
- **What gets encrypted is the WHOLE plaintext backup object** —
  `buildEncryptedBackup()` calls `buildBackup()` and encrypts its entire
  JSON, not just the `data` section. That is what lets `validateBackup()`
  decrypt and then recurse into its own ordinary, already-hardened
  validation path (the format marker check, the deep per-record checks
  above) instead of maintaining a second, weaker copy of that logic just for
  the encrypted case.
- **Envelope** (format marker unchanged — see "Naming & branding" below for
  why that string can never change): `{ format: 'ironlog-backup', version,
  encrypted: true, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations:
  600000, salt }, iv, ciphertext }`. `format`/`version` sit outside the
  ciphertext, readable without a passphrase, so a file can be identified as
  SplitCraft's and routed to the passphrase prompt before anything is
  decrypted. There is no plaintext `data` field on an encrypted envelope.
- **A wrong passphrase and a corrupted/truncated ciphertext fail the same
  way.** AES-GCM's authentication tag simply doesn't verify either way, and
  WebCrypto raises the same generic `OperationError` for both by design (so
  it can't be used as a decryption oracle to distinguish "wrong key" from
  "tampered data"). `decryptBackupData()` collapses that to one friendly
  message — "That passphrase didn't decrypt this backup." — instead of
  surfacing the raw exception to someone who just mistyped their passphrase.
- **Export requires the passphrase twice** (a confirm field) and refuses to
  proceed on a mismatch or an empty field, checked before the 600,000-round
  KDF ever runs. The field is paired with a plain, unmissable warning: a
  lost passphrase makes the file unrecoverable, by anyone, with no reset.
  600,000 PBKDF2 rounds is a real pause on a phone, so the export button
  reads "Encrypting…" and disables itself while it runs; the restore side's
  decrypt button shows the equivalent "Decrypting…" state.
- The downloaded filename carries `.enc.json` (`splitcraft-backup-<date
  stamp>.enc.json`) so an encrypted export is distinguishable from a plain
  one at a glance, without opening it.
- The test harness (`tests/harness.mjs`) hands its vm sandbox Node's own
  `globalThis.crypto` (plus `TextEncoder`, joining the `TextDecoder` that was
  already there) — a `vm.createContext` sandbox only gets globals explicitly
  listed on it, unlike a real browser or Node's own top-level scope, so the
  encrypted-backup code would otherwise see `crypto` as undefined. This runs
  the test suite against the exact same PBKDF2/AES-GCM code path a browser
  executes, not a stubbed substitute for it.

## Explicit non-goals / deferred items

- No editing of drop/myo sets — delete-and-re-add only.
- No multi-session-per-day support — everything lands in one date bucket.
- No OAuth-style OpenRouter key flow (PKCE) — currently a pasted static key,
  stored unencrypted. The one deferred item with a security consequence —
  see the security section below. PKCE needs an HTTPS origin, which
  deployment now provides, so this is unblocked.
- Automatic cloud sync (Drive/Dropbox/OneDrive, credentialed) not
  implemented, and not really deferred so much as **rejected** in favor of
  the OS share sheet — see "Backup delivery: share sheet over OAuth" in the
  decision log. What *is* implemented is manual delivery to any cloud a
  user's OS share sheet can reach, with zero credentials on this app's side.
- Exercise catalog is bundled + synced, not fetched from a real remote URL.
- Per-exercise increment override, sex as a rate multiplier, proximity to a
  strength standard — see Progression algorithm above for why each stays
  out.

## Data integrity — writes, identity and reads

### Writes are serialised

Every workout mutation is read → mutate → write with an `await` in the
middle, and they all contend for one record: today's workout. The nine
mutators queue behind **`withWorkoutLock()`**, since IndexedDB transactions
alone can't fix this (the read and write are separate transactions with
application logic between them). Reads are untouched. The Log button
additionally disables itself for the write — the lock makes a double-tap
*safe*, which is not the same as *wanted*.

### Set timestamps are unique

`logSet()` forces `ts` strictly greater than every other set logged that
day, scoped to the whole workout. Three things treat `ts` as identity or
order: `suggestForExercise()` sorts a session's sets by it,
`collectPaceSamples()` measures the gaps between them, and the RIR prompt
uses it (via `setSetRir()`) to find the set it asked about regardless of
any deletion that happened in between.

### The workouts store is read once per interaction

**`getAllWorkouts()`** caches the promise (not the array, so concurrent
callers during one render share a single read); every write path
invalidates it at the storage layer. The read is deliberately not bounded
to a date range even though the `date` index would allow it —
`suggestForExercise()` needs a lift's *whole* history to count sessions and
the clean-session streak, and a windowed read would make an infrequently
trained lift look brand new.

### `getWorkoutForDate()` is an indexed lookup

Backed by the `date` index (with the v3/v4 backfill and defensive fallback
described under Storage & data model above), so finding one day's record no
longer means scanning the whole store.

### Model output is deduplicated per day

A plan day could contain the same exercise twice (named twice, or via two
names that resolve to one record through `nameKey()`). The duplicate is
dropped at plan-build time, keeping the first — nothing downstream (the Log
tab's per-exercise `data-exid` addressing, the Plan tab's Swap) can tell two
rows for the same exercise apart.

## Error surfacing

Two listeners, `window.onerror` and `unhandledrejection`, both routed
through `reportUnexpected()`, which logs to the console and shows an error
toast. They recover nothing — they make failure legible. Messages are
deduplicated for 5s so a fault inside a render loop can't fire fifty
identical toasts, and the toast call is itself wrapped in try/catch so a
throw inside the error handler can't recurse past its own dedupe.

Render failures and write failures report separately: a repaint that throws
after a successful write (e.g. CSV import's post-write refresh) gets its
own `try/catch` and its own wording ("Import succeeded, but refreshing the
screen failed … your data is saved — reload the page") rather than reusing
the write's failure message. General rule: once a write is committed,
nothing after it may report as a write failure. Every
`row.querySelector('.x').addEventListener(...)` chain inside a render
`forEach` is null-guarded and resolved once into a local, so one malformed
row can't abort the rest of the render.

## Verification

Node is installed, so `tests/` runs the real `<script>` in a `vm` context
against a stub DOM (`node tests/run.mjs`). Top-level `function` declarations
attach to the vm context, so the tests call the app's own implementations
directly (`const` arrows do not, so anything defined that way is testable
only through a function that uses it).

Three suites: `test.mjs` (classifiers against the real Fitbod export,
catalog agreement, progression maths), `gen.mjs` (the whole plan-generation
path against a stubbed OpenRouter, including that a fixed set count is
enforced), and `ui.mjs` (seeds demo data, re-renders every tab, then fires
every handler the render paths left behind — handlers must actually be
*fired*, not merely assigned, since wrong-variable bugs only throw when a
handler runs, and stub inputs need real values since guards like
`isNaN(parseFloat(input.value))` skip the interesting half of a handler on
an empty stub). `timing.mjs` and `features.mjs` cover concurrency, the rest
timer's deadline arithmetic, backups, ramped-session progression, the
session-time model, and the plan form's persistence.

**Static checks** (kept alongside execution, since they cover things
execution doesn't reach — unrendered branches, encoding): lexical balance
(a tokenizer that skips strings/template literals/comments/regex before
counting brackets); a scope check inside `forEach` callback bodies; a
template-literal interpolation check (every bare `${identifier}` must
resolve to a binding in its own function or module level); a wired-class
check (a class wired with `querySelectorAll` must be reachable from markup
the same function renders); a TDZ check (`const`/`let` read before its own
declaration); element-id existence and uniqueness; a null-guard scan on
`querySelector(...).addEventListener` chains; classifier cross-checks
against the catalog and the Fitbod vocabulary; settings symmetry (every
`setSetting` key is read somewhere with `getSetting`); and an encoding
check for mojibake. See `tests/docs.mjs`, which additionally checks this
file against the source for stale constants, undocumented settings keys,
and retired claims that shouldn't still be asserted.

`node --check` alone would catch none of the runtime-only bugs these were
each added for — it validates syntax; the bugs are all in code that parses
perfectly. See Part 2 for what each check was written to catch.

## KNOWN SECURITY ISSUE — OpenRouter API key at rest (FIX BEFORE SHARING)

**Status: accepted for the testing phase, deliberately. Must be resolved
before this file is given to anyone else or served from real hosting.**

**What it is.** The OpenRouter API key is stored unencrypted, in two places
on the user's device: the `settings` object store in IndexedDB, and
`localStorage` under `ironlog.setting.openrouterKey`. It is readable by:
- any JavaScript running on the page — including anything injected via an
  XSS hole, a malicious browser extension with host access, or a
  bookmarklet;
- anyone with filesystem access to the browser profile (both stores are
  plain files on disk; neither is encrypted at rest by the browser);
- anyone with physical or remote access to an unlocked session, via
  DevTools in about four keystrokes.

**Why it is worse than it looks.** An OpenRouter key is a *billing*
credential. Exfiltrating it doesn't leak training data — it lets someone
spend the owner's money against arbitrary models until the key is revoked
or credits run out. The blast radius is financial, not informational, which
is exactly the kind that doesn't announce itself.

**Why it was accepted anyway.** Retyping a ~70-character secret on every
page load made the AI features unusable during development. The
alternatives all cost more than the testing phase can justify right now
(see below). The mitigations actually in place: the key is never
transmitted anywhere except `https://openrouter.ai` over TLS; a status line
under the field states in plain language that the key is stored
unencrypted and who can read it; a **Forget key** button clears all three
copies in one tap; and the docs recommend a spend-limited key.

**Options for the real fix, roughly cheapest-first:**

1. **Spend-limited key + short expiry, documented as the supported path.**
   Costs nothing to build; caps the loss rather than preventing it. This is
   the honest minimum and should ship regardless of what else is done.
2. **OAuth PKCE against OpenRouter.** Gets rid of the long-lived static
   secret entirely and is the correct answer for a distributed app. Needs a
   real HTTPS origin and a redirect URI, so it is blocked on deploying the
   PWA — which is already the next planned step.
3. **Encrypt at rest with a passphrase** (WebCrypto, PBKDF2/AES-GCM, key
   held only in memory for the session). Defeats offline profile theft.
   Does **not** defeat XSS or a malicious extension, since the decrypted
   key is in memory while the page runs — so it buys less than it appears
   to and costs a passphrase prompt per session. Middling value.
4. **Session-only storage** (`sessionStorage`, or in-memory only). Trivial,
   and exactly the behaviour that made this annoying enough to change. Only
   sensible if the app stops needing the key routinely.

**Recommendation when this is picked up:** do (1) immediately as
documentation, and do (2) as part of the PWA deployment work — the two are
naturally the same piece of work, since PKCE needs the HTTPS origin that
deployment provides anyway. Skip (3); it defends the least likely attack.

## Visual design

Dark theme (`#0e1013` background), amber accent (`#f0a93a`),
monospace/tabular numerals for all logged weight/rep data, mobile-first
single column. Deliberately avoided the common AI-generated-design defaults
(cream background + terracotta accent, etc.).

Everything visual keys off CSS custom properties declared once on `:root`
— a four-step surface ramp (`--bg` → `--surface` → `--surface-2` →
`--surface-3`), a radius scale, a shadow scale, and semantic colour roles
(`--accent` / `--ok` / `--danger`, each with a matching `-soft` fill and
`-line` border). Depth comes from that ramp plus soft shadows rather than
heavy 1px borders, and there is a single fixed radial glow behind the top of
the page for warmth. No images, no web fonts, no external assets.

### Navigation

Tabs live in a **fixed bottom tab bar** with inline SVG icons — the thumb
zone on a phone, staying reachable while a long set list scrolls. The JS
contract is `.tab-btn[data-tab]` → `#panel-<tab>`; switching also scrolls to
top and needs no per-tab JS, so adding a tab is markup-only. `viewport-fit=
cover` plus `env(safe-area-inset-bottom)` padding keeps the bar clear of the
iPhone home indicator. `theme-color` / `apple-mobile-web-app-capable` /
`color-scheme: dark` match an installed-to-homescreen instance to the app
chrome.

Five tabs: Workout, History, Plan, **Exercises**, Settings — in that order,
Exercises sitting between Plan and Settings. Tab label is "Workout"
(`data-tab="log"`, `#panel-log` internally — the attribute values are a
contract referenced in a dozen places and weren't worth renaming for
something invisible to the user). At 10.5px, five labels still fit the bar;
`.tab-btn` padding and the bar's own gap were trimmed slightly from the
four-tab values to keep "Exercises" (the longest label) from wrapping on a
narrow phone.

### Touch targets

A pass specifically for mid-workout, one-handed, phone use:
- A `--tap: 44px` token backs delete (×), pin/like/dislike, Swap, and the
  today-only set-count buttons; primary buttons are 48px.
- All text inputs are 16px — below that, iOS Safari zooms the viewport on
  focus and doesn't zoom back out.
- RIR buttons are the full 44px and colour-coded: red (went to failure) →
  amber (the productive middle) → green (comfortable) → blue (too light),
  so the scale reads at a glance. Colour is supplementary — every button
  still shows its number and carries an `aria-label` spelling out the
  meaning.
- Rows wrap (`flex-wrap: wrap`) with `min-width` floors on inputs where a
  row has more than a couple of controls, so a cramped row reflows onto a
  second line on a narrow phone rather than every control shrinking to an
  untappable sliver.

### Log tab layout

- **Session and volume share one card** as a two-column `.stat-grid`; the
  session value is colour-coded by state (dim when not started, green while
  running).
- **The manual entry form is collapsed into a `<details>` disclosure** by
  default (see "Manual entry" above).
- Native selects are restyled with an inline SVG chevron (data URI) instead
  of the platform default.
- The weekly-progress card has a bar that fills toward the target and turns
  green on completion.
- Empty states are centred in a dashed box and say what to do next.
- The Settings exercise list has a name filter — a pure view filter, never
  affecting what the picker or the AI sees. Exercise-manager rows use the
  sans font, not monospace (monospace looked like data, not names).
- Saving a setting shows a shared `toast(message, kind)` rendered into a
  fixed `#toast-host` above the tab bar. Inline `.success-box` is kept only
  where the message is worth re-reading (the CSV import summary), and
  `.error-box` for anything the user must act on.
- Every interactive control has a `:focus-visible` outline and inputs get
  an accent ring.
- `prefers-reduced-motion` disables all transitions and animations.
- Pinch-zoom is not suppressed — `maximum-scale` is not present in the
  viewport tag, so every browser that honours it (Chrome on Android; iOS
  Safari has ignored it since iOS 10) allows pinch-to-zoom. Every text input
  being 16px is what actually stops iOS auto-zooming on focus, so nothing
  else depends on suppressing pinch-zoom.

---

# Part 2 — Decision log

Each entry: what the earlier behaviour was, why it was wrong, what replaced
it. Grouped by area, kept short — the reasoning is the point.

## Exercise catalog & sync

**Custom exercises had a delete `×`.** Every row got one, calling
`deleteRecord('exercises', id)` immediately with no confirmation. Two
problems: after a Fitbod import every row is `custom:true`, so the list
became a wall of destructive buttons a thumb-width from the muscle
dropdown; and delete never checked whether sets referenced the exercise, so
removing one orphaned its history (`exercisesById[id]` → `undefined` in
every past session that used it). Replaced with muscle reassignment as the
only edit; deletion of an exercise with history isn't recoverable and
shouldn't be one mis-tap away.

**The catalog sync silently reverted hand-edits.** Settings offered a
muscle *and* equipment dropdown for every row, built-ins included, but
`syncDefaultExercises()` had no exemption for edited rows — the next page
load re-managed the field and quietly undid the change. A control that
reports success and then reverts is worse than one that isn't offered.
Fixed by stamping `userEdited:true` on either dropdown's use, which hands
that row over permanently.

**Name matching used to be exact.** Fine while the catalog was small;
growing it to 92 entries on top of an existing Fitbod import turned every
punctuation difference into a duplicate row ("Assisted Pull Up" vs
"Assisted Pull-Up"). `nameKey()` was introduced to fix the sync, then found
to be needed everywhere else too: the Fitbod importer and the AI plan
matcher both still compared on bare `toLowerCase().trim()`, so a model
answering "Pull Up" against a catalogued "Pull-Up" forked a duplicate
`custom` exercise tagged `unclassified` — splitting that lift's history in
two (breaking its progression suggestion) and adding a phantom Unclassified
bar to the weekly-sets chart. `nameKey()` now lives in Helpers and is used
by all name-resolving paths.

**Cross-checking the catalog against the classifier caught four real
mismatches**: `/\bdip\b/` didn't match "Dips" (plural), no rule matched "…
Dumbbell Press" without the word "bench," and "Seated Cable Row"/
"Chest-Supported Row" were tagged `upper_back` in the catalog while the
classifier and six sibling rows said `lats`. All four fixed; the check now
passes 92/92. The catalog also grew from 34 to 92 entries because
`adductors`, `forearms` and `lower_back` had zero defaults and five more
muscles had exactly one — the weekly-sets chart drew bars for muscles a
fresh install had no way to fill, and the AI planner had nothing to reach
for when a day called for a lower-back or grip movement.

**The exercise list moved out of Settings onto its own tab.** It had lived
under Settings → Exercise list, rendered as one row per exercise with two
selects and three buttons — past 100 rows after a Fitbod import — sitting
below a page mostly made of one-off forms (units, profile, workout
defaults, OpenRouter, training plan). It wasn't a *setting* in the sense the
rest of the page was: no form to submit, no single value to change, just a
heavy always-rendered list a settings page had no particular reason to
carry. Given its own tab (see "Exercises tab" in Part 1) and rebuilt
search-first — a name, a muscle chip and preference indicators per row,
with the two selects and pref buttons revealed only on tap — so the common
case (search, glance, done) doesn't cost rendering the two-select,
three-button form for every one of 92-plus rows up front.

## CSV import

**`multiplier: 0` used to zero out assisted sets.** Naively multiplying by
0 silently destroyed the weight on every assisted machine set — that column
actually holds the *assistance*, and zeroing it made a 100lb-assisted
pull-up indistinguishable from an unassisted one. Fixed by splitting on
`Weight(kg) > 0` (assisted, now stored negative) vs `== 0` (genuinely
unloaded, already skipped by the no-reps rule).

**Fixing that bug required a re-import path.** The destroyed weight is
unrecoverable from storage — the CSV is the only source of truth — so
without a Replace mode, anyone who had already imported before the fix
couldn't get corrected data without doubling every set via Merge. Replace
was added: for each date the file covers, clear that date's *matching
exercises only* before writing, scoped per exercise per day so anything
logged in-app elsewhere on the same day survives. This also retired the old
"only run it once, no dedup" caveat — not because dedup was solved, but
because "the file is the source of truth for the days it covers" is a
simpler rule that covers the same case.

**Fitbod muscle classification rules were wrong before a verification
pass.** "Rear Delt Fly" and the three TRX Deltoid Flys scored as chest;
"Cable Hip Extension," "Superman" and "Vertical Knee Raise" scored as
nothing at all. Fixed by verifying the ordered rule list against the full
66-name Fitbod vocabulary plus an ~80-name battery of common gym movements.

## Rest timer

**It used to be a permanent card** near the top of the workout tab: a 44px
countdown, a progress bar and four buttons (Start/Pause/Reset plus ±15s),
the largest single block on the page — mattering for ninety seconds after a
set and dead weight the rest of the session, while pushing the actual set
list below it. Replaced with the fixed bottom sheet described in Part 1:
`hidden` until a set is logged, auto-dismissing after the beep.
Start/Pause and Reset were dropped entirely — a rest timer that starts
itself doesn't need a Start, and Reset only mattered when the sheet was
permanent furniture.

**Two silent bugs in the first version of the sheet.** `background:
var(--surface-1)` referenced a token that doesn't exist (the palette is
`--surface` / `--surface-2` / `--surface-3`); CSS drops an unresolvable
`var()` without complaint, so the sheet rendered transparent. There is now
a check that every `var(--x)` resolves to a declared property. Separately,
the dismiss/adjust buttons were written as literal `−` / `×` in
static HTML markup — those are JavaScript string escapes and mean nothing
outside a JS string context, so in markup they rendered as the literal
six-character text. Fixed to `&minus;` / `&times;` HTML entities; the
`\uXXXX` sequences elsewhere in the file are all correctly inside template
literals in `<script>`.

**Logging a set used to resume, not restart, the timer.** `startRestTimer()`
previously called `startTimer()` with no arguments, which resumed whatever
time was left on the clock rather than starting fresh — so logging a set
mid-countdown handed the lifter a short, arbitrary rest instead of a full
one. Fixed by always restarting from the configured rest length.

**One `AudioContext` per beep leaked.** `beep()` used to construct a fresh
`AudioContext` on every call and never close it. Browsers cap how many a
document may hold (Chrome at six); past the cap the constructor throws,
straight into a deliberately silent `catch`, so the rest timer went mute
partway through a session and stayed mute until reload. Fixed to one
lazily-created, reused context.

## Set logging UX / touch targets

**Reps had ±/− steppers; they are gone.** A `wireRepsSteppers(container)`
helper once put 40×40px stepper buttons around every reps input (active
row, inline edit, and the free-form entry form) to compensate for cramped
row layout. Once the row was simplified to `[n] [weight] [reps] [Log]` (from
a seven-element `[n] [±] [weight] [−] [reps] [+] [Log]`), the inputs became
wide enough to type in directly, and the steppers — along with
`button.stepper-btn` — were removed rather than kept as redundant chrome.

**Set rows used to wrap onto two lines.** `.plan-log-row` and `.entry-row`
were `flex-wrap: wrap` so a seven-control row (weight, reps stepper pair,
unit select, action button) reflowed instead of squeezing everything
illegibly small, with the Log button forced onto its own full-width line.
Once the row was cut down to four elements the wrap was no longer needed
for that purpose, and sets are now `flex-wrap: nowrap` — one line per set,
same height, scans as a column. (Rows with genuinely more controls, e.g.
in Settings, still wrap.)

**A `flex-wrap: nowrap` regression on the old seven-element row was itself
a bug worth recording**: tightening it to one line broke `.log-btn`'s
`flex-basis: 100%`, since a `nowrap` row can't honor a 100%-basis child —
flexbox instead shrank every sibling to fit beside it, producing a giant Log
button next to an unusably narrow weight field. That specific failure mode
is moot now that the row has four elements and stays `nowrap` correctly.

**A 278-character suggestion line above every exercise.** `why` clauses
used to be joined into one prose sentence — six or seven lines of
accent-coloured text per exercise before reaching a single input, forty
lines of explanation on a six-exercise day. `suggestForExercise()` now
returns `why` as an array of terse tags rendered as chips beside a sentence
kept under ~110 characters.

**The sign toggle used to be unconditional.** Every weight input gained a
`±` button regardless of equipment class, cluttering the vast majority of
rows that could never legitimately go negative. Restricted to
assisted-equipment rows, rows with an existing negative set today, or a
negative suggestion — see Part 1's "sign toggle is conditional" rule. The
manual free-form entry form kept it unconditional, since its exercise
choice isn't known at render time.

**"Everything logged today" was a second, redundant render of the day's
sets**, directly below the active-workout list, re-showing what History
already covers. Logging a set shrank the page under a shrinking
`scrollY` max and the browser clamped the scroll position to the new
bottom — so every log left the user staring at the floor of the page. Fixed
by removing the list (`renderExerciseGroup()` is now used only by History),
collapsing finished exercises in place instead of hiding them at the
bottom, and scrolling only the next incomplete exercise into view
(`revealNextOnRender`, `block: 'nearest'`).

**A finished exercise used to still draw a trailing blank row.** `totalRows`
was `Math.max(target, done + 1)`, so a finished 3-of-3 exercise drew a
fourth "4+" row with empty inputs, reading as though the last set had been
un-logged. Fixed to stop at `doneCount` once complete.

**RIR used to be a `<select>` in the logging row**, answered *before* the
set was performed — when the number wasn't known yet. Moved to a
post-set prompt card (now in the bottom sheet). It was also originally
collected on every set and averaged, which both cost more taps and was less
accurate: fatigue accumulates within a session, so a mean of 2 might be
4/2/0 — a session whose final set went to failure, reported as comfortably
submaximal. Reading only the binding set (last, or top on a ramp) fixed
this. The old rule additionally required *every* set to carry a value
before RIR counted at all, so logging just the sensible one (the last) was
silently ignored; the prompt now only appears where it's read. The
per-set signal this gave up — distinguishing under-loaded (first set
already easy) from under-recovered (first set already hard) — had no reader
anywhere in the app, so nothing was lost in practice.

**The warm-up ramp is a fixed percentage schedule, not a measured one —
deliberately**, unlike almost everything else in this app's progression and
session-time models. The session-time model can measure `perSet`/`setup`
because real timestamps exist on real logged sets; warm-ups are exactly the
sets nobody logs (see `logSet()` — there is no "log a warm-up" affordance
anywhere), so there is no history to derive a personalised ramp from. A fixed
50/70/85% schedule was chosen over inventing a measurement that doesn't
exist.

## Progression algorithm

**Rounding the target percentage up to the nearest loadable step destroyed
the model.** 2% of a 100kg bench is 2.0kg; the bar moves in 2.5kg steps;
rounding up made every modifier — 3 RIR, cutting, age 55 — produce the
identical 2.5kg. The settings looked live and weren't. A 2.5kg floor also
collapsed novice, intermediate and advanced into the same increment on
every upper-body lift below ~125kg. Fixed by converting a sub-step target
into a frequency (clean sessions before the smallest jump) instead of
rounding the size — see Part 1's rounding-floor table.

**Ramped sessions used to anchor on the first set.** Anyone who ramps to a
top set (60×8, 70×6, 80×4) had the model read the working weight as the
60kg warm-up, then wait forever for a 60kg set to hit the top of the rep
range — a frozen "stay at 60kg" suggestion that looked like a considered
recommendation rather than a bug. Fixed by detecting ramped sessions
(not all sets at one weight) and anchoring on the top set instead.

**Unit mismatch used to be a real gap.** Before the v5 migration, sets
carried their own `unit`, and the same exercise logged in kg one session and
lb the next compared as raw numbers, silently breaking the streak. Fixed by
moving to canonical kg storage (see "Weight unit" migrations in Part 1); the
0.05kg `sameWeight` tolerance now only absorbs float/round-trip noise, not a
unit confusion.

**`clearedTop()` used to compare every session against the plan's set
count**, so a day shortened with the today-only adjuster could never count
as cleared, however well it went — one legitimate 2-of-3 session silently
blocked progression from then on. Fixed by judging each session against the
override actually stored on its own workout record. The data was already
there; nothing was reading it.

**The bodyweight field had no visible unit and a kg-flavoured placeholder**
("e.g. 80") regardless of the display unit — a silent 2.2× error in the
progression base with nothing on screen to catch it. Fixed by driving
label, placeholder, step and value from one function
(`refreshBodyweightField()`).

**`effectiveLoadKg()` was introduced for progression only and never reused
for charts.** The engine treated an assisted pull-up at −45 with 80kg
bodyweight as the 35kg set it is, while `setVolumeKg()` still floored it to
zero — every bodyweight and assisted set contributed nothing to daily or
weekly volume, so three sets of dips read as no work at all. Fixed by
sharing `effectiveLoadKg()` between progression and the volume/strength
charts.

**Drop sets and myo-rep sets were excluded from progression entirely**,
filtered out with `s.type === 'standard'` in both `recentTopSetByExercise()`
and the history built in `suggestForExercise()`. A session logged only as
myo or drop sets therefore had an empty progression history and read as a
brand-new lift no matter how much real work was in it. Volume-based counting
(summing every entry, the way `setVolumeKg()` already does) was considered
and rejected: volume mixes loads across the drops/clusters into one number
that says nothing about whether the *working* weight was ready to move, and
it's already shown separately as the day's volume figure. Fixed by judging
each set on its FIRST entry only (`workingEntry()`) — the weight and reps
actually done at the working weight, before the set is deliberately extended
past normal failure — regardless of `type`. This is the same unit a
straight/ramped standard set already contributes, so no other progression
logic (ramped-session detection, `sameWeight`, the clean-session streak)
needed to change.

## History charts

**`.bar-fill` rendered at zero size.** `.bar-track` and `.bar-fill` are both
`<span>`s; `width`/`height` don't apply to a non-replaced inline element.
`.bar-track` happened to work because it's a direct grid item (grid items
are blockified), but `.bar-fill` is nested one level deeper and got no such
help — the numbers were right while the bars were invisible. Fixed by
setting `display: block` explicitly on both rather than relying on the
parent's layout mode.

**The negative-weight axis had an inverted-scale bug.** The unconditional
`Math.max(0, vMin)` put `vMin` above `vMax` whenever all values were
negative, inverting the chart. Fixed with the conditional min/max logic
described under "Charting a negative load" in Part 1.

**The weekly-sets-per-muscle chart used to show a raw total, not a
rate.** "40 sets" means something completely different over one week versus
six months, so bars could only be compared to each other, never to any
external target. Fixed by normalising to sets/week.

## Session time model

**The model used to be `sets × perSet` alone**, and it priced an
8-exercise, 24-set day at 48 minutes against a real session nearer 90. The
missing time was structurally absent, not a bad constant: no walking
between stations, no loading plates or moving pins, no queueing for a rack,
no warm-up sets (invisible to any per-set count), nothing for arriving or
leaving. Because `sessionSetBudget()` is the number the plan generator is
told to fit, this wasn't only a display bug — a 45-minute target used to buy
23 working sets (hence generated days running to 90 minutes); the
three-term model now buys about 12 for the same budget. Fixed by splitting
into `fixed + exercises × setup + sets × perSet`, each measured
independently — see Part 1.

**Sessions without a Start press starved the pace model.** Every term above
is measured only from sessions with `startedAt`, but Start was an easy step
to forget under a bar — and a forgotten Start didn't just lose that one
session's overhead measurement, it made the day invisible to
`collectPaceSamples()` too, throwing away the per-set and per-exercise-setup
signal from the sessions where the estimate is needed most (a lifter who
never presses Start never accumulates any measured history at all). Fixed by
auto-starting the session on the first logged set (`logSetLocked()`,
02-storage.js) and flagging it `startedAuto: true`, distinct from an
explicit Start. `collectPaceSamples()` counts auto-started sessions exactly
like explicit ones; only `sessionOverheadSamples()` excludes them, since an
auto session's `startedAt` already sits at the first set and has no real
arrival gap left to measure — see "Workout session" in Part 1.

## Data integrity

**Concurrent writes to the same day could silently duplicate or lose
data.** Every workout mutation is read → mutate → write with an `await` in
the middle; two overlapping calls (a double-tapped Log button, or a tap
landing mid-refresh) both read the pre-write state and the second write
won. Worse when no record existed yet: both calls took the `if (!workout)`
branch and both created one, and because the `date` index wasn't unique,
`getWorkoutForDate()` only ever found the first — the second day's sets
vanished from the active workout and from today's volume while still
appearing as a duplicate "Today" row in History. Fixed with
`withWorkoutLock()` serialising the nine mutators; IndexedDB transactions
alone couldn't fix it since the read and write are separate transactions
with application logic in between.

**`ts` used to be plain `Date.now()`.** Consecutive logs land inside the
same millisecond easily — a burst of six sets could share one timestamp —
and three things (`suggestForExercise()`'s sort, `collectPaceSamples()`'s
gap measurement, the RIR prompt's set lookup) were leaning on incidental
array order instead. Fixed by forcing `ts` strictly increasing within a
workout.

**`getWorkoutForDate()` used to scan the whole `workouts` store** to find
one record, even though a `date` index existed and had simply never been
wired up. **`suggestForExercise()` re-read the entire store per exercise** —
a six-exercise day did seven full reads where one would do — fixed by
`renderActiveWorkout()` reading once and passing the array down. **CSV
import called `getWorkoutForDate()` once per date** — 33 full scans for a
33-day export, quadratic against a long history — fixed with one `Map`
built up front.

**`getSetting()` used to be an IndexedDB (or in-memory) read on every call.**
With ~70 call sites, several inside per-exercise render loops — a
`getSetting()` per row was a storage read per row, on a day's worth of
exercises, on every repaint. Fixed by loading every setting into a `Map`
once (`loadSettings()`, called from `init()`) and having `getSetting()` and
the new synchronous `getSettingSync()` just read it; `setSetting()` and
`clearSetting()` keep the map current on every write, so nothing downstream
of a save ever sees a stale cached value. `suggestForExercise()`'s `profile`
parameter (a caller-prefetched `{experienceLevel, age, energyBalance}`
bundle, added specifically to avoid three `getSetting()` calls per exercise)
is gone with it — the cache makes that trick unnecessary, since a direct
`getSettingSync()` call inside the function is now exactly as cheap as
reading a pre-fetched local.

**A duplicate exercise within one plan day used to desync the UI silently.**
The Log tab addresses today's sets by exercise id, so two rows sharing a
`data-exid` both showed the same logged sets, one "Log" tap ticked both off,
and the Plan tab's Swap edited whichever slot `findIndex` hit first while
leaving the other untouched. Fixed by deduplicating at plan-build time.

**`restoreSet()` is addressed by `(date, exerciseId, ts)`, not
`(workoutId, exerciseId, index)`.** Those are exactly the coordinates a
delete handler has on hand, and neither survives to the moment Undo is
tapped: deleting a day's last set deletes the whole `workouts` record (see
`deleteSetLocked` above), so the old `workoutId` may no longer resolve to
anything, and any set logged in the gap between delete and Undo shifts every
later index. `restoreSet()` recreates the record if it's gone (the same
empty shape `logSetLocked()` uses) and re-finds or recreates the exercise
entry, so it works whether the day still exists or not. A set with the
restored `ts` already present is a no-op rather than a duplicate, guarding
against a double-tapped or double-fired Undo.

**`restorePut()` didn't exist at first, and `putRecord()` couldn't stand in
for it.** In the in-memory fallback, `putRecord` looks up an id, finds
nothing (restore has just cleared the store) and assigns a fresh one —
silently shredding every cross-reference in the backup, since ids are the
only thing tying a plan or workout to its exercises. Left unfixed, this
turned 92 exercises into 58, with plan days full of "Unknown exercise," in
a database that looked populated and rendered without error.

## Verification

Every static check listed in Part 1 was added after a specific bug slipped
past execution testing:

- **Wrong-variable references in `forEach` bodies.** The Log button in the
  active workout silently did nothing — tapping it threw `ReferenceError:
  row is not defined` before `logSet()` ran, with no error surfaced. An edit
  had added an RIR lookup as `readRir(row.querySelector(...))` inside a
  `.forEach(group => …)` body, where the element actually in scope was
  `group`; `row` was a real identifier a few lines further down, in a
  *different* callback, which is why it read as plausible. This is the
  second bug of exactly this shape from bulk editing (the first deleted
  four weight inputs outright). Neither was visible to brace-balance
  checks, `getElementById` existence checks, or the pre-existing null-guard
  scan (which only looks at `.addEventListener`/`.value`/`.onclick` chains,
  not at whether the receiver itself exists). Fixed by adding a scope check:
  for each `forEach(param => {…})` body, collect the parameter plus every
  binding in the enclosing function, then flag any `X.querySelector` /
  `.dataset` / `.closest` / `.value` where `X` is in neither set nor a known
  global. The general lesson: resolve an element once alongside the other
  inputs and guard it there, rather than querying inline inside a handler.
- **TDZ read-before-declaration.** `logPlanStatus(...${budget}...)` was left
  sitting ~20 lines above `const budget = …`, throwing "can't access lexical
  declaration 'budget' before initialization" and breaking plan generation
  outright. Brackets balanced, the identifier was declared, and it was in
  the right function — only the order was wrong, which nothing else could
  see. Fixed with a check for "no binding of that name at or before the
  read, but a `const` after it at an indent no deeper" (sibling blocks each
  declaring their own `input` stay quiet), skipping lines inside
  multi-line template literals by backtick parity.
- **A wrong-scope `const` splice.** A value was built inside a settings
  helper while the prompt that used it lived in the generator — spliced in
  by an anchor that matched twice — which would have thrown `ReferenceError`
  on the next run. Fixed with an interpolation check: every bare
  `${identifier}` in a template literal must resolve to a binding in its
  own function or module level. Deliberately narrow (a bare `${x}` is
  unambiguously a variable read) rather than a general undeclared-identifier
  scan, which produced hundreds of false positives from identifier-shaped
  words in prose and regex bodies.
- **A wired-but-unreachable class.** The expand chevrons did nothing:
  wired with `querySelectorAll` in `renderPlanDayOverview`, but actually
  rendered in `renderActiveWorkout` — the selector matched nothing, the
  wiring loop ran zero times, and the control was silently inert. Fixed
  with a check that a class wired via `querySelectorAll('.x')` in one
  function must be reachable from markup that same function builds
  (narrowed to functions that assign `.innerHTML`, and to classes rendered
  in exactly one function, so shared generic helpers like `delegate()` or
  `syncSignClass()` don't trip it). Per-render wiring of this shape is gone
  now — see "Event wiring" and the next entry.
- **Per-render `.onclick` loops replaced with delegated actions.** Every
  render function used to end with one or more
  `container.querySelectorAll('.x').forEach(el => { el.onclick = ... })`
  passes — 19 of them, plus several `addEventListener('change', ...)` pairs
  — re-run on every repaint. Two costs, one of them a live bug class: the
  wasted work of re-walking and re-closuring the whole subtree on every
  logged set, and the exact "wired-but-unreachable class" shape from the
  entry above, which static analysis alone had already caught once and
  could not be trusted to catch every time by hand. Replaced with
  `delegate()` — one listener per container, `data-action`-keyed, against a
  registry of named functions (see "Event wiring" in Part 1). Named
  registries, not anonymous closures, specifically because of how this
  project catches wrong-variable bugs: `tests/ui.mjs` fires every handler a
  render path leaves behind, and an anonymous `e => e.target.closest(...)`
  delegated listener gives a test nothing to invoke — the interesting half
  of every handler would silently stop being exercised. Exposing each
  registry via `actionRegistries()` (only top-level `function`s attach to
  the test harness's `vm` sandbox; `const` registries don't) let the test
  suite call every handler directly with a stub element instead, the same
  trade division of labor the harness already uses for `.onclick`/
  `.onchange` properties.
- **Naive bracket counting missed brackets inside string content.** An
  unbalanced file could still total correctly if the imbalance was hidden
  inside a string or template literal. Fixed with a tokenizer that skips
  strings, template literals (including nested `${}`), comments and regex
  literals before counting.
- **A render failure reported as a data failure.** CSV import wrapped its
  post-write repaint in the same `try` as the writes, so a rendering
  exception surfaced as "Import failed: …" directly above a message
  reporting 562 imported sets — the data was fine, but the message sent the
  user looking for a data problem that didn't exist. Fixed by giving the
  repaint its own `try/catch` and its own wording.
- **The design summary itself went stale.** Nine settings keys had
  accumulated in the code with the doc's list untouched, among other drift.
  `tests/docs.mjs` now checks constants, settings keys, store fields and a
  short list of retired claims against the source on every run — the origin
  of the "two-part" structure this document now uses.

## Weight unit

**Sets used to carry their own `unit` field.** Per-set kg/lb `<select>`
controls existed in the manual entry form, the active-workout rows, and
inline set-editing. All three were removed once `weightUnit` became a
single global display preference (v5 migration), since a per-set choice
made no sense once storage was uniformly kg.

## Visual design

**Saving a setting used to reveal an inline "Saved." box** that shifted
layout and needed its own timeout-driven show/hide per form. Replaced with
the shared `toast()` helper.

**A mixed save model (some fields on `change`, some behind a Save button)
confused which state was live.** The API key and model fields, and the whole
Plan tab's generation form, already saved on `change` — but the five forms
in the Settings tab (units, profile, workout, OpenRouter, Training Plan)
still required a Save press, so a field edited and then abandoned mid-session
(switched tabs, closed the browser) sometimes stuck and sometimes didn't,
depending only on which form it happened to live in. There was no way to
tell from the screen which behaviour applied to a given field. Fixed by
moving every remaining Settings-tab field onto the same `change` pattern —
see "The plan form remembers itself" in Part 1 — and removing the five Save
buttons entirely; the `<form>` elements stay, with a `submit` listener that
only calls `preventDefault()` so Enter in a number field doesn't reload the
page.

**`maximum-scale=1` used to sit in the viewport tag**, suppressing
pinch-zoom on every browser that honours it. It was there to stop iOS
zooming a field on focus — a job already done by every input being 16px,
which is what actually prevents that zoom. The trade-off was being paid for
nothing: removing `maximum-scale` cost nothing the font-size fix wasn't
already covering, and restored pinch-to-zoom for anyone wanting to magnify
a set number in a badly lit gym.

**`History` tab's delete-locking comment used to contradict the code.**
`renderExerciseGroup()`'s own comment claimed past sessions were fully
"locked in … only today's log stays correctable," which made the still-live
weight/reps inputs in History read as a bug. The comment was wrong, not the
behaviour (deletion is what's locked, not editing); the comment now says
so.

## Naming & branding

**The app was renamed from Iron Log to SplitCraft**, and the shipped file
from its previous name to `splitcraft.html`, ahead of moving the app to a
new origin. Every display string, filename reference and doc heading was
updated to match. The three on-disk storage identifiers — the IndexedDB
database name `ironlog`, the `localStorage` prefix `ironlog.setting.`, and
the backup file's `format: "ironlog-backup"` marker — were deliberately
**left unchanged**: they are keys under existing user data, not branding,
and renaming them would silently orphan every workout, setting and backup
file already on a device. Cosmetic strings that merely display the old name
(the downloaded backup filenames, the OpenRouter `X-Title` header, the
backup's human-readable error text) were renamed freely, since nothing reads
them back to find data.

## Persistent storage & encrypted backups

**The app never asked the browser not to evict its own data.** Every
IndexedDB origin defaults to "best-effort," and the "Backup & restore"
section above existed as insurance against exactly that, but insurance
isn't the same as reducing how often the loss happens. Fixed by
`requestPersistentStorage()`, checking `persisted()` before ever calling
`persist()` so a browser that already granted it is never re-asked, and
surfacing the outcome in Settings rather than leaving it invisible — a user
relying on this for months of history has a right to know which mode
they're in.

**Encryption was considered mandatory, briefly, and rejected.** A backup
that's always encrypted is safer against a stolen laptop or a leaked cloud
folder, but it directly destroys the property "Backup & restore" was built
around: a file readable in a text editor decades from now, independent of
this app still existing. Optional-and-off-by-default keeps both properties
available, each to the user who actually wants it, rather than trading one
away by default for everyone.

**The encrypted envelope reuses `validateBackup()` rather than duplicating
its checks.** An early sketch had a separate `validateEncryptedBackup()`
that re-implemented the deep per-record checks against the decrypted data.
Rejected once it was clear the two would drift the moment one of them
changed — silently loosening validation for exactly one of the two backup
formats, which is the same "two copies of the same logic" failure the
CSV-import and progression-algorithm sections elsewhere in this document
warn about. `validateBackup()` instead decrypts and recurses into itself,
so an encrypted file is checked by the literal same code path as a
plaintext one.

**A wrong passphrase and a corrupted ciphertext were, at first, two
different error messages** — WebCrypto actually makes that distinction hard
to draw honestly (see "Encrypted backups" in Part 1: AES-GCM's tag
verification fails identically either way, by design), so a message that
claimed to tell them apart would sometimes have been guessing. Collapsed to
one honest message that covers both: "That passphrase didn't decrypt this
backup."

## Backup delivery: share sheet over OAuth

**Google Drive OAuth and a GitHub-token backup were both considered, and
both rejected**, for the same underlying reason: this is a local-first app
with no account and no backend, and either option would introduce the one
thing that design has never needed — a credential this app has to request,
store, refresh and eventually explain how to revoke. A Drive integration
means an OAuth client, a consent screen, and a refresh token sitting in the
same browser storage as the training data it's meant to protect. A
GitHub-token backup means asking a lifter to mint a personal access token
and paste it into a fitness app — a real security downgrade dressed up as a
convenience, and a support burden the moment the token expires or scope
changes. Both would also lock a user into one specific provider, which is
exactly backwards for a file whose entire design point ("Backup & restore"
in Part 1) is a format that outlives any one vendor.

**The Web Share API was chosen instead because it reaches every destination
credential-free.** `navigator.share({ files })` hands the backup to whatever
the OS already has configured — Drive, Dropbox, iCloud, email, Signal,
anything registered as a share target — without this app ever holding, or
even seeing, a single credential for any of them. The honest cost, stated
plainly rather than buried: it can't be automatic. The Web Share API
requires a live user gesture and refuses to run on a timer or in the
background, so there is no "back up every night while you sleep" version of
this feature without going back to exactly the OAuth/token machinery this
decision avoids. A manual share beats no backup, and it beats a credential
this app has no business holding.

**Two buttons, not one that changes behavior.** An early sketch had "Share"
silently replace "Download" wherever `canShare({files})` passed, on the
theory that Share subsumes Download for anyone who can use it. Rejected: a
person on a phone can legitimately want the file in Downloads too — to
move it by cable, to keep an on-device copy, or just because a share sheet
adds a step they don't want that day — and hiding Download the moment a
device happens to support Share would take away a working option nobody
asked to lose. The two now sit side by side; Share is additive, never a
replacement.

## Cloud backup: Dropbox

**This section doesn't overturn the rejection above — it narrows what
"a credential" means until one clears the bar.** Drive OAuth and a
GitHub-token backup were rejected as *any* long-lived, broadly-scoped
credential this app would have to hold. Dropbox's OAuth shape is a
different, smaller thing on every axis that mattered to that rejection:

- **PKCE (RFC 7636)** means this public, secret-less static page runs the
  entire OAuth flow itself — no server anywhere ever holds a `client_secret`,
  unlike a conventional OAuth confidential client.
- **`token_access_type=offline`** still gets a PKCE (public) client a
  refresh token from Dropbox, which is what makes this different from Drive:
  Drive's short-lived access tokens have no refresh path for a client with no
  confidential secret to authenticate a refresh call with, which was the
  concrete reason Drive got ruled out as "not really automatic" before it
  even reached the credential-storage question. Dropbox's refresh call needs
  only the refresh token and the (non-secret) client ID.
- **"App folder" access**, not "Full Dropbox": the app is registered so a
  leaked token can only ever reach the one folder Dropbox creates for it,
  never anything else already in the user's account. The rejected
  GitHub-PAT option had no equivalent scoping short of the user hand-rolling
  fine-grained permissions themselves.
- **The refresh token is excluded from the backup file itself**
  (`BACKUP_EXCLUDED_SETTINGS`, same mechanism as `openrouterKey`), so the one
  new credential this app holds can never ride along inside the very file
  it's used to deliver.

None of that makes it credential-free — it still asks the user to authorize
an app, and still stores a refresh token in the browser storage next to the
training data. That's why Download and Share aren't going anywhere: Dropbox
is a third, opt-in option sitting alongside them, reusing the same
encryption checkbox and the same `buildExportPayload()`/`recordBackupCompleted()`
plumbing, not a replacement for either.

**The upload call needed a CORS workaround, not just an access token.**
Dropbox's `/2/files/upload` endpoint expects `Authorization` and
`Dropbox-API-Arg` as HTTP headers, which are non-"simple" for CORS purposes
and would trigger an OPTIONS preflight — one Dropbox's own upload endpoint
doesn't handle from an arbitrary browser origin with no server in front of
it. The fix is Dropbox's own documented escape hatch: move both values into
URL query parameters (`authorization`, `arg`), add `reject_cors_preflight=true`,
and send the body as a plain string so `fetch` defaults its `Content-Type`
to the CORS-safelisted `text/plain;charset=UTF-8`. The whole request then
qualifies as a CORS "simple request" and the browser sends it directly.

**The client ID is deliberately hardcoded in source, in a public repo.** A
PKCE "App key" is not a secret in the way a `client_secret` is — Dropbox's
own PKCE guide expects it to ship in public client-side code, the same way
a Google OAuth client ID is routinely visible in a browser's network tab.
Anyone can see it; nobody can do anything with it without also completing
their own user-consent redirect through Dropbox's site, which is the actual
security boundary PKCE relies on.

**Why a refresh token and not a session held only in memory.** A
memory-only access token would force reconnecting on every single page
load — Dropbox does not treat this app as "logged in" across reloads any
other way. That would make cloud backup less convenient than the Share
button it's meant to sit alongside, for a device most people load once and
leave open for weeks. The refresh token is the one piece of state that has
to survive a reload for the feature to be worth having; `getDropboxAccessToken()`
still re-derives a short-lived access token from it on every call rather than
persisting one, and forgets the refresh token outright the moment Dropbox
rejects it (revoked, expired, or permissions changed) rather than retrying
the same failure forever.
