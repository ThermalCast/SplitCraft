  // 12-init.js — syncDefaultExercises, init(), openDB().then(...), service worker registration
  // =========================================================================
  // Init
  // =========================================================================
  // Runs on every load, not just once — DEFAULT_EXERCISES is the "central
  // source" for the built-in catalog (bundled in this file; shipping a new
  // version of the file with more/updated defaults is how it gets updated).
  // Matches by name: anything missing locally gets added, and any existing
  // custom:false row gets its muscle tags refreshed to match. custom:true
  // rows (user-added) are never touched — they're not in DEFAULT_EXERCISES
  // to begin with, so name-matching naturally leaves them alone.
  // Names are matched on nameKey() (defined up in Helpers, and shared with the
  // Fitbod importer and the AI plan matcher), so "Assisted Pull Up" from an
  // export and "Assisted Pull-Up" from the catalog resolve to one exercise
  // instead of two near-identical rows. Only affects whether a default gets
  // ADDED; a matched custom row is still never modified.
  async function syncDefaultExercises() {
    const existing = await getAllRecords('exercises');
    const existingByName = new Map(existing.map(e => [nameKey(e.name), e]));
    for (const def of DEFAULT_EXERCISES) {
      const key = nameKey(def.name);
      const current = existingByName.get(key);
      // Equipment is derived from the name rather than written into all 92
      // catalog entries: the classifier is verified against exactly that list,
      // and hand-copying it would add 92 places for the two to drift apart.
      const equipment = classifyEquipmentFromName(def.name);
      if (!current) {
        await addRecord('exercises', { ...def, equipment, custom: false });
        continue;
      }
      // `custom` rows were never ours to manage. `userEdited` rows were, until
      // the user corrected them by hand on the Exercises tab.
      //
      // Without that second test this sync was actively destructive: the
      // Exercises tab offers a muscle and an equipment dropdown for
      // EVERY row, built-ins included, and for the ~92 built-ins the change
      // held for the session and was quietly undone on the next load. A
      // control that reports success and then reverts is worse than one that
      // isn't offered, because the user has no reason to check.
      if (current.custom || current.userEdited) continue;
      const outOfDate = current.primaryMuscle !== def.primaryMuscle
        || current.equipment !== equipment
        || JSON.stringify(current.secondaryMuscles) !== JSON.stringify(def.secondaryMuscles);
      if (outOfDate) {
        await putRecord('exercises', { ...current, primaryMuscle: def.primaryMuscle, secondaryMuscles: def.secondaryMuscles, equipment, custom: false });
      }
    }
  }

  // Exposes every delegated-action registry (see delegate() in
  // 03-helpers.js) for tests/ui.mjs. Only top-level `function` declarations
  // attach to the vm sandbox context the test harness runs against (see
  // tests/harness.mjs); the registries themselves are `const` objects, so a
  // test has no way to reach them without an accessor like this one. Named
  // per render function so a test can call each handler directly with a
  // stub element, the replacement for hunting `.onclick` properties that no
  // longer exist now that wiring is delegated.
  function actionRegistries() {
    return {
      ENTRY_ROW_ACTIONS, ENTRY_ROW_INPUT_ACTIONS,
      HISTORY_CLICK_ACTIONS, HISTORY_CHANGE_ACTIONS, HISTORY_INPUT_ACTIONS,
      EXERCISE_MANAGER_CLICK_ACTIONS, EXERCISE_MANAGER_CHANGE_ACTIONS,
      WORKOUT_CLICK_ACTIONS, WORKOUT_CHANGE_ACTIONS, WORKOUT_INPUT_ACTIONS,
      PLAN_DAY_CLICK_ACTIONS, PLAN_DAY_CHANGE_ACTIONS,
    };
  }

  async function init() {
    populateMuscleSelect(document.getElementById('quick-ex-muscle'));
    populateMuscleSelect(document.getElementById('new-ex-muscle'));
    // Settings load FIRST, before the exercise-catalog sync. That sync now
    // performs up to 92 record writes; if any one of them throws, init()
    // unwinds and everything after it never runs. With the old ordering that
    // included loadSettingsIntoForm(), so a stored API key would render as an
    // empty field — indistinguishable from not having been saved, and the
    // obvious response is to retype it. Settings are two reads with no
    // dependency on the catalog, so there is no reason for them to be
    // downstream of it.
    // Populates the settings cache from storage — a single read, done once,
    // that every getSetting()/getSettingSync() call for the rest of this
    // session reads back out of memory. Must run before anything below that
    // reads a setting (loadSettingsIntoForm() included).
    await loadSettings();
    await loadSettingsIntoForm();
    await loadPlanFormFromSettings();
    // Textareas are sized on `input`, which programmatic value-setting above
    // never fires — so a loaded note that's already several lines long would
    // otherwise stay clipped to the CSS default height until the next
    // keystroke. Resize every one now that its real value is in place.
    document.querySelectorAll('textarea').forEach(autoGrowTextarea);
    await syncDefaultExercises();
    await populateExerciseSelect();
    timerRemaining = await getSetting('restDefault', 90);
    timerTotal = timerRemaining;
    updateTimerDisplay();
    renderEntryRows();
    await refreshLogAndHistory();
    selectedLogDayIdx = null; // fresh load — reset the Log tab's day pick
    await refreshPlanTab();
    await renderExerciseManager();

    // Not awaited: requesting persistent storage (and painting the result in
    // Settings) is a nice-to-have, not something the rest of startup should
    // ever wait on. requestPersistentStorage() (02-storage.js) never throws —
    // this is still wrapped, because renderStorageStatus() touches the DOM
    // and a startup regression there must not turn into an unhandled
    // rejection on every load.
    requestPersistentStorage().then(renderStorageStatus).catch(() => {});
    // Same non-blocking treatment, and deliberately NOT chained onto the
    // persistent-storage promise above: the "Last backup" line has nothing
    // to do with storage mode, and there's no reason a slow persist() prompt
    // should delay it.
    renderBackupFreshness().catch(() => {});
    // A returning Dropbox OAuth redirect is also a load-time event this page
    // has to notice on its own — chained (not parallel) with renderDropboxStatus()
    // so a fresh connection's token is already stored before the button's
    // label is painted, and neither one blocks the rest of startup.
    handleDropboxRedirect().then(renderDropboxStatus).catch(() => {});
  }

  document.getElementById('today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  // The storage fallback is attached to openDB() ONLY.
  //
  // This used to be `.then(db => { ...; return init(); }).catch(...)`, which
  // put init() upstream of the storage handler: ANY render fault during
  // startup — a bad reference in a chart, a malformed record — was caught as
  // though IndexedDB had failed. The app then set dbAvailable = false, showed
  // the "storage unavailable" banner, and re-ran init() against the in-memory
  // arrays while a perfectly good database sat untouched. Everything logged in
  // that session was then discarded on reload, and the banner blamed the
  // browser for it.
  //
  // Two handlers, two jobs: the rejection handler decides where data lives,
  // and init() runs afterwards either way.
  openDB().then(
    (database) => { db = database; },
    () => {
      dbAvailable = false;
      document.getElementById('storage-warning').style.display = 'block';
    }
  ).then(init).catch(err => reportUnexpected('Startup failed', err));

  // =========================================================================
  // Service worker registration — offline support for the installed app.
  //
  // Entirely optional and entirely non-blocking. Service workers only exist
  // over https:// (or localhost), so opening this HTML straight off the
  // filesystem registers nothing and the app behaves exactly as it did before
  // any of this existed. That is deliberate: the single-file property is worth
  // keeping, and sw.js is an enhancement layered on top of it, never a
  // dependency of it.
  //
  // Registered AFTER load so it never competes with first paint for bandwidth
  // on a phone.
  // =========================================================================
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then(reg => {
        // A new version is only ever offered, never forced. Swapping the app
        // out from under someone mid-set would lose whatever is typed into the
        // weight and reps fields.
        reg.addEventListener('updatefound', () => {
          const incoming = reg.installing;
          if (!incoming) return;
          incoming.addEventListener('statechange', () => {
            // 'installed' with an existing controller means an UPDATE is
            // waiting; without one it is simply the first install, which needs
            // no announcement.
            if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Update ready — reopen the app to apply it');
            }
          });
        });
      }).catch(() => { /* offline support unavailable — the app is unaffected */ });
    });
  }