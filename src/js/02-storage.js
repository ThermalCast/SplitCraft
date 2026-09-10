  // 02-storage.js — Storage layer: openDB through the workout mutators, localStorage mirror, settings, prefs
  // =========================================================================
  // Storage layer
  //
  // Five IndexedDB stores:
  //   workouts      — one record per calendar day trained. { date, ts,
  //                   planId, dayIndex, dayName, exercises: [{ exerciseId,
  //                   sets: [{ts, type:'standard'|'drop'|'myo', entries:
  //                   [{weight,reps}, ...]}] }], targetOverrides: {exerciseId:
  //                   number} }. `weight` is always kilograms — sets no
  //                   longer carry their own unit (removed in the v5
  //                   migration); the app has exactly one global display
  //                   unit (settings.weightUnit) converted at the UI edges
  //                   only, never stored. planId/dayIndex/dayName are set
  //                   when at least one set that day was logged against a
  //                   plan day (via the Plan tab); null otherwise.
  //                   targetOverrides holds today-only set-count
  //                   adjustments (see "Today-only target-set overrides"
  //                   below); absent unless the user has adjusted one for
  //                   that day.
  //   exercises     — { name, primaryMuscle, secondaryMuscles: [], custom:
  //                   bool }. `custom:false` rows are a local mirror of
  //                   DEFAULT_EXERCISES, re-synced on every load (see
  //                   syncDefaultExercises) — treat them as read-only/managed
  //                   by the app, not user data. `custom:true` rows are
  //                   entirely user-owned (added via quick-add, Settings, or
  //                   an AI-generated plan naming something new) and are never
  //                   touched by the sync.
  //   exercisePrefs — { exerciseId, pinned, liked, disliked }, keyPath
  //                   `exerciseId` (one row per exercise that has any
  //                   preference set). Deliberately a separate store from
  //                   `exercises` rather than fields on it, so the exercise
  //                   catalog can be swapped/updated (see above) without ever
  //                   touching what the user has pinned/liked/disliked — see
  //                   "Exercise preferences" below for how these feed into AI
  //                   plan generation.
  //   plans         — AI-generated (or hand-edited) training plans
  //   settings      — key/value pairs (API key, model, rest timer default,
  //                   planDaysPerWeek, planSplitType, weightUnit)
  //
  // Replaced the old per-set `sets` store (v2) with one workout object per
  // day, grouping exercises and their sets together instead of one flat
  // record per set — matches how a session is actually thought about, and
  // lets weekly-progress counting ("2 of 4 done this week") just count
  // workout records instead of re-deriving session boundaries from
  // timestamps. Existing v2 `sets` data is migrated into this shape on
  // upgrade (see openDB's onupgradeneeded), then the old store is dropped.
  //
  // If IndexedDB isn't available (e.g. this preview sandbox), everything
  // falls back to in-memory arrays so the app still works for the session —
  // it just won't survive a reload. See dbAvailable below.
  // =========================================================================
  // Deliberately still 'ironlog' after the app was renamed to SplitCraft:
  // this is the IndexedDB database name, not branding. Renaming it would
  // point every user at a brand-new empty database, making every workout
  // they've already logged invisible.
  const DB_NAME = 'ironlog';
  const DB_VERSION = 5;
  let db;
  let dbAvailable = true;
  const memory = {
    workouts: [], exercises: [], exercisePrefs: [], plans: [], settings: {},
    nextId: { workouts: 1, exercises: 1, plans: 1 }
  };

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB not available')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        const tx = e.target.transaction;

        if (!database.objectStoreNames.contains('exercises')) {
          const s = database.createObjectStore('exercises', { keyPath: 'id', autoIncrement: true });
          s.createIndex('primaryMuscle', 'primaryMuscle', { unique: false });
        }
        if (!database.objectStoreNames.contains('exercisePrefs')) {
          database.createObjectStore('exercisePrefs', { keyPath: 'exerciseId' });
        }
        if (!database.objectStoreNames.contains('plans')) {
          database.createObjectStore('plans', { keyPath: 'id', autoIncrement: true });
        }
        if (!database.objectStoreNames.contains('settings')) {
          database.createObjectStore('settings', { keyPath: 'key' });
        }

        if (!database.objectStoreNames.contains('workouts')) {
          const workoutsStore = database.createObjectStore('workouts', { keyPath: 'id', autoIncrement: true });
          workoutsStore.createIndex('date', 'date', { unique: false });

          if (database.objectStoreNames.contains('sets')) {
            // Migrate legacy per-set records (v2) into per-day workout objects.
            // Also normalizes weight to canonical kg and drops the per-set
            // `unit` field here (skipping the separate v5 pass below, since
            // that only targets an already-existing `workouts` store).
            const byDate = {};
            tx.objectStore('sets').openCursor().onsuccess = (ev) => {
              const cursor = ev.target.result;
              if (cursor) {
                const rec = cursor.value;
                if (!byDate[rec.date]) byDate[rec.date] = {};
                if (!byDate[rec.date][rec.exerciseId]) byDate[rec.date][rec.exerciseId] = [];
                const entries = rec.unit === 'lb'
                  ? rec.entries.map(en => ({ weight: Math.round(en.weight * KG_PER_LB * 100) / 100, reps: en.reps }))
                  : rec.entries;
                byDate[rec.date][rec.exerciseId].push({ ts: rec.ts, type: rec.type, entries });
                cursor.continue();
              } else {
                Object.keys(byDate).forEach(date => {
                  const exercises = Object.keys(byDate[date]).map(exId => ({
                    exerciseId: Number(exId),
                    sets: byDate[date][exId].sort((a, b) => a.ts - b.ts)
                  }));
                  const ts = Math.min(...exercises.flatMap(ex => ex.sets.map(s => s.ts)));
                  workoutsStore.add({ date, ts, planId: null, dayIndex: null, dayName: null, exercises });
                });
                database.deleteObjectStore('sets');
              }
            };
          } else if (e.oldVersion > 0 && e.oldVersion < 5) {
            // v3/v4 -> v5: existing workouts already have per-set `unit`
            // fields (kg or lb) — normalize every lb-denominated weight to
            // kg and strip `unit` entirely, since storage is now always kg.
            workoutsStore.openCursor().onsuccess = (ev) => {
              const cursor = ev.target.result;
              if (!cursor) return;
              const workout = cursor.value;
              let changed = false;
              workout.exercises.forEach(ex => {
                ex.sets.forEach(s => {
                  if (s.unit === 'lb') {
                    s.entries.forEach(en => { en.weight = Math.round(en.weight * KG_PER_LB * 100) / 100; });
                    changed = true;
                  }
                  if ('unit' in s) { delete s.unit; changed = true; }
                });
              });
              if (changed) cursor.update(workout);
              cursor.continue();
            };
          }
        } else if (e.oldVersion > 0 && e.oldVersion < 5) {
          // workouts store already existed (this is a v3/v4 -> v5 upgrade,
          // not a fresh install) but wasn't just (re)created above — run the
          // same unit-stripping pass as the branch above.
          const workoutsStore = tx.objectStore('workouts');
          // This store predates the 'date' index added above when the store
          // is freshly created — back-fill it here so lookups can use it too.
          if (!workoutsStore.indexNames.contains('date')) workoutsStore.createIndex('date', 'date', { unique: false });
          workoutsStore.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const workout = cursor.value;
            let changed = false;
            workout.exercises.forEach(ex => {
              ex.sets.forEach(s => {
                if (s.unit === 'lb') {
                  s.entries.forEach(en => { en.weight = Math.round(en.weight * KG_PER_LB * 100) / 100; });
                  changed = true;
                }
                if ('unit' in s) { delete s.unit; changed = true; }
              });
            });
            if (changed) cursor.update(workout);
            cursor.continue();
          };
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function idbAdd(store, record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }
  function idbPut(store, record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }
  function idbGet(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }
  function idbGetAll(store) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }
  function idbDelete(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // ONE deserialisation of the workouts store, reused until something writes
  // to it.
  //
  // `workouts` is the biggest store and the most re-read: logging a single set
  // used to send the entire training history through getAll() four separate
  // times before the screen settled (the history render, the week counter, the
  // active workout, and every progression suggestion on the day). That cost is
  // proportional to total history and grows forever — invisible at 30 days,
  // sluggish at three years.
  //
  // The obvious alternative was a bounded read: the `date` index is right
  // there, so History could pull only the selected range. That is wrong for
  // this app, and worth writing down so it doesn't get "fixed" later:
  // suggestForExercise() walks a lift's WHOLE history to count sessions
  // (experienceForLiftHistory) and to count the consecutive-clean-session
  // streak. Feed it a 30-day window and a lift trained fortnightly reads as a
  // brand-new movement and gets novice-rate jumps. The read has to be
  // complete; what it must not be is repeated.
  //
  // The promise is cached rather than the array, so concurrent callers during
  // one render share a single read instead of racing to start several.
  let workoutsCachePromise = null;
  function invalidateWorkoutsCache() { workoutsCachePromise = null; }
  function getAllWorkouts() {
    if (!workoutsCachePromise) {
      // A rejected promise is still truthy, so caching it as-is would leave
      // every future call short-circuiting on `if (!workoutsCachePromise)`
      // straight into the same failure forever, with nothing to retry it
      // until an unrelated write happened to invalidate the cache. Clearing
      // it here on rejection lets the next caller start a fresh read, while
      // concurrent callers sharing THIS promise still share the one failure
      // (and the one read) rather than each kicking off their own.
      workoutsCachePromise = getAllRecords('workouts').catch(err => {
        workoutsCachePromise = null;
        throw err;
      });
    }
    return workoutsCachePromise;
  }

  async function addRecord(store, record) {
    if (store === 'workouts') invalidateWorkoutsCache();
    if (dbAvailable) return idbAdd(store, record);
    const id = memory.nextId[store]++;
    record.id = id;
    memory[store].push(record);
    return id;
  }
  async function putRecord(store, record) {
    if (store === 'workouts') invalidateWorkoutsCache();
    if (dbAvailable) return idbPut(store, record);
    const idx = memory[store].findIndex(r => r.id === record.id);
    if (idx >= 0) { memory[store][idx] = record; return record.id; }
    const id = memory.nextId[store]++;
    record.id = id;
    memory[store].push(record);
    return id;
  }
  async function getAllRecords(store) {
    if (dbAvailable) return idbGetAll(store);
    return memory[store];
  }
  async function getRecord(store, id) {
    if (dbAvailable) return idbGet(store, id);
    return memory[store].find(r => r.id === id);
  }
  async function deleteRecord(store, id) {
    if (store === 'workouts') invalidateWorkoutsCache();
    if (dbAvailable) return idbDelete(store, id);
    memory[store] = memory[store].filter(r => r.id !== id);
  }
  // Writes a record back under the id it ALREADY carries, creating it if the
  // store has no such row.
  //
  // Restore depends on this and putRecord() cannot do it. In the in-memory
  // fallback, putRecord() looks the id up, finds nothing (restore has just
  // cleared the store), and helpfully assigns a fresh one from the counter —
  // which silently shreds every cross-reference in the backup, because ids are
  // the only thing tying a plan or a workout to its exercises. The IndexedDB
  // path preserves ids on its own; this makes both backends agree.
  //
  // The counter is advanced past every restored id too, or the next quick-add
  // would hand out an id that is already in use.
  async function restorePut(store, record) {
    if (store === 'workouts') invalidateWorkoutsCache();
    if (dbAvailable) return idbPut(store, record);
    const idx = memory[store].findIndex(r => r.id === record.id);
    if (idx >= 0) memory[store][idx] = record; else memory[store].push(record);
    if (memory.nextId[store] != null) {
      memory.nextId[store] = Math.max(memory.nextId[store], (Number(record.id) || 0) + 1);
    }
    return record.id;
  }

  // Used by restore, which rewrites every store wholesale.
  async function clearStore(store) {
    if (store === 'workouts') invalidateWorkoutsCache();
    if (store === 'settings') settingsCache.clear();
    if (!dbAvailable) {
      if (store === 'settings') memory.settings = {}; else memory[store] = [];
      if (memory.nextId[store]) memory.nextId[store] = 1;
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }
  // Settings (and only settings) are mirrored into localStorage alongside
  // IndexedDB. Two independent reasons:
  //   1. When IndexedDB is unavailable the whole app falls back to in-memory
  //      state, so every setting dies on reload. For workout data that's
  //      already flagged by the storage warning; for the OpenRouter API key
  //      it means retyping a 70-character secret on every single load.
  //   2. The two stores fail independently. A browser or profile that blocks
  //      IndexedDB (file:// origins, some privacy modes) often still allows
  //      localStorage, and vice versa.
  // IndexedDB stays authoritative — localStorage is consulted only when the
  // primary store has nothing for that key, and is written on every save so
  // it can't drift into serving a stale value. Settings are a handful of
  // small scalars, so the duplication costs nothing.
  // Deliberately still 'ironlog.setting.' after the app was renamed to
  // SplitCraft: this is a localStorage key prefix, not branding. Renaming it
  // would orphan every setting already saved under the old prefix, including
  // the stored OpenRouter API key.
  const LS_PREFIX = 'ironlog.setting.';
  function lsGetSetting(key) {
    // Any of these can throw rather than return null: disabled storage,
    // opaque origins, quota-exceeded profiles. Never let it break a read.
    try { return localStorage.getItem(LS_PREFIX + key); } catch (e) { return null; }
  }
  function lsSetSetting(key, value) {
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch (e) { /* non-fatal */ }
  }
  function lsRemoveSetting(key) {
    try { localStorage.removeItem(LS_PREFIX + key); } catch (e) { /* non-fatal */ }
  }

  // Settings cache. getSetting() used to be an IndexedDB (or in-memory) read
  // on EVERY call, and there are dozens of call sites — several of them
  // inside per-exercise render loops, where a getSetting() per row was an
  // IndexedDB read per row. Settings are a handful of small scalars that
  // change on user action, not per render, so there is no reason to re-read
  // storage for them on every call: they are loaded into this Map once, and
  // every read after that is a synchronous Map lookup. Writes go through
  // setSetting()/clearSetting(), which keep the map current, so nothing
  // downstream of a write ever sees a stale cached value.
  const settingsCache = new Map();
  let settingsLoaded = false;

  // Populates the cache from storage. IndexedDB (or the in-memory fallback)
  // is read first since it is authoritative; the localStorage mirror is then
  // consulted ONLY for keys the primary store has nothing for at all — same
  // "primary wins, mirror fills the gap" rule getSetting() used to apply on
  // every call, just applied once here instead. Called once from init(),
  // before loadSettingsIntoForm(). applyRestore() does not need to call this
  // again: it writes every restored setting through setSetting(), which
  // keeps the cache current on its own.
  async function loadSettings() {
    settingsCache.clear();
    if (dbAvailable) {
      (await idbGetAll('settings')).forEach(rec => settingsCache.set(rec.key, rec.value));
    } else {
      Object.keys(memory.settings).forEach(key => settingsCache.set(key, memory.settings[key]));
    }
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const lsKey = localStorage.key(i);
        if (!lsKey || !lsKey.startsWith(LS_PREFIX)) continue;
        const key = lsKey.slice(LS_PREFIX.length);
        if (settingsCache.has(key)) continue; // primary store already has it
        const raw = lsGetSetting(key);
        if (raw === null) continue;
        try { settingsCache.set(key, JSON.parse(raw)); } catch (e) { /* malformed mirror entry — skip it */ }
      }
    } catch (e) { /* localStorage unavailable — cache just has fewer keys */ }
    settingsLoaded = true;
  }

  // Kept `async` in name only, so every existing `await getSetting(...)`
  // call site (and the tests') keeps working unchanged — the read itself is
  // synchronous now, since the actual storage read happened once, in
  // loadSettings().
  async function getSetting(key, fallback) {
    if (settingsCache.has(key)) return settingsCache.get(key);
    if (settingsLoaded) return fallback;
    // The cache isn't populated yet (called before loadSettings() has run,
    // which shouldn't happen in the app itself but is cheap to guard against)
    // — fall back to the old direct read rather than returning a false miss.
    if (dbAvailable) {
      const rec = await idbGet('settings', key);
      if (rec) return rec.value;
    } else if (Object.prototype.hasOwnProperty.call(memory.settings, key)) {
      return memory.settings[key];
    }
    const mirrored = lsGetSetting(key);
    if (mirrored === null) return fallback;
    try { return JSON.parse(mirrored); } catch (e) { return fallback; }
  }
  // Synchronous counterpart for hot paths — per-exercise render loops, the
  // rest timer, session-pace math — that would otherwise pay an `await` per
  // call for a value that is already sitting in the cache. Same cache as
  // getSetting(), just without its needless-once-loaded Promise wrapper.
  function getSettingSync(key, fallback) {
    if (settingsCache.has(key)) return settingsCache.get(key);
    return fallback;
  }
  async function setSetting(key, value) {
    settingsCache.set(key, value);
    lsSetSetting(key, value);
    if (dbAvailable) return idbPut('settings', { key, value });
    memory.settings[key] = value;
  }
  async function clearSetting(key) {
    settingsCache.delete(key);
    lsRemoveSetting(key);
    delete memory.settings[key];
    if (dbAvailable) return idbDelete('settings', key);
  }

  // exercisePrefs is keyed by exerciseId (not autoIncrement), so it needs its
  // own get/set rather than the generic addRecord/putRecord above.
  async function getExercisePref(exerciseId) {
    if (dbAvailable) return idbGet('exercisePrefs', exerciseId);
    return memory.exercisePrefs.find(p => p.exerciseId === exerciseId);
  }
  async function setExercisePref(exerciseId, updates) {
    const existing = (await getExercisePref(exerciseId)) || { exerciseId, pinned: false, liked: false, disliked: false };
    const updated = { ...existing, ...updates };
    if (dbAvailable) return idbPut('exercisePrefs', updated);
    const idx = memory.exercisePrefs.findIndex(p => p.exerciseId === exerciseId);
    if (idx >= 0) memory.exercisePrefs[idx] = updated; else memory.exercisePrefs.push(updated);
  }

  // =========================================================================
  // Workout log — one record per calendar day, built up as sets are logged
  // via either the Log tab or the Plan tab's inline quick-log.
  // =========================================================================
  // Single-record lookup by date. The `workouts` store already declares a
  // `date` index — it was created and then never used, so every call here was
  // reading and deserialising the entire store to find one record. That cost
  // grows with training history forever, and this is the most-called read in
  // the app.
  //
  // Feature-detected rather than assumed: the index is created in the branch
  // that BUILDS the workouts store, so a database upgraded from v3/v4 (where
  // the store already existed) never got one. Calling .index('date') there
  // throws NotFoundError, so those fall back to the scan.
  function getWorkoutForDate(date) {
    if (!dbAvailable) return Promise.resolve(memory.workouts.find(w => w.date === date) || null);
    return new Promise((resolve, reject) => {
      let store;
      try {
        store = db.transaction('workouts', 'readonly').objectStore('workouts');
      } catch (e) { reject(e); return; }
      if (!store.indexNames.contains('date')) {
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result || []).find(w => w.date === date) || null);
        req.onerror = (ev) => reject(ev.target.error);
        return;
      }
      const req = store.index('date').get(date);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (ev) => reject(ev.target.error);
    });
  }

  // SERIALISED WRITES.
  //
  // Every mutator below is read -> mutate -> write with an `await` in the
  // middle, and they all contend for the same single record: today's workout.
  // Two overlapping calls — a double-tapped Log button, or a tap landing while
  // a refresh is still in flight — both read the pre-write state and the
  // second write wins, silently dropping a set.
  //
  // When no record exists yet it is worse than a lost set. BOTH calls take the
  // `if (!workout)` branch and BOTH create a record, and because putRecord()
  // on a keyPath/autoIncrement store assigns a fresh id to an object with no
  // id, the day ends up with two workout records. The `date` index is not
  // unique, so getWorkoutForDate() only ever finds the first: the second
  // record's sets vanish from the Log tab and from today's volume while still
  // showing up as a duplicate "Today" row in History.
  //
  // IndexedDB transactions can't fix this — the read and the write are
  // separate transactions with application logic between them. So the writers
  // are serialised here instead: each one queues behind the last, and reads
  // are left alone.
  let workoutWriteChain = Promise.resolve();
  function withWorkoutLock(fn) {
    // Chained on both settle paths: a rejected predecessor must not deadlock
    // the queue behind it.
    const run = workoutWriteChain.then(fn, fn);
    workoutWriteChain = run.then(() => {}, () => {});
    return run;
  }

  // entries[].weight must already be in kg — callers convert from the
  // display unit before calling this (see toKg()).
  async function logSet(exerciseId, type, entries, planMeta, rir) {
    return withWorkoutLock(() => logSetLocked(exerciseId, type, entries, planMeta, rir));
  }
  async function logSetLocked(exerciseId, type, entries, planMeta, rir) {
    const date = todayStr();
    let workout = await getWorkoutForDate(date);
    if (!workout) workout = { date, ts: Date.now(), planId: null, dayIndex: null, dayName: null, exercises: [] };
    if (planMeta) {
      workout.planId = planMeta.planId;
      workout.dayIndex = planMeta.dayIndex;
      workout.dayName = planMeta.dayName;
    }
    let exEntry = workout.exercises.find(ex => ex.exerciseId === exerciseId);
    if (!exEntry) { exEntry = { exerciseId, sets: [] }; workout.exercises.push(exEntry); }

    // `ts` is forced to be STRICTLY GREATER than every other set logged today.
    //
    // Date.now() has millisecond resolution, and two taps — or one tap and the
    // async write behind it — land inside the same millisecond easily. Three
    // sets logged quickly all carried the identical timestamp, which quietly
    // undermined everything that treats ts as a set's identity or its order:
    // suggestForExercise() sorts a session's sets by ts, collectPaceSamples()
    // measures the gaps between them, and the RIR prompt uses it to find the
    // set it asked about after the list underneath has shifted. Ties made all
    // three depend on incidental array order.
    //
    // Scoped to the whole workout, not just this exercise, because the pace
    // sampler flattens every set in the day into one timeline.
    let ts = Date.now();
    const latest = workout.exercises.reduce(
      (m, ex) => ex.sets.reduce((n, s) => (typeof s.ts === 'number' && s.ts > n ? s.ts : n), m), 0);
    if (ts <= latest) ts = latest + 1;

    const set = { ts, type, entries };
    if (rir != null) set.rir = rir;
    exEntry.sets.push(set);
    // Auto-start the session on the first logged set, so a forgotten Start
    // button doesn't erase the day from the pace estimator entirely (see
    // sessionOverheadSamples/collectPaceSamples in 07-settings.js). Only
    // stamps a session that has no start yet — pressing Start later keeps
    // this earlier time (startWorkoutSessionLocked already guards on
    // `!workout.startedAt`).
    if (!workout.startedAt) {
      workout.startedAt = ts;
      workout.startedAuto = true;
    }
    await putRecord('workouts', workout);
    return workout;
  }

  // Returns the removed set (so a caller can offer an Undo), or `null` if
  // there was nothing to remove.
  async function deleteSet(workoutId, exerciseId, setIndex) {
    return withWorkoutLock(() => deleteSetLocked(workoutId, exerciseId, setIndex));
  }
  async function deleteSetLocked(workoutId, exerciseId, setIndex) {
    const workout = await getRecord('workouts', workoutId);
    if (!workout) return null;
    const exEntry = workout.exercises.find(ex => ex.exerciseId === exerciseId);
    if (!exEntry) return null;
    let [removed] = exEntry.sets.splice(setIndex, 1);
    if (exEntry.sets.length === 0) workout.exercises = workout.exercises.filter(ex => ex.exerciseId !== exerciseId);
    // Keep the record if a session was EXPLICITLY started (Start Warm-up), a
    // today-only set-count override is set, or a session-only exercise swap
    // is set, even with no sets left — deleting it would silently wipe those
    // out along with it. An auto-started session's startedAt IS the first
    // set's timestamp, so once that set (and everything else) is gone there
    // is nothing left worth keeping the record for.
    const hasOverrides = workout.targetOverrides && Object.keys(workout.targetOverrides).length > 0;
    const hasSwaps = workout.exerciseSwaps && Object.keys(workout.exerciseSwaps).length > 0;
    const keepForSession = workout.startedAt && !workout.startedAuto;
    if (workout.exercises.length === 0 && !keepForSession && !hasOverrides && !hasSwaps) {
      await deleteRecord('workouts', workout.id);
      // The whole `workouts` record is being torn down, and restoreSetLocked's
      // undo path can only ever be handed back what THIS function returns (see
      // the comment on restoreSet() below) — so if the record carried a
      // session-start stamp, it has to travel out on the returned set itself
      // or it's gone for good. Stashed under a double-underscore key so it
      // can't collide with a real set field (ts/type/entries/rir) and reads
      // as obviously-not-set-data to anything else that looks at `removed`;
      // restoreSetLocked strips it back off before the set is stored.
      if (removed && workout.startedAt != null) {
        removed = { ...removed, __deletedStartedAt: workout.startedAt, __deletedStartedAuto: !!workout.startedAuto };
      }
    } else {
      await putRecord('workouts', workout);
    }
    return removed || null;
  }

  // Undo for deleteSet(). Addressed by (date, exerciseId, ts) rather than
  // (workoutId, exerciseId, index), because neither survives the gap between
  // a delete and the Undo tap: deleting a day's LAST set can delete the whole
  // `workouts` record (see deleteSetLocked above), so the old workoutId may no
  // longer resolve to anything — restoring has to be able to recreate the
  // record, the same empty shape logSetLocked() uses. And even when the
  // record survives, `setIndex` is an index into `exEntry.sets` at the moment
  // of deletion; any set logged in the meantime shifts it. The set's own `ts`
  // and the day's `date` are the only two things about it that stay valid
  // regardless of what else happened to the record in between.
  //
  // When recreating the record, `set` may also carry a `__deletedStartedAt`/
  // `__deletedStartedAuto` pair stashed by deleteSetLocked — the session-start
  // stamp the deleted record was carrying, which would otherwise be lost the
  // same way the record itself was. See deleteSetLocked's comment.
  async function restoreSet(date, exerciseId, set) {
    return withWorkoutLock(() => restoreSetLocked(date, exerciseId, set));
  }
  async function restoreSetLocked(date, exerciseId, set) {
    if (!set) return null;
    // Pull the session-start stamp (if deleteSetLocked attached one — see
    // its comment) off the set BEFORE it's touched again, and strip it so it
    // never ends up stored as if it were part of the set itself.
    const { __deletedStartedAt: deletedStartedAt, __deletedStartedAuto: deletedStartedAuto, ...cleanSet } = set;
    let workout = await getWorkoutForDate(date);
    if (!workout) {
      // Recreating the record from scratch: restore the session-start fields
      // it carried when deleted, or logging/rendering code sees a day with a
      // set on it but a session that's "Not started". Only done here, on a
      // fresh record — an EXISTING record's own startedAt/startedAuto must
      // never be overwritten by an unrelated undo.
      workout = { date, ts: Date.now(), planId: null, dayIndex: null, dayName: null, exercises: [] };
      if (deletedStartedAt != null) {
        workout.startedAt = deletedStartedAt;
        if (deletedStartedAuto) workout.startedAuto = true;
      }
    }
    let exEntry = workout.exercises.find(ex => ex.exerciseId === exerciseId);
    if (!exEntry) { exEntry = { exerciseId, sets: [] }; workout.exercises.push(exEntry); }
    // Double-undo guard: a set with this exact ts is already there (the Undo
    // toast's action was clicked twice, or fired after the toast should have
    // been dismissed) — do nothing rather than duplicate it.
    if (exEntry.sets.some(s => s.ts === cleanSet.ts)) return workout;
    exEntry.sets.push(cleanSet);
    exEntry.sets.sort((a, b) => a.ts - b.ts);
    await putRecord('workouts', workout);
    return workout;
  }

  // Only for type:'standard' sets (single weight/reps pair) — inline editing
  // of drop/myo sets (multiple entries) isn't supported, stays delete-and-re-add.
  // weightKg must already be in kg — callers convert from the display unit.
  // Written after the fact, from the prompt that appears once the set is
  // logged. Guarded the same way as updateStandardSet: the set can be deleted
  // between logging it and answering.
  async function setSetRir(workoutId, exerciseId, setIndex, rir, expectTs) {
    return withWorkoutLock(() => setSetRirLocked(workoutId, exerciseId, setIndex, rir, expectTs));
  }
  // `expectTs` identifies the set by its own timestamp rather than trusting
  // the index, because the prompt outlives the list it was opened against.
  //
  // The prompt appears after a set is logged and sits there until answered or
  // dismissed. Deleting any EARLIER set in the meantime shifts every later
  // index down by one, so the stored index either pointed past the end (the
  // answer vanished with no explanation) or, once another set was logged, at a
  // different set entirely. A timestamp is stable under both.
  async function setSetRirLocked(workoutId, exerciseId, setIndex, rir, expectTs) {
    const workout = await getRecord('workouts', workoutId);
    if (!workout) return;
    const exEntry = workout.exercises.find(ex => ex.exerciseId === exerciseId);
    if (!exEntry) return;
    let idx = setIndex;
    if (expectTs != null) {
      idx = exEntry.sets.findIndex(s => s.ts === expectTs);
      if (idx === -1) return;   // that set has been deleted — drop the answer
    }
    if (!exEntry.sets[idx]) return;
    exEntry.sets[idx].rir = rir;
    await putRecord('workouts', workout);
  }

  async function updateStandardSet(workoutId, exerciseId, setIndex, weightKg, reps) {
    return withWorkoutLock(() => updateStandardSetLocked(workoutId, exerciseId, setIndex, weightKg, reps));
  }
  async function updateStandardSetLocked(workoutId, exerciseId, setIndex, weightKg, reps) {
    const workout = await getRecord('workouts', workoutId);
    if (!workout) return;
    const exEntry = workout.exercises.find(ex => ex.exerciseId === exerciseId);
    if (!exEntry || !exEntry.sets[setIndex]) return;
    const set = exEntry.sets[setIndex];
    if (set.type !== 'standard') return;
    set.entries = [{ weight: weightKg, reps }];
    await putRecord('workouts', workout);
  }

  // Start/complete are independent of set-logging (which always persists
  // immediately) — they just stamp when today's session began/ended so a
  // duration can be recorded. Pressing Start again after Complete resumes
  // the same startedAt (doesn't reset the clock) and just clears
  // endedAt/durationMs, so an accidental early Complete doesn't lose the
  // original start time.
  async function startWorkoutSession() {
    return withWorkoutLock(() => startWorkoutSessionLocked());
  }
  async function startWorkoutSessionLocked() {
    const date = todayStr();
    let workout = await getWorkoutForDate(date);
    if (!workout) workout = { date, ts: Date.now(), planId: null, dayIndex: null, dayName: null, exercises: [] };
    if (!workout.startedAt) workout.startedAt = Date.now();
    workout.endedAt = null;
    workout.durationMs = null;
    await putRecord('workouts', workout);
    return workout;
  }

  async function completeWorkoutSession() {
    return withWorkoutLock(() => completeWorkoutSessionLocked());
  }
  async function completeWorkoutSessionLocked() {
    const date = todayStr();
    const workout = await getWorkoutForDate(date);
    if (!workout || !workout.startedAt) return null;
    workout.endedAt = Date.now();
    workout.durationMs = workout.endedAt - workout.startedAt;
    await putRecord('workouts', workout);
    return workout;
  }

  // Today-only target-set overrides — "skip a set today" / "add one today"
  // without touching the plan's own targetSets. Scoped to today's workout
  // record, so it's inherently temporary: the next time this plan day comes
  // around it's a different date/workout record with no override, and the
  // exercise is back to the plan's original prescribed set count — no
  // explicit expiry logic needed, it just falls out of where this lives.
  async function adjustTodayTargetSets(exerciseId, planTargetSets, delta) {
    return withWorkoutLock(() => adjustTodayTargetSetsLocked(exerciseId, planTargetSets, delta));
  }
  async function adjustTodayTargetSetsLocked(exerciseId, planTargetSets, delta) {
    const date = todayStr();
    let workout = await getWorkoutForDate(date);
    if (!workout) workout = { date, ts: Date.now(), planId: null, dayIndex: null, dayName: null, exercises: [] };
    if (!workout.targetOverrides) workout.targetOverrides = {};
    const exEntry = workout.exercises.find(ex => ex.exerciseId === exerciseId);
    const doneCount = exEntry ? exEntry.sets.length : 0;
    const current = workout.targetOverrides[exerciseId] ?? planTargetSets;
    const next = Math.max(doneCount, current + delta);
    if (next === planTargetSets) delete workout.targetOverrides[exerciseId];
    else workout.targetOverrides[exerciseId] = next;
    await putRecord('workouts', workout);
    return workout;
  }

  // Session-only exercise swap — "do X instead of Y today" from the Log
  // tab's active-workout view. Unlike the Plan tab's Swap (which rewrites
  // the plan record permanently), this only affects today's workout record:
  // keyed by the plan's original exerciseId so the slot identity is
  // preserved, valued by whichever exercise is actually being logged today.
  async function setSessionSwap(originalExerciseId, newExerciseId) {
    return withWorkoutLock(() => setSessionSwapLocked(originalExerciseId, newExerciseId));
  }
  async function setSessionSwapLocked(originalExerciseId, newExerciseId) {
    const date = todayStr();
    let workout = await getWorkoutForDate(date);
    if (!workout) workout = { date, ts: Date.now(), planId: null, dayIndex: null, dayName: null, exercises: [] };
    if (!workout.exerciseSwaps) workout.exerciseSwaps = {};
    if (newExerciseId === originalExerciseId) delete workout.exerciseSwaps[originalExerciseId];
    else workout.exerciseSwaps[originalExerciseId] = newExerciseId;
    await putRecord('workouts', workout);
    return workout;
  }

  // =========================================================================
  // Persistent storage
  //
  // Every IndexedDB origin starts "best-effort" — a browser under storage
  // pressure (Safari especially, but not only Safari) can evict the whole
  // database with no warning, no event, nothing to catch. That's exactly the
  // risk "Backup & restore" (06-catalog-import-backup.js) exists to insure
  // against, but insurance is not the same as not getting robbed: asking for
  // the persistent bucket is the one call that actually reduces how often
  // eviction happens at all.
  //
  // Checks persisted() before ever calling persist() — once granted, it stays
  // granted (the user would have to revoke it via browser site settings), so
  // re-asking on every single launch would just be noise, and on browsers
  // that show a permission prompt it would be noise the user has to dismiss.
  //
  // Feature-detected and wrapped end to end: a browser with no Storage API
  // (or one that denies the request outright) must load exactly as it did
  // before this existed. This is a nice-to-have layered on top of a working
  // app, never a startup dependency — see the `dbAvailable` fallback above
  // for the same philosophy applied to IndexedDB itself.
  async function requestPersistentStorage() {
    try {
      if (!(navigator.storage && navigator.storage.persist)) return { supported: false, persisted: false };
      const already = await navigator.storage.persisted();
      const persisted = already || await navigator.storage.persist();
      return { supported: true, persisted: !!persisted };
    } catch (e) {
      return { supported: false, persisted: false };
    }
  }

  // Usage/quota for the Settings status line. Independent of persist()
  // above — a browser can support one without the other — so feature-detected
  // and try/caught on its own rather than folded into requestPersistentStorage().
  async function getStorageEstimate() {
    try {
      if (!(navigator.storage && navigator.storage.estimate)) return null;
      const { usage, quota } = await navigator.storage.estimate();
      if (!Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return null;
      return { usage, quota };
    } catch (e) {
      return null;
    }
  }
