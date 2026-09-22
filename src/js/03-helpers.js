  // 03-helpers.js — Helpers, tabs, toast/error reporting, exercise select + quick-add, set entry rows
  // =========================================================================
  // Helpers
  // =========================================================================
  function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // THE canonical key for matching an exercise by name — lowercased,
  // apostrophes dropped, hyphens/underscores folded to spaces, runs of
  // whitespace collapsed. "Assisted Pull Up", "Assisted Pull-Up" and
  // "assisted pull up" all resolve to one exercise instead of three
  // near-identical rows.
  //
  // Lives here, next to esc(), because all three places that resolve a name to
  // a record must use the SAME key. It previously sat next to
  // syncDefaultExercises() and was used only there — while the two paths that
  // actually produce near-miss names, the Fitbod importer and the AI plan
  // matcher, both compared on a bare toLowerCase().trim(). A model answering
  // "Pull Up" against a catalogued "Pull-Up" therefore forked a duplicate
  // custom exercise with primaryMuscle 'unclassified', which splits that
  // lift's history in two (breaking its progression suggestion) and adds a
  // phantom Unclassified bar to the weekly-sets chart.
  const nameKey = (s) => String(s ?? '').toLowerCase().replace(/['’`]/g, '').replace(/[-_\s]+/g, ' ').trim();
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Weight unit is a single global display preference (Settings), cached
  // here and refreshed on load/save \u2014 every stored weight is kilograms,
  // always (see Storage layer comment above); this is the only place the
  // conversion happens, at the UI boundary. Weight input fields therefore
  // always expect/show values in this unit, converting to/from kg only when
  // reading from or writing to storage.
  let weightUnit = 'lb';
  function toKg(displayWeight) { return weightUnit === 'lb' ? displayWeight * KG_PER_LB : displayWeight; }
  function fromKg(weightKg) { return weightUnit === 'lb' ? weightKg / KG_PER_LB : weightKg; }
  function displayWeight(weightKg) { return Math.round(fromKg(weightKg) * 10) / 10; }

  // A small reminder next to every weight input for a `perSide` exercise
  // (see effectiveLoadKg(), 08-progression.js) — the number in the box is
  // still just what's on ONE dumbbell, same as it's always been; this only
  // exists so it's never ambiguous WHY the app's progression math is
  // treating it as double. Shared by every render site with a weight input
  // (09-workout.js, 05-history.js) so the wording and markup can't drift
  // between them. Returns '' for a falsy/missing exercise or one without
  // the flag, so every call site can splice it in unconditionally.
  function perSideNoteHtml(exercise) {
    return exercise && exercise.perSide ? '<span class="per-side-note">per side</span>' : '';
  }

  function formatSetLine(s) {
    const u = weightUnit;
    // RIR is recorded on the set regardless of type, so it renders for all of
    // them. It used to be appended only on the standard branch, which meant a
    // value logged against a drop set was stored and then never shown again.
    const rirTag = typeof s.rir === 'number' ? ` \u00b7 ${s.rir === 4 ? '4+' : s.rir} RIR` : '';
    if (s.type === 'drop') {
      return s.entries.map(e => `${displayWeight(e.weight)}${u}\u00d7${e.reps}`).join(' \u2192 ') + rirTag;
    }
    if (s.type === 'myo') {
      const [first, ...rest] = s.entries;
      const restStr = rest.map(e => e.reps).join('+');
      return `${displayWeight(first.weight)}${u}\u00d7${first.reps}${rest.length ? ' + myo ' + restStr : ''}${rirTag}`;
    }
    return `${displayWeight(s.entries[0].weight)}${u} \u00d7 ${s.entries[0].reps}${rirTag}`;
  }
  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  // =========================================================================
  // Delegated event wiring.
  //
  // Every render function used to rebuild an HTML string and then run a
  // `querySelectorAll(...).forEach(el => { el.onclick = ... })` loop on every
  // repaint — cheap to write, but it re-walks and re-closures the whole
  // subtree on every single logged set, and it is exactly the shape that
  // produced the "wired-but-unreachable class" bug in Part 2 (a selector
  // wired in one function but rendered by another, silently inert because
  // the wiring forEach just ran zero times).
  //
  // Markup instead carries `data-action="name"` (plus whatever data-* the
  // handler needs), and each container gets exactly ONE listener per event
  // type, attached once, that looks the action up in a registry of NAMED
  // functions. Named — not anonymous closures — so a test can call each
  // handler directly with a stub element (see tests/ui.mjs and
  // tests/README.md): a single anonymous `e => e.target.closest(...)`
  // listener would give a test nothing to invoke and no way to exercise the
  // interesting half of each handler.
  //
  // Guarded by a flag on the container's own dataset, keyed to the event
  // type, so re-rendering a container via `.innerHTML =` — which replaces
  // the children but leaves the container NODE itself, and its listeners,
  // in place — wires the listener exactly once rather than stacking a new
  // one on every repaint.
  function delegate(container, eventType, actions) {
    if (!container) return;
    const flag = 'delegated_' + eventType;
    if (container.dataset[flag] === 'yes') return;
    container.dataset[flag] = 'yes';
    container.addEventListener(eventType, (e) => {
      const el = e.target && e.target.closest && e.target.closest('[data-action]');
      if (!el) return;
      // Real DOM always has `.contains`; the test harness's stub elements
      // don't track parent/child links at all, so this check is skipped
      // there rather than made to fail on every call.
      if (typeof container.contains === 'function' && !container.contains(el)) return;
      const action = actions[el.dataset.action];
      if (!action) return;
      Promise.resolve(action(el, e)).catch(err => reportUnexpected(`action ${el.dataset.action}`, err));
    });
  }

  // Assisted movements (assisted pull-up, assisted dip) are logged with a
  // NEGATIVE weight — the number is how much load is taken off you, so
  // progress means the value climbs toward zero. Phone numeric keypads
  // (inputmode="decimal") have no minus key at all, so sign gets its own
  // button rather than depending on the user typing "-". The button precedes
  // its weight input.
  //
  // Cosmetic-only: keeps a sign-btn's `.negative` class in sync with its
  // weight input. Shared by every place a `.sign-btn` precedes a weight
  // input — the initial state is baked into the button's class string at
  // render time (every render already knows the starting value's sign), so
  // this is only needed for the click-to-negate and type-to-negate cases.
  function syncSignClass(weightInput) {
    const btn = weightInput.previousElementSibling;
    if (!btn || !btn.classList || !btn.classList.contains('sign-btn')) return;
    btn.classList.toggle('negative', parseFloat(weightInput.value) < 0);
  }
  // The click handler for every `.sign-btn` in the app (entry rows, History,
  // the active workout) — one shared action rather than a separate
  // per-container sign-button wiring pass. `el` is the button; the weight
  // input is its next sibling (the DOM contract every sign-btn markup keeps).
  const TOGGLE_SIGN_ACTIONS = {
    'toggle-sign': (el) => {
      const input = el.nextElementSibling;
      if (!input) return;
      const cur = parseFloat(input.value);
      if (isNaN(cur) || cur === 0) return; // nothing meaningful to negate yet
      input.value = -cur;
      syncSignClass(input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  // =========================================================================
  // Tabs
  // =========================================================================
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
      // Switching tabs from halfway down a long set list otherwise drops you
      // into the middle of the new panel.
      window.scrollTo(0, 0);
    });
  });

  // =========================================================================
  // Auto-growing textareas (Plan tab's Equipment/Notes, the custom-split
  // field in Settings) — height tracks content instead of scrolling a fixed
  // 62px box. `resize: none` only gets set once this actually runs, so a
  // browser where it fails for some reason (or the Node test harness, whose
  // stub elements have no real scrollHeight) is left with the CSS fallback:
  // the ordinary vertical drag-handle resize .field textarea already had.
  // =========================================================================
  function autoGrowTextarea(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }
  function wireAutoGrowTextareas() {
    document.querySelectorAll('textarea').forEach(el => {
      el.style.resize = 'none';
      el.addEventListener('input', () => autoGrowTextarea(el));
    });
  }
  wireAutoGrowTextareas();

  // =========================================================================
  // Toast — transient confirmation that doesn't shift layout the way the
  // inline .success-box divs do (those stay for messages worth re-reading,
  // like the import summary).
  // =========================================================================
  // Nothing in this app renders an exception. Most handlers end with a
  // fire-and-forget `refreshLogAndHistory()`, and every render path is a
  // forEach over freshly built DOM — so a single bad reference throws, the
  // rest of the loop never runs, and the UI just quietly does nothing. That
  // is precisely how a broken Log button read as "I can't log any sets" with
  // no error anywhere: the failure was real, visible in the console, and
  // invisible in the app.
  //
  // These two listeners are the cheapest possible fix. They don't recover
  // anything; they make failure *legible*, which is the part that was
  // missing. Deduplicated by message so a fault inside a render loop can't
  // fire fifty identical toasts.
  const seenErrors = new Set();
  function reportUnexpected(label, err) {
    const msg = (err && err.message) || String(err);
    const key = `${label}:${msg}`;
    if (seenErrors.has(key)) return;
    seenErrors.add(key);
    setTimeout(() => seenErrors.delete(key), 5000);
    console.error(label, err);
    // If toasting itself throws, that throw would be caught by this same
    // handler with a different message, sail past the dedupe, and recurse.
    // The console line above has already done the important part.
    try { toast(`Something went wrong: ${msg}`, 'err'); } catch (e) { /* nothing safe left to do */ }
  }
  window.addEventListener('error', (e) => reportUnexpected('Uncaught error', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportUnexpected('Unhandled rejection', e.reason));

  // `opts.action` = { label, onClick } adds a tappable button to the toast
  // (Undo, mainly). `#toast-host` is `pointer-events: none` so toasts don't
  // block taps on whatever is underneath them — a toast carrying an action
  // re-enables pointer events on ITSELF (`.toast.has-action`, in the CSS) so
  // the button is actually reachable. `opts.duration` overrides the default
  // dismiss time (ms) — an action needs longer than a passive confirmation to
  // be worth having.
  function toast(message, kind = 'ok', opts = {}) {
    const host = document.getElementById('toast-host');
    if (!host) return;
    const { action, duration = 1900 } = opts;
    const el = document.createElement('div');
    el.className = `toast ${kind}${action ? ' has-action' : ''}`;
    let timer;
    const dismiss = () => {
      clearTimeout(timer);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 220);
    };
    if (action) {
      const text = document.createElement('span');
      text.textContent = message;
      el.appendChild(text);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.onclick = async () => {
        try { await action.onClick(); } finally { dismiss(); }
      };
      el.appendChild(btn);
    } else {
      el.textContent = message;
    }
    host.appendChild(el);
    timer = setTimeout(dismiss, duration);
  }

  // =========================================================================
  // Muscle select
  // =========================================================================
  function populateMuscleSelect(selectEl) {
    selectEl.innerHTML = MUSCLES.filter(m => m.id !== 'unclassified')
      .map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  }

  // =========================================================================
  // Apple Fitness (Shortcuts deep link) — see "Apple Fitness" under Set
  // logging UX in design-summary.md for the full write-up of why this is the
  // only bridge available and what it can't do.
  // =========================================================================
  async function triggerAppleFitnessWorkout() {
    const name = (await getSetting('appleFitnessShortcutName', '')).trim();
    if (!name) return false;
    location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(name)}`;
    return true;
  }
  // Called from every place a SplitCraft session can start (see the
  // `sessionJustStarted` flag in 02-storage.js); a no-op unless the setting
  // is on AND this particular call is the one that actually started today's
  // session, so it can never fire twice in one day no matter how many times
  // Start is pressed or sets are logged afterward.
  async function maybeAutoStartAppleFitness(workout) {
    if (!workout || !workout.sessionJustStarted) return;
    if (!(await getSetting('appleFitnessAutoStart', false))) return;
    await triggerAppleFitnessWorkout();
  }

