  // 04-timer.js — Rest timer, audio, bottom sheet, RIR prompt, workout session card
  // =========================================================================
  // Rest timer
  // =========================================================================
  let timerInterval = null;
  let autoHideId = null;
  let timerRemaining = 90;
  // What the current countdown started from, so the progress bar has a
  // denominator. Tracked separately from restDefault because +15s/-15s
  // change the length of the run in progress.
  let timerTotal = 90;

  function formatTime(sec) {
    const s = Math.max(0, sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function updateTimerDisplay() {
    const display = document.getElementById('timer-display');
    display.textContent = formatTime(timerRemaining);
    display.classList.toggle('done', timerRemaining <= 0);
    const pct = timerTotal > 0 ? Math.max(0, Math.min(1, timerRemaining / timerTotal)) * 100 : 0;
    document.getElementById('timer-fill').style.width = `${pct}%`;
  }
  // ONE AudioContext for the life of the page, created lazily.
  //
  // This used to construct a fresh one per beep and never close it, so every
  // rest leaked a context. Browsers cap how many a single document may hold
  // (Chrome at six), and past the cap the constructor throws — straight into
  // the catch below, which is silent by design — so the rest timer simply
  // went mute partway through a session and stayed mute until reload.
  //
  // Lazy because a context constructed before any user gesture starts life
  // 'suspended' on mobile; resume() on each use covers the case where it was
  // suspended later by the OS backgrounding the tab.
  let audioCtx = null;
  // iOS only unlocks Web Audio when the context is created (or resumed)
  // synchronously inside a user-gesture handler; building it lazily on the
  // first beep — which fires from a setInterval tick, not a gesture — is
  // silently ignored there. startRestTimer() always runs inside a Log tap,
  // so it calls this to create/resume the context while still inside that
  // gesture; beep() then just reuses whatever context this left behind.
  function unlockAudio() {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      if (!audioCtx) audioCtx = new Ctor();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* audio not available — non-fatal */ }
  }
  function beep() {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      if (!audioCtx) audioCtx = new Ctor();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
    } catch (e) { /* audio not available — non-fatal */ }
  }

  // COUNTDOWN FROM A DEADLINE, not by decrementing once per tick.
  //
  // setInterval is throttled to about once a minute in a backgrounded tab and
  // suspended outright when an iOS screen locks — which is precisely what a
  // phone does during a rest period. A tick-counting timer therefore came back
  // reading whatever number it happened to have reached before the OS stopped
  // calling it: a 90-second rest could still be showing 1:12 four minutes
  // later. Storing the end time makes the display correct the instant it is
  // looked at again, however long the gap was.
  let timerDeadline = null;

  function timerTick() {
    const previous = timerRemaining;
    timerRemaining = timerDeadline == null ? 0 : Math.ceil((timerDeadline - Date.now()) / 1000);
    updateTimerDisplay();
    if (timerRemaining > 0 || previous <= 0) return;
    clearInterval(timerInterval);
    timerInterval = null;
    // A rest that elapsed while the phone was in a pocket has already been
    // taken. Alerting about it on the way back is noise, not information, so
    // the beep is only for an expiry we are actually present for — the 0:00
    // display happens either way.
    if (Date.now() - timerDeadline < 3000) {
      beep();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
    // Linger briefly so the 0:00 and the beep are connected, then get out
    // of the way on its own. Cancelled if another rest starts in the
    // meantime, which would otherwise hide a freshly started timer.
    clearTimeout(autoHideId);
    autoHideId = setTimeout(hideTimerSheet, 4000);
  }

  async function startTimer(seconds) {
    clearTimeout(autoHideId);
    clearInterval(timerInterval);
    timerRemaining = seconds ?? (timerRemaining > 0 ? timerRemaining : await getSetting('restDefault', 90));
    if (timerRemaining > timerTotal) timerTotal = timerRemaining;
    timerDeadline = Date.now() + timerRemaining * 1000;
    updateTimerDisplay();
    timerInterval = setInterval(timerTick, 1000);
  }

  // +15 / -15 move the deadline, not just the displayed number, or the next
  // tick would recompute from the old end time and undo the adjustment. Also
  // restarts a countdown that had already run out, so +15 after the beep is a
  // way to take a little longer rather than a no-op that edits a dead number.
  function adjustTimer(deltaSeconds) {
    timerRemaining = Math.max(0, timerRemaining + deltaSeconds);
    if (timerRemaining > timerTotal) timerTotal = timerRemaining;
    timerDeadline = Date.now() + timerRemaining * 1000;
    if (timerRemaining > 0 && !timerInterval) timerInterval = setInterval(timerTick, 1000);
    if (timerRemaining <= 0 && timerInterval) {
      // -15 can carry a running timer straight to 0 right here, before
      // timerTick ever sees it change — so its own "previous <= 0" guard
      // never fires and the interval would otherwise keep running forever.
      // Stop it directly; no beep, since the user did this deliberately.
      clearInterval(timerInterval);
      timerInterval = null;
      updateTimerDisplay();
      clearTimeout(autoHideId);
      autoHideId = setTimeout(hideTimerSheet, 4000);
    }
    updateTimerDisplay();
  }

  function pauseTimer() { clearInterval(timerInterval); timerInterval = null; timerDeadline = null; }

  // Coming back to the app is the moment the number matters most, and it is
  // exactly when the throttled interval is furthest behind. Resync on sight
  // rather than waiting up to a second for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && timerInterval) timerTick();
  });

  // The sheet is the timer's only presence now. It is shown when a rest
  // starts and hidden when the rest is finished with — the timer state itself
  // is unchanged either way, so hiding is purely visual and a hidden timer
  // that is still running keeps running.
  // The sheet holds two independent rows. Neither knows about the other; the
  // container is shown while either wants to be, so closing one never has to
  // reason about the state of the other.
  function syncSheet() {
    const sheet = document.getElementById('bottom-sheet');
    const rir = document.getElementById('rir-prompt');
    const timer = document.getElementById('timer-row');
    if (!sheet) return;
    sheet.hidden = (!rir || rir.hidden) && (!timer || timer.hidden);
    // Keep the page's bottom padding in step, so the sheet never sits on top
    // of the rows it is reporting about — see body.sheet-up.
    if (document.body && document.body.classList) document.body.classList.toggle('sheet-up', !sheet.hidden);
  }
  function showTimerSheet() {
    const row = document.getElementById('timer-row');
    if (row) row.hidden = false;
    syncSheet();
  }
  function hideTimerSheet() {
    const row = document.getElementById('timer-row');
    if (row) row.hidden = true;
    syncSheet();
  }

  // Which set the RIR prompt is currently asking about. Cleared on answer or
  // dismiss so a stale reference can never write onto the wrong set.
  let pendingRir = null;

  function showRirPrompt(target) {
    pendingRir = target;
    const el = document.getElementById('rir-prompt');
    if (el) el.hidden = false;
    syncSheet();
  }
  function hideRirPrompt() {
    pendingRir = null;
    const el = document.getElementById('rir-prompt');
    if (el) el.hidden = true;
    syncSheet();
  }

  // Whether a rest is worth timing after this set.
  //
  // Not after the set that COMPLETES an exercise: the walk to the next
  // machine is the rest, and it is self-paced. Timing it produces a countdown
  // nobody is waiting on and a beep that lands mid-way through the next
  // warm-up.
  //
  // Exactly-equal rather than >=, so bonus sets past the prescription still
  // get one. Once you are off-script the app cannot know which set is your
  // last, and offering a rest you can dismiss beats withholding one you
  // wanted — there is no manual start any more.
  //
  // A prescription of 0 (off-plan or manual logging) always rests: there is
  // no "last set" to be after.
  function shouldRestAfter(setsDone, prescribed) {
    if (!prescribed) return true;
    return setsDone !== prescribed;
  }

  // Logging a set always earns a FULL rest period. Previously this called
  // startTimer() with no args, which resumed whatever was left on the clock —
  // so logging mid-countdown gave you a short, arbitrary rest.
  //
  // Opt-out lives here rather than at each call site: two log paths call this
  // and a third could be added, and a rest timer that silently doesn't run is
  // better expressed once than remembered three times.
  async function startRestTimer() {
    unlockAudio(); // still inside the Log tap's gesture — see unlockAudio() above
    if (!getSettingSync('restTimerEnabled', true)) { hideTimerSheet(); return; }
    timerTotal = getSettingSync('restDefault', 90);
    showTimerSheet();
    return startTimer(timerTotal);
  }

  document.querySelectorAll('.rir-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!pendingRir) return;
      const { workoutId, exerciseId, setIndex, setTs } = pendingRir;
      hideRirPrompt();
      await setSetRir(workoutId, exerciseId, setIndex, Number(btn.dataset.rir), setTs);
      await refreshLogAndHistory();
    });
  });
  document.getElementById('rir-skip').addEventListener('click', hideRirPrompt);

  document.getElementById('timer-dismiss').addEventListener('click', () => {
    clearTimeout(autoHideId);
    pauseTimer();
    hideTimerSheet();
  });
  document.getElementById('timer-minus').addEventListener('click', () => adjustTimer(-15));
  document.getElementById('timer-plus').addEventListener('click', () => adjustTimer(15));

  // =========================================================================
  // Workout session (Start/Complete Workout — tracks duration only; sets
  // still save immediately on Log, independent of session state)
  // =========================================================================
  let sessionTickInterval = null;

  async function refreshSessionCard() {
    clearInterval(sessionTickInterval);
    const workout = await getWorkoutForDate(todayStr());
    const display = document.getElementById('session-display');
    const startBtn = document.getElementById('session-start-btn');
    const startHint = document.getElementById('session-start-hint');
    const completeBtn = document.getElementById('session-complete-btn');

    display.classList.remove('idle', 'running');
    if (!workout || !workout.startedAt) {
      display.textContent = 'Not started';
      display.classList.add('idle');
      startBtn.textContent = 'Start Warm-up';
      startBtn.style.display = 'block';
      startHint.style.display = 'block';
      completeBtn.style.display = 'none';
    } else if (!workout.endedAt) {
      display.classList.add('running');
      startBtn.style.display = 'none';
      startHint.style.display = 'none';
      completeBtn.style.display = 'block';
      const tick = () => { display.textContent = formatDuration(Date.now() - workout.startedAt); };
      tick();
      sessionTickInterval = setInterval(tick, 1000);
    } else {
      display.textContent = formatDuration(workout.durationMs);
      display.title = 'Completed';
      startBtn.textContent = 'Start New Session';
      startBtn.style.display = 'block';
      startHint.style.display = 'none';
      completeBtn.style.display = 'none';
    }
  }

  document.getElementById('session-start-btn').addEventListener('click', async () => {
    await startWorkoutSession();
    await refreshSessionCard();
  });
  document.getElementById('session-complete-btn').addEventListener('click', async () => {
    await completeWorkoutSession();
    await refreshLogAndHistory();
  });
