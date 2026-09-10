// Runs the app's real <script> in Node against a stub DOM, so the shipping
// code is exercised instead of a Perl reimplementation of it. IndexedDB is
// deliberately absent, which drives the app down its in-memory fallback path.
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(process.env.APP || process.argv[2] || new URL('../splitcraft.html', import.meta.url), 'utf8');
const js = html.match(/<script>([\s\S]*)<\/script>/)[1];

const listeners = new Map();          // element id -> { event -> fn }
const errors = [];

function makeEl(id = '(anon)') {
  const el = {
    id, value: '', textContent: '', innerHTML: '', placeholder: '', step: '',
    checked: false, disabled: false, hidden: false, open: false,
    dataset: {}, style: {}, options: [], children: [],
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    indexNames: { contains(){ return false; } },
    addEventListener(ev, fn) {
      if (!listeners.has(id)) listeners.set(id, {});
      listeners.get(id)[ev] = fn;
    },
    removeEventListener(){},
    appendChild(c){ el.children.push(c); return c; },
    removeChild(){}, remove(){}, insertBefore(c){ return c; },
    setAttribute(){}, getAttribute(){ return null; }, hasAttribute(){ return false; },
    querySelector(){ return makeEl(id + '>q'); },
    // One stub element per selector, so every `forEach(el => ...)` render
    // body actually RUNS. Returning [] silently skipped exactly the code
    // where the wrong-variable bugs lived.
    querySelectorAll(sel){ return [makeEl(id + '>>' + sel)]; },
    closest(){ return makeEl(id + '>closest'); },
    // downloadFile() (06-catalog-import-backup.js) builds a throwaway <a> and
    // calls .click() on it directly, rather than dispatching a click event —
    // nothing exercised that path before Blob/File/URL existed in this
    // sandbox (see below), so a bare stub element had no reason to support
    // it until now.
    click(){}, focus(){}, blur(){}, scrollIntoView(){}, dispatchEvent(){ return true; },
    getBoundingClientRect(){ return { width: 320, height: 118, top: 0, left: 0 }; },
    get nextElementSibling(){ return makeEl(id + '>next'); },
    get previousElementSibling(){ return makeEl(id + '>prev'); },
  };
  allEls.push(el);
  return el;
}

// Shared by localStorage and sessionStorage below — same in-memory Map-backed
// shape, just two separate instances, matching how a real browser keeps them
// as genuinely independent stores.
function makeStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k), clear: () => m.clear(),
  };
}

const allEls = [];
const elCache = new Map();
const document = {
  getElementById(x) { if (!elCache.has(x)) elCache.set(x, makeEl(x)); return elCache.get(x); },
  createElement: (t) => makeEl('<' + t + '>'),
  querySelector: () => makeEl('doc>q'),
  querySelectorAll: (sel) => [makeEl('doc>>' + sel)],
  addEventListener(){}, body: makeEl('body'), documentElement: makeEl('html'),
};

const sandbox = {
  document, console,
  window: {
    addEventListener(ev, fn) { listeners.set('window:' + ev, { [ev]: fn }); },
    matchMedia: () => ({ matches: false, addEventListener(){} }),
    AudioContext: function () { throw new Error('no audio'); },
  },
  // `share`/`canShare` deliberately absent by default — Node has no Web
  // Share API, and this matches a desktop browser without one just as
  // faithfully as it matches Node. Feature-detection in
  // 06-catalog-import-backup.js (`canShareFiles`) therefore reads false at
  // load, same as it would on a browser that never shipped the API, and the
  // share-path tests in features.mjs assign stub functions here directly
  // (then remove them again) to exercise the share/AbortError/fallback
  // branches without a real OS share sheet.
  navigator: { vibrate(){}, userAgent: 'node' },
  location: { search: '', hash: '', origin: 'null', pathname: '/x', href: 'file:///x' },
  // history.replaceState is real in a browser; here it's a no-op stub so the
  // Dropbox OAuth redirect handler (handleDropboxRedirect(), in
  // 06-catalog-import-backup.js) can call it unconditionally after reading
  // location.search, without the test harness needing to fake navigation.
  history: { replaceState(){} },
  // Full enough to enumerate: the app's factory reset walks localStorage by
  // index to find its own `ironlog.setting.*` keys, and a stub with no
  // `length`/`key()` silently makes that loop a no-op — so the test would pass
  // while the real mirror survived the reset and quietly resurrected every
  // setting on the next read.
  localStorage: makeStorage(),
  // Same shape as localStorage, and needed for the same reason a real browser
  // has both: the Dropbox PKCE code_verifier (startDropboxConnect(), in
  // 06-catalog-import-backup.js) has to survive a full navigation to
  // dropbox.com and back, which a plain in-memory variable would not.
  sessionStorage: makeStorage(),
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  fetch: async () => { throw new Error('fetch not stubbed for this run'); },
  Event: class { constructor(t){ this.type = t; } },
  // TextEncoder joins the TextDecoder that was already here — encrypted
  // backups (see the `crypto` comment below) need to turn the backup's JSON
  // text into UTF-8 bytes before AES-GCM can touch it, and this sandbox only
  // has what's explicitly listed on this object.
  URLSearchParams, TextDecoder, TextEncoder, AbortController,
  Math, JSON, Date, Promise, Object, Array, Number, String, Boolean, Map, Set, RegExp, Error,
  isNaN, parseInt, parseFloat, Infinity, NaN, undefined,
  // Node exposes WebCrypto as `globalThis.crypto` (subtle + getRandomValues),
  // but a vm.createContext sandbox only gets what's explicitly listed here —
  // unlike Math/JSON/Date above, `crypto` isn't one of the handful of
  // built-ins Node auto-attaches to a new context, so encrypted-backup code
  // (encryptBackupData/decryptBackupData in 06-catalog-import-backup.js)
  // would see `crypto` as undefined and fail before a single test ran. This
  // hands the real Node implementation through rather than stubbing it, so
  // the test suite exercises the same PBKDF2/AES-GCM code path a browser
  // would run.
  crypto: globalThis.crypto,
  // Same reasoning as `crypto` above, for the same reason: a vm sandbox gets
  // nothing Node doesn't explicitly hand it. downloadFile() needs Blob/URL,
  // and the share-sheet path (buildExportPayload() + the share button
  // handler) needs File — Node has real, spec-compliant implementations of
  // all three since v20, so this runs the actual construction/MIME-type code
  // rather than a hand-rolled substitute for it.
  Blob: globalThis.Blob, File: globalThis.File, URL: globalThis.URL,
};
sandbox.window.document = document;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e && e.stack || e)));
process.on('uncaughtException',  (e) => errors.push('uncaughtException: '  + (e && e.stack || e)));

try {
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'app.js' });
} catch (e) {
  errors.push('top-level throw: ' + (e && e.stack || e));
}

// give init()'s promise chain a chance to run and fail
await new Promise(r => setTimeout(r, 400));

// Assigning a handler proves nothing; the wrong-variable bugs only throw
// when the handler RUNS. Fire every onclick/onchange the render paths left
// behind, which is the closest a stub can get to using the app.
let fired = 0;
for (const el of allEls.slice()) {
  for (const h of ['onclick', 'onchange', 'oninput']) {
    if (typeof el[h] !== 'function') continue;
    fired++;
    try { await el[h]({ preventDefault(){}, target: el, stopPropagation(){} }); }
    catch (e) { errors.push(`handler ${h} on ${el.id}: ` + (e && e.stack || e)); }
  }
}
await new Promise(r => setTimeout(r, 200));
console.log('--- listeners wired:', listeners.size, '| handlers fired:', fired);
if (errors.length) { console.log('\nERRORS:\n' + errors.join('\n\n')); process.exitCode = 1; }
else console.log('no errors during load + init');

// Handlers removed once load is done. They exist to catch async faults during
// init; left installed they also swallow anything a test throws afterwards,
// which silently turned a failing suite into a clean exit 0.
process.removeAllListeners('unhandledRejection');
process.removeAllListeners('uncaughtException');

// Expose the app's own top-level function declarations. In a vm script scope
// `function f(){}` attaches to the context object, so these are the REAL
// implementations, not a reimplementation of them.
export const app = sandbox;
// Handlers registered with addEventListener, keyed by element id then event.
// ui.mjs only fires the `onclick`/`onchange`/`oninput` PROPERTIES, so anything
// wired with addEventListener — the history search box, the tab bar, the
// forms — was never exercised by any suite. Exposing the map makes those
// reachable: `listeners.get('history-search').input({ target: { value: 'x' } })`.
export { allEls, errors, listeners };
