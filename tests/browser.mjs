// Real-browser smoke suite: drives a headless Chrome/Edge over the DevTools
// protocol against the built app, so real IndexedDB and a real DOM are in play.
//
// Everything else in tests/ runs the app in a Node vm sandbox with an
// in-memory database and stub elements, and three bugs lived exactly in the
// gap between the two: real IndexedDB never stamps a generated id back onto
// the caller's object (the in-memory store did), and stub elements have no
// real parent/sibling links, so a markup change that broke the ± button's
// sibling lookup passed every suite. These checks run against the real thing.
//
// Skips (exit 0) when no Chrome/Edge is installed or Node has no global
// WebSocket, so the suite never fails a machine for lacking a browser. Point
// CHROME_PATH at a binary to use a specific one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_FILE = process.env.APP ? path.resolve(process.env.APP) : path.join(ROOT, 'splitcraft.html');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);
const BROWSER = CANDIDATES.find(p => fs.existsSync(p));
if (!BROWSER || typeof WebSocket !== 'function') {
  console.log(`skipped — ${!BROWSER ? 'no Chrome/Edge found (set CHROME_PATH to run this suite)' : 'this Node has no global WebSocket'}`);
  process.exit(0);
}

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A throwaway static server on a free port — the app has to be served over
// http(s) for IndexedDB and the service worker to behave as they do deployed.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = urlPath === '/splitcraft.html' || urlPath === '/' ? APP_FILE : path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT) && file !== APP_FILE) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const appUrl = `http://127.0.0.1:${server.address().port}/splitcraft.html`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'splitcraft-browser-'));
const browser = spawn(BROWSER, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=430,900', 'about:blank'], { stdio: 'ignore' });

let ws;
async function cleanup() {
  try { ws && ws.close(); } catch (e) { /* already closed */ }
  browser.kill();
  server.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* best effort */ }
}

try {
  // --remote-debugging-port=0 picks a free port and writes it to this file.
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch (e) { await sleep(100); }
  }
  if (!port) throw new Error('the browser never opened its DevTools port');
  let targets = [];
  for (let i = 0; i < 50 && !targets.some(t => t.type === 'page'); i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch (e) { await sleep(100); }
  }
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  // Evaluates in the page; a thrown error comes back as { EXCEPTION } rather
  // than rejecting, so one broken check reports itself and the rest still run.
  const run = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    const ex = res.result && res.result.exceptionDetails;
    if (ex) return { EXCEPTION: (ex.exception && ex.exception.description) || ex.text };
    return res.result.result.value;
  };

  await send('Page.navigate', { url: appUrl });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await sleep(100);
    ready = await run('return typeof refreshLogAndHistory === "function" && dbAvailable === true && !!db && !!document.getElementById("active-workout-list");');
  }
  check('the app loads on a real IndexedDB', ready === true, JSON.stringify(ready));
  await sleep(500);   // let init() finish its first render

  // --- 1. A generated id comes back on the caller's object. ---
  const ids = await run(`
    const plan = { createdAt: Date.now(), goal: 'Probe', daysPerWeek: 1, days: [{ name: 'D', exercises: [] }] };
    const returned = await addRecord('plans', plan);
    await deleteRecord('plans', returned);
    return { returned, onObject: plan.id === undefined ? 'undefined' : plan.id };`);
  check('addRecord() stamps the generated id onto the saved object (real IndexedDB doesn\'t on its own)',
    ids && ids.returned != null && ids.onObject === ids.returned, JSON.stringify(ids));

  // --- 2. RIR for a day's first set, logged as a drop set. ---
  const rir = await run(`
    await clearWorkoutHistory();
    const ex = (await getAllRecords('exercises')).find(e => e.name === 'Barbell Bench Press');
    const w = await logSet(ex.id, 'drop', [{ weight: 50, reps: 8 }, { weight: 40, reps: 6 }], null);
    await setSetRir(w.id, ex.id, 0, 2, w.exercises[0].sets[0].ts);
    return (await getWorkoutForDate(todayStr())).exercises[0].sets[0].rir;`);
  check('the RIR answer for a day\'s first set (a drop set) is saved', rir === 2, JSON.stringify(rir));

  // Shared setup for the DOM checks: a one-exercise plan made active.
  const usePlan = (exerciseName) => `
    await clearWorkoutHistory();
    const ex = (await getAllRecords('exercises')).find(e => e.name === ${JSON.stringify(exerciseName)});
    const planId = await addRecord('plans', { createdAt: Date.now(), goal: 'Probe', daysPerWeek: 1,
      days: [{ name: 'D', exercises: [{ exerciseId: ex.id, name: ex.name, targetSets: 3, repRangeMin: 5, repRangeMax: 8 }] }] });
    await setCurrentPlan(planId);
    selectedLogDayIdx = null;`;

  // --- 3. ± through the .weight-field wrapper, on real markup. ---
  const sign = await run(`${usePlan('Assisted Pull-Up')}
    await refreshLogAndHistory();
    const row = document.querySelector('#ex-card-' + ex.id + ' .plan-log-row.next-set');
    const input = row.querySelector('.plan-log-weight');
    input.value = '40';
    row.querySelector('.sign-btn').click();
    return { value: input.value, negative: row.querySelector('.sign-btn').classList.contains('negative') };`);
  check('± negates the weight through the .weight-field wrapper (real DOM)',
    sign && sign.value === '-40' && sign.negative === true, JSON.stringify(sign));

  // --- 3b. Drop / Myo shares Log's line, fits the row, and opens its modal. ---
  const dm = await run(`${usePlan('Dumbbell Bench Press')}
    document.querySelector('.tab-btn[data-tab="log"]').click();
    await refreshLogAndHistory();
    const row = document.querySelector('#ex-card-' + ex.id + ' .plan-log-row.next-set');
    const r = (el) => el.getBoundingClientRect();
    const log = r(row.querySelector('.log-btn')), btn = r(row.querySelector('.dropmyo-btn')), box = r(row);
    row.querySelector('.dropmyo-btn').click();
    const opened = document.getElementById('dropmyo-modal').hidden === false;
    closeDropMyoModal();
    return { sameLine: Math.abs(log.top - btn.top) < 1, fits: btn.right <= box.right + 0.5 && log.left >= box.left - 0.5,
      logWider: log.width > btn.width, opened };`);
  check('Drop / Myo sits on Log\'s line inside the row, Log stays the wider, and it opens the modal',
    dm && dm.sameLine && dm.fits && dm.logWider && dm.opened, JSON.stringify(dm));

  // --- 4. A double-tapped × deletes one set. ---
  const del = await run(`${usePlan('Back Squat')}
    for (const kg of [100, 105, 110]) await logSet(ex.id, 'standard', [{ weight: kg, reps: 5 }], null);
    await refreshLogAndHistory();
    const btn = document.querySelector('#ex-card-' + ex.id + ' .plan-log-row.done-set .del');
    btn.click(); btn.click();
    await new Promise(r => setTimeout(r, 800));
    return (await getWorkoutForDate(todayStr())).exercises[0].sets.map(s => s.entries[0].weight);`);
  check('double-tapping a set\'s × deletes exactly that one set', JSON.stringify(del) === '[105,110]', JSON.stringify(del));

  // --- 5. History renders only while showing, and catches up on the tab tap. ---
  const lazy = await run(`${usePlan('Back Squat')}
    document.querySelector('.tab-btn[data-tab="log"]').click();
    document.getElementById('history-list').innerHTML = '';
    await logSet(ex.id, 'standard', [{ weight: 100, reps: 5 }], null);
    await refreshLogAndHistory();
    const whileHidden = document.querySelectorAll('#history-list details.session').length;
    document.querySelector('.tab-btn[data-tab="history"]').click();
    await new Promise(r => setTimeout(r, 300));
    const afterTap = document.querySelectorAll('#history-list details.session').length;
    document.querySelector('.tab-btn[data-tab="log"]').click();
    return { whileHidden, afterTap };`);
  check('History isn\'t rebuilt while hidden, and renders when its tab is tapped (real tab panels)',
    lazy && lazy.whileHidden === 0 && lazy.afterTap >= 1, JSON.stringify(lazy));

  // --- 6. A restore that fails partway changes nothing. ---
  const restore = await run(`
    await setSetting('planNotes', 'before-restore');
    const before = await buildBackup();
    const d = JSON.parse(JSON.stringify(before.data));
    d.settings.planNotes = 'SHOULD-NOT-APPLY';
    d.workouts.push({ id: { not: 'a valid key' }, date: '2026-01-01', exercises: [] });
    let error = null;
    try { await applyRestore(d); } catch (e) { error = e.name || String(e); }
    invalidateWorkoutsCache();
    const after = await buildBackup();
    return { error, before: before.counts, after: after.counts,
      notesInStore: (await idbGetAll('settings')).find(r => r.key === 'planNotes').value };`);
  check('a restore that fails partway is rolled back — nothing changes',
    restore && restore.error && JSON.stringify(restore.before) === JSON.stringify(restore.after)
      && restore.notesInStore === 'before-restore',
    JSON.stringify(restore));
} catch (e) {
  check('browser suite ran to completion', false, e && e.stack || String(e));
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
