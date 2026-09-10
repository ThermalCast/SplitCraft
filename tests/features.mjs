// Backup round-trip, ramped-set progression, and the start-of-week plan prompt.
//
// These are the three pieces of behaviour where being wrong is expensive and
// invisible: a backup that doesn't restore is worse than no backup, a
// progression model that silently stalls looks like a considered
// recommendation, and a weekly prompt that fires on the wrong week is just
// nagging.
// allEls: exposes every stub DOM element the app has ever created, so the
// share/download tests below can tell which delivery path actually ran by
// checking whether a download anchor got created (see harness.mjs).
import { app, listeners, allEls } from './harness.mjs';
import { seedDemoData } from './seed.mjs';

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ' — ' + detail : ''}`); }
}

// ---------------------------------------------------------------------------
// Backup round-trip.
// ---------------------------------------------------------------------------
await seedDemoData(app);
await app.setSetting('openrouterKey', 'sk-or-secret-do-not-export');
await app.setSetting('restDefault', 120);

const backup = await app.buildBackup();

check('backup carries the format marker and version',
  backup.format === 'ironlog-backup' && backup.version === 1,
  `${backup.format} v${backup.version}`);
check('backup counts match the store',
  backup.counts.workouts === backup.data.workouts.length && backup.counts.workouts === 10,
  `${backup.counts.workouts} workouts`);
check('backup includes plans and exercises',
  backup.data.plans.length === 1 && backup.data.exercises.length > 50,
  `${backup.data.plans.length} plans / ${backup.data.exercises.length} exercises`);
check('backup carries ordinary settings',
  backup.data.settings.restDefault === 120, JSON.stringify(backup.data.settings.restDefault));

// The one that actually matters for a file destined for cloud storage.
check('backup EXCLUDES the OpenRouter API key',
  !('openrouterKey' in backup.data.settings)
  && !JSON.stringify(backup).includes('sk-or-secret-do-not-export'));

check('backup validates as a backup', await (async () => {
  try { await app.validateBackup(JSON.parse(JSON.stringify(backup))); return true; } catch (e) { return false; }
})());

// Rejections. Each of these precedes a button that erases the device.
// validateBackup() is async (it has to be able to await a decrypt — see the
// encrypted-backup section below), so this and every call site await it.
const rejects = async (obj, label) => {
  let threw = false;
  try { await app.validateBackup(obj); } catch (e) { threw = true; }
  check(`validateBackup rejects ${label}`, threw);
};
await rejects({ hello: 'world' }, 'a foreign JSON file');
await rejects({ format: 'ironlog-backup', version: 1 }, 'a backup with no data section');
await rejects({ format: 'ironlog-backup', version: 1, data: { workouts: [], exercises: [] } }, 'a backup missing a store');
await rejects({ format: 'ironlog-backup', version: 99, data: { workouts: [], exercises: [], plans: [] } }, 'a FUTURE format version');
// NaN > N is always false, so a missing/garbled version used to sail past
// the future-version guard undetected and proceed toward a destructive
// restore. Both shapes must be caught explicitly.
await rejects({ format: 'ironlog-backup', data: { workouts: [], exercises: [], plans: [] } }, 'a MISSING version field');
await rejects({ format: 'ironlog-backup', version: 'garbled', data: { workouts: [], exercises: [], plans: [] } }, 'a non-numeric version field');

// Ids have to survive, or plans stop resolving their exercises.
const planEx = backup.data.plans[0].days[0].exercises[0];
check('plan exercise references are real ids in the same file',
  backup.data.exercises.some(e => e.id === planEx.exerciseId),
  `exerciseId ${planEx.exerciseId}`);

// ---------------------------------------------------------------------------
// FULL ROUND TRIP: export -> wipe -> restore -> everything still resolves.
//
// The failure this exists to prevent is quiet and total. Ids are the only
// thing tying a plan or a workout to its exercises, so a restore that
// reassigns them produces a database that looks populated, renders without
// throwing, and has lost every cross-reference: plan days full of "Unknown
// exercise", history that can't name a single lift. It has to be checked by
// following the references, not by counting rows.
// ---------------------------------------------------------------------------
const snapshot = JSON.parse(JSON.stringify(backup));

await app.clearStore('workouts');
await app.clearStore('exercises');
app.invalidateWorkoutsCache();
check('clearing the stores really empties them',
  (await app.getAllRecords('workouts')).length === 0 && (await app.getAllRecords('exercises')).length === 0);

// The REAL restore path, not a reimplementation of it — applyRestore() is
// exactly what the Replace All Data button calls.
await app.applyRestore(snapshot.data);

const restored = await app.buildBackup();
check('round trip preserves every count',
  JSON.stringify(restored.counts) === JSON.stringify(backup.counts),
  `${JSON.stringify(restored.counts)} vs ${JSON.stringify(backup.counts)}`);

const exIds = new Set((await app.getAllRecords('exercises')).map(e => e.id));
const restoredPlan = (await app.getAllRecords('plans'))[0];
const danglingPlanRefs = restoredPlan.days.flatMap(d => d.exercises).filter(e => !exIds.has(e.exerciseId));
check('no dangling plan → exercise references after restore',
  danglingPlanRefs.length === 0, `${danglingPlanRefs.length} dangling`);

const danglingSetRefs = (await app.getAllWorkouts()).flatMap(w => w.exercises).filter(e => !exIds.has(e.exerciseId));
check('no dangling workout → exercise references after restore',
  danglingSetRefs.length === 0, `${danglingSetRefs.length} dangling`);

// The counter must resume above the restored ids, or the next added exercise
// overwrites a restored one.
const newId = await app.addRecord('exercises', { name: 'Post-Restore Test Lift', primaryMuscle: 'chest', secondaryMuscles: [], custom: true });
check('a new record after restore does not collide with a restored id',
  !exIds.has(newId), `new id ${newId} collided`);

// And it still renders.
let rendered = true;
try { await app.refreshLogAndHistory(); await app.refreshPlanTab(); } catch (e) { rendered = false; }
check('the app re-renders from restored data', rendered);

// ---------------------------------------------------------------------------
// getAllWorkouts() must retry after a rejected read, not cache the rejection.
//
// The promise itself is cached (not the resolved array) so concurrent callers
// during one render share a single read instead of racing to start several —
// but a rejected promise is still truthy, so `if (!workoutsCachePromise)`
// used to never fire again until an unrelated write invalidated the cache,
// wedging every reader (History, the week counter, active-workout rendering,
// suggestForExercise) behind one transient failure forever.
// ---------------------------------------------------------------------------
{
  app.invalidateWorkoutsCache();
  const realGetAllRecords = app.getAllRecords;
  app.getAllRecords = async (store) => {
    if (store === 'workouts') throw new Error('simulated transient read failure');
    return realGetAllRecords(store);
  };
  let threw = false;
  try { await app.getAllWorkouts(); } catch (e) { threw = true; }
  check('a failed read rejects rather than hanging or silently returning nothing', threw);

  app.getAllRecords = realGetAllRecords;   // the "transient" failure is over
  let retried = true;
  try { await app.getAllWorkouts(); } catch (e) { retried = false; }
  check('the NEXT call retries instead of replaying the cached rejection forever', retried);
}

// ---------------------------------------------------------------------------
// The backup-preview injection. A recently-fixed bug: the `backup-file`
// change handler builds its preview with innerHTML, and interpolated
// `inc.sets` (from the untrusted file's own `counts.sets`) is now coerced
// with Number(...) before it goes in. This reintroduces the attack a crafted
// backup file could carry, to prove the fix holds: a non-numeric
// `counts.sets` must not survive into the rendered markup.
// ---------------------------------------------------------------------------
{
  const goodBackup = await app.buildBackup();
  const evilCounts = JSON.parse(JSON.stringify(goodBackup));
  evilCounts.counts.sets = '<img src=x onerror=alert(1)>';

  const backupFileChange = listeners.get('backup-file') && listeners.get('backup-file').change;
  check('the backup-file change handler is wired at all', !!backupFileChange);

  if (backupFileChange) {
    await backupFileChange({ target: { files: [{ text: async () => JSON.stringify(evilCounts) }] } });
    const previewHtml = app.document.getElementById('backup-preview-text').innerHTML;
    check('a crafted counts.sets does not inject markup into the preview',
      !previewHtml.includes('<img'), previewHtml);
    check('the preview still rendered despite the crafted field',
      previewHtml.includes('Restoring replaces'), previewHtml);

    // Same proof for exportedAt, which is esc()ed rather than coerced — this
    // pins that it STAYS escaped rather than testing the coercion fix twice.
    const evilDate = JSON.parse(JSON.stringify(goodBackup));
    evilDate.exportedAt = '<script>alert(1)</script>';
    await backupFileChange({ target: { files: [{ text: async () => JSON.stringify(evilDate) }] } });
    const previewHtml2 = app.document.getElementById('backup-preview-text').innerHTML;
    check('a crafted exportedAt does not inject markup into the preview',
      !previewHtml2.includes('<script>'), previewHtml2);
    check('the preview still rendered despite the crafted exportedAt',
      previewHtml2.includes('Restoring replaces'), previewHtml2);
  }
}

// ---------------------------------------------------------------------------
// Encrypted backups (OPTIONAL — see the comment above buildEncryptedBackup()
// in 06-catalog-import-backup.js for why plaintext stays the default).
//
// Exercises the raw crypto round trip, a wrong passphrase, a corrupted
// ciphertext, salt/IV uniqueness across exports, that a plaintext backup is
// completely unaffected, and that validateBackup() decrypts-then-recurses
// into its ordinary deep validation rather than a second, weaker copy of it.
// ---------------------------------------------------------------------------
{
  const plaintextBackup = await app.buildBackup();
  const passphrase = 'correct horse battery staple';

  const envelope = await app.buildEncryptedBackup(passphrase);
  check('an encrypted export keeps the format marker unchanged',
    envelope.format === 'ironlog-backup', envelope.format);
  check('an encrypted export is flagged encrypted, with no plaintext data field',
    envelope.encrypted === true && !('data' in envelope), JSON.stringify(Object.keys(envelope)));
  check('the KDF is PBKDF2/SHA-256 at 600000 iterations, with a salt attached',
    envelope.kdf.name === 'PBKDF2' && envelope.kdf.hash === 'SHA-256'
    && envelope.kdf.iterations === 600000 && typeof envelope.kdf.salt === 'string' && envelope.kdf.salt.length > 0,
    JSON.stringify(envelope.kdf));

  // --- Round trip, byte-for-byte. ---
  const decrypted = await app.decryptBackupData(envelope, passphrase);
  check('encrypt -> decrypt returns the ORIGINAL payload byte-for-byte',
    JSON.stringify(decrypted) === JSON.stringify(plaintextBackup));

  // --- validateBackup() branches on encrypted:true and re-runs full validation. ---
  const validated = await app.validateBackup(envelope, passphrase);
  check('validateBackup() on an encrypted envelope returns the decrypted, fully-validated payload',
    JSON.stringify(validated) === JSON.stringify(plaintextBackup));

  let noPassphraseMsg = null;
  try { await app.validateBackup(envelope); } catch (e) { noPassphraseMsg = e.message; }
  check('validateBackup() with no passphrase asks for one instead of proceeding',
    !!noPassphraseMsg && /passphrase/i.test(noPassphraseMsg), noPassphraseMsg);

  // --- Wrong passphrase: a friendly message, never the raw WebCrypto error. ---
  let wrongMsg = null;
  try { await app.decryptBackupData(envelope, 'not the right passphrase'); } catch (e) { wrongMsg = e.message; }
  check('a wrong passphrase fails with the friendly message, not a raw crypto exception',
    wrongMsg === 'That passphrase didn’t decrypt this backup.', wrongMsg);

  let wrongViaValidate = null;
  try { await app.validateBackup(envelope, 'not the right passphrase'); } catch (e) { wrongViaValidate = e.message; }
  check('the same friendly message surfaces through validateBackup() too',
    wrongViaValidate === 'That passphrase didn’t decrypt this backup.', wrongViaValidate);

  // --- A corrupted/truncated ciphertext is rejected cleanly, not thrown raw. ---
  const corrupted = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -8) };
  let corruptedMsg = null;
  try { await app.validateBackup(corrupted, passphrase); } catch (e) { corruptedMsg = e.message; }
  check('a truncated ciphertext is rejected with the same friendly message, not a crash',
    corruptedMsg === 'That passphrase didn’t decrypt this backup.', corruptedMsg);

  // --- Salt and IV are never reused. ---
  const envelope2 = await app.buildEncryptedBackup(passphrase);
  check('two successive encryptions of the same data use different salts',
    envelope.kdf.salt !== envelope2.kdf.salt);
  check('two successive encryptions of the same data use different IVs',
    envelope.iv !== envelope2.iv);
  check('...and therefore different ciphertext, even for identical plaintext',
    envelope.ciphertext !== envelope2.ciphertext);

  // --- Backward compatibility: a plaintext backup is completely unaffected. ---
  const plainValidated = await app.validateBackup(JSON.parse(JSON.stringify(plaintextBackup)));
  check('a plaintext backup still validates exactly as it did before encryption existed',
    JSON.stringify(plainValidated) === JSON.stringify(plaintextBackup));

  // --- The full encrypted-restore path, through the real UI wiring. ---
  const beforeRestore = await app.buildBackup();
  const fileChange = listeners.get('backup-file') && listeners.get('backup-file').change;
  const decryptClick = listeners.get('backup-decrypt-btn') && listeners.get('backup-decrypt-btn').click;
  check('the backup-file and decrypt-button handlers are both wired', !!fileChange && !!decryptClick);
  if (fileChange && decryptClick) {
    await fileChange({ target: { files: [{ text: async () => JSON.stringify(envelope) }] } });
    check('picking an encrypted file shows the passphrase prompt, not a preview',
      app.document.getElementById('backup-decrypt-prompt').style.display === 'block'
      && app.document.getElementById('backup-preview').style.display !== 'block');

    app.document.getElementById('backup-restore-passphrase').value = passphrase;
    await decryptClick({});
    check('decrypting with the right passphrase reveals the normal restore preview',
      app.document.getElementById('backup-preview').style.display === 'block');
    const previewText = app.document.getElementById('backup-preview-text').innerHTML;
    check('the decrypted preview reports the real counts, not placeholders',
      previewText.includes(`${beforeRestore.counts.workouts}`), previewText);
  }
}

// ---------------------------------------------------------------------------
// Backup delivery: Web Share API vs. the plain download fallback, and the
// "Last backup" staleness reminder.
//
// navigator.share/canShare don't exist in Node (see the comment in
// harness.mjs) — each case here assigns stub functions straight onto
// app.navigator, then deletes them again immediately after, so this suite's
// use of the API can't leak into anything that runs later in the same
// process.
// ---------------------------------------------------------------------------
{
  const exportClick = listeners.get('backup-export-btn') && listeners.get('backup-export-btn').click;
  const shareClick = listeners.get('backup-share-btn') && listeners.get('backup-share-btn').click;
  check('the download and share buttons are both wired', !!exportClick && !!shareClick);
  const status = () => app.document.getElementById('backup-export-status').textContent;
  const anchorCount = () => allEls.filter(e => e.id === '<a>').length;

  // --- canShare({files}) true: the share path runs, the download path doesn't. ---
  {
    await app.setSetting('lastBackupAt', null);
    let shareCalls = 0, sharedFile = null;
    app.navigator.canShare = (opts) => !!(opts && Array.isArray(opts.files));
    app.navigator.share = async (opts) => { shareCalls++; sharedFile = opts.files[0]; };
    const before = anchorCount();

    await shareClick({});

    check('canShare({files})=true calls navigator.share and creates no download anchor',
      shareCalls === 1 && anchorCount() === before, `shareCalls=${shareCalls}`);
    check('the shared object is a real File named like a backup',
      !!sharedFile && /^splitcraft-backup-.*\.json$/.test(sharedFile.name), sharedFile && sharedFile.name);
    check('a completed share records lastBackupAt',
      Number.isFinite(await app.getSetting('lastBackupAt', null)));

    delete app.navigator.canShare; delete app.navigator.share;
  }

  // --- canShare({files}) false: falls back to the ordinary download anchor. ---
  {
    await app.setSetting('lastBackupAt', null);
    let shareCalls = 0;
    app.navigator.canShare = () => false;
    app.navigator.share = async () => { shareCalls++; };
    const before = anchorCount();

    await shareClick({});

    const madeDownloadAnchor = allEls.slice(before).some(e => /^splitcraft-backup-.*\.json$/.test(e.download));
    check('canShare({files})=false never calls navigator.share and downloads instead',
      shareCalls === 0 && madeDownloadAnchor, `shareCalls=${shareCalls}`);
    check('the fallback download still records lastBackupAt',
      Number.isFinite(await app.getSetting('lastBackupAt', null)));

    delete app.navigator.canShare; delete app.navigator.share;
  }

  // --- Cancelling the share sheet (AbortError) is a normal outcome. ---
  {
    await app.setSetting('lastBackupAt', null);
    app.navigator.canShare = (opts) => !!(opts && Array.isArray(opts.files));
    app.navigator.share = async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; };

    await shareClick({});

    check('cancelling the share sheet does NOT record lastBackupAt',
      (await app.getSetting('lastBackupAt', null)) === null);
    check('cancelling the share sheet shows no error message', status() === '', status());

    delete app.navigator.canShare; delete app.navigator.share;
  }

  // --- Any OTHER share rejection still delivers the file by download. ---
  {
    await app.setSetting('lastBackupAt', null);
    app.navigator.canShare = (opts) => !!(opts && Array.isArray(opts.files));
    app.navigator.share = async () => { throw new Error('NotAllowedError'); };
    const before = anchorCount();

    await shareClick({});

    check('a non-cancel share failure falls back to a download and records lastBackupAt',
      allEls.slice(before).some(e => /^splitcraft-backup-.*\.json$/.test(e.download))
      && Number.isFinite(await app.getSetting('lastBackupAt', null)));

    delete app.navigator.canShare; delete app.navigator.share;
  }

  // --- Encrypted exports share/download the .enc.json file, not the plaintext one. ---
  {
    await app.setSetting('lastBackupAt', null);
    let sharedFile = null;
    app.navigator.canShare = (opts) => !!(opts && Array.isArray(opts.files));
    app.navigator.share = async (opts) => { sharedFile = opts.files[0]; };
    const encryptBox = app.document.getElementById('backup-encrypt');
    encryptBox.checked = true;
    app.document.getElementById('backup-export-passphrase').value = 'a real passphrase';
    app.document.getElementById('backup-export-passphrase-confirm').value = 'a real passphrase';

    await shareClick({});

    check('an encrypted share carries the .enc.json filename',
      !!sharedFile && /\.enc\.json$/.test(sharedFile.name), sharedFile && sharedFile.name);
    let sharedEnvelope = null;
    try { sharedEnvelope = JSON.parse(await sharedFile.text()); } catch (e) { /* leave null */ }
    check('the shared file really is the encrypted envelope, not a plaintext backup',
      !!sharedEnvelope && sharedEnvelope.encrypted === true && !('data' in sharedEnvelope));

    encryptBox.checked = false;
    delete app.navigator.canShare; delete app.navigator.share;
  }

  // --- Restoring a backup adopts the FILE's own exportedAt, not "now". ---
  {
    const oldExportedAt = new Date(Date.now() - 90 * 86400000).toISOString();
    const oldBackup = await app.buildBackup();
    oldBackup.exportedAt = oldExportedAt;
    await app.setSetting('lastBackupAt', Date.now()); // this device "just" backed up
    const restoreClick = listeners.get('backup-restore-btn') && listeners.get('backup-restore-btn').click;
    const fileChange = listeners.get('backup-file') && listeners.get('backup-file').change;
    check('the restore button and file input are both wired', !!restoreClick && !!fileChange);
    if (restoreClick && fileChange) {
      await fileChange({ target: { files: [{ text: async () => JSON.stringify(oldBackup) }] } });
      await restoreClick({}); // `confirm` doesn't exist in this sandbox, so the guard no-ops
      check('restoring an old backup sets lastBackupAt to the FILE\'s exportedAt, not the restore time',
        (await app.getSetting('lastBackupAt', null)) === Date.parse(oldExportedAt),
        `${await app.getSetting('lastBackupAt', null)} vs ${Date.parse(oldExportedAt)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Dropbox cloud backup (06-catalog-import-backup.js) — PKCE connect, token
// refresh/caching, the CORS-safe upload shape, and the disconnect path.
// fetch is stubbed per-case exactly like the OpenRouter tests above, and
// app.location/app.sessionStorage are the harness's real, stateful stubs
// (see harness.mjs), not throwaway objects — resetting the fields this
// suite touches at the top keeps it independent of everything before it.
// ---------------------------------------------------------------------------
{
  const REAL_FETCH_ERROR = 'fetch not stubbed for this run';
  await app.setSetting('dropboxRefreshToken', null);
  app.location.search = ''; app.location.href = 'file:///x';
  app.sessionStorage.clear();

  // --- backup exclusion, same mechanism as the OpenRouter key. ---
  await app.setSetting('dropboxRefreshToken', 'sl.refresh-token-do-not-export');
  const dbBackup = await app.buildBackup();
  check('backup EXCLUDES the Dropbox refresh token',
    !('dropboxRefreshToken' in dbBackup.data.settings)
    && !JSON.stringify(dbBackup).includes('sl.refresh-token-do-not-export'));
  await app.setSetting('dropboxRefreshToken', null);

  // --- PKCE verifier/challenge shape. ---
  const verifier = app.generateDropboxVerifier();
  check('the PKCE verifier is within RFC 7636\'s 43-128 char range and its allowed charset',
    verifier.length >= 43 && verifier.length <= 128 && /^[A-Za-z0-9\-._~]+$/.test(verifier),
    `len=${verifier.length}`);
  const challenge1 = await app.sha256Base64Url('a-fixed-test-string');
  const challenge2 = await app.sha256Base64Url('a-fixed-test-string');
  check('sha256Base64Url is deterministic and base64url-shaped (no +/=)',
    challenge1 === challenge2 && /^[A-Za-z0-9_-]+$/.test(challenge1), challenge1);
  const nodeCrypto = await import('node:crypto');
  const expectedDigest = nodeCrypto.webcrypto.subtle
    ? await nodeCrypto.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('a-fixed-test-string'))
    : null;
  if (expectedDigest) {
    const expected = Buffer.from(expectedDigest).toString('base64url');
    check('sha256Base64Url matches an independently-computed SHA-256 digest',
      challenge1 === expected, `${challenge1} vs ${expected}`);
  }

  // --- Connecting: stashes the verifier, navigates to the right authorize URL. ---
  {
    app.sessionStorage.clear();
    await app.startDropboxConnect();
    const stashedVerifier = app.sessionStorage.getItem('splitcraft.dropbox.pkce_verifier');
    check('connecting stashes a PKCE verifier in sessionStorage', !!stashedVerifier);
    const authUrl = new URL(app.location.href);
    check('connecting navigates to dropbox.com/oauth2/authorize',
      authUrl.origin + authUrl.pathname === 'https://www.dropbox.com/oauth2/authorize');
    const p = authUrl.searchParams;
    check('the authorize URL requests offline access, S256 PKCE, and a code response',
      p.get('token_access_type') === 'offline' && p.get('code_challenge_method') === 'S256'
      && p.get('response_type') === 'code' && !!p.get('code_challenge') && !!p.get('client_id'),
      authUrl.search);
  }

  // --- Returning redirect: no code/error present is a silent no-op. ---
  {
    app.location.search = '';
    let threw = false;
    try { await app.handleDropboxRedirect(); } catch (e) { threw = true; }
    check('handleDropboxRedirect() with no code/error param does nothing and never throws',
      !threw && (await app.getSetting('dropboxRefreshToken', null)) === null);
  }

  // --- Returning redirect: an OAuth error is surfaced, not thrown. ---
  {
    app.location.search = '?error=access_denied&error_description=User%20declined';
    await app.handleDropboxRedirect();
    check('an OAuth error redirect is shown in the Dropbox status line, not thrown',
      app.document.getElementById('dropbox-status').textContent.includes('User declined'));
    app.document.getElementById('dropbox-status').textContent = '';
  }

  // --- Returning redirect: a code with no stashed verifier fails cleanly. ---
  {
    app.sessionStorage.clear();
    app.location.search = '?code=some-code';
    await app.handleDropboxRedirect();
    check('a code with no stashed verifier reports the lost-verifier message, not a crash',
      app.document.getElementById('dropbox-status').textContent.includes('verifier'));
    app.document.getElementById('dropbox-status').textContent = '';
  }

  // --- Returning redirect: the happy path exchanges the code and stores a refresh token. ---
  {
    app.sessionStorage.setItem('splitcraft.dropbox.pkce_verifier', 'test-verifier');
    app.location.search = '?code=good-code';
    let sentBody = null;
    app.fetch = async (url, opts) => {
      sentBody = opts.body.toString();
      return { ok: true, json: async () => ({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 14400 }) };
    };
    await app.handleDropboxRedirect();
    check('exchanging the code sends grant_type=authorization_code with the verifier, no client_secret',
      /grant_type=authorization_code/.test(sentBody) && /code_verifier=test-verifier/.test(sentBody)
      && !/client_secret/.test(sentBody), sentBody);
    check('a successful exchange stores the refresh token',
      (await app.getSetting('dropboxRefreshToken', null)) === 'rt-1');
    check('a successful exchange clears the stashed verifier',
      app.sessionStorage.getItem('splitcraft.dropbox.pkce_verifier') === null);
    check('a successful exchange paints the connected status',
      app.document.getElementById('dropbox-status').textContent.includes('Connected'));
    delete app.fetch;
    app.fetch = async () => { throw new Error(REAL_FETCH_ERROR); };
  }

  // --- getDropboxAccessToken(): no refresh token yet -> a clear error, no network call. ---
  {
    // disconnectDropbox() also forgets the in-memory access-token cache the
    // exchange above just populated — getDropboxAccessToken() checks that
    // cache BEFORE the refresh-token setting, so leaving a still-valid
    // cached token in place here would make this test pass for the wrong
    // reason (a cache hit, not the empty-refresh-token guard being tested).
    await app.disconnectDropbox();
    let calls = 0;
    app.fetch = async () => { calls++; throw new Error('should not be called'); };
    let err = null;
    try { await app.getDropboxAccessToken(); } catch (e) { err = e; }
    check('getDropboxAccessToken() with nothing connected throws without calling fetch',
      !!err && /isn.t connected/.test(err.message) && calls === 0, err && err.message);
  }

  // --- getDropboxAccessToken(): refresh failure forgets the token rather than looping. ---
  {
    await app.setSetting('dropboxRefreshToken', 'rt-stale');
    app.fetch = async () => ({ ok: false, json: async () => ({ error: 'invalid_grant' }) });
    let err = null;
    try { await app.getDropboxAccessToken(); } catch (e) { err = e; }
    check('a rejected refresh throws a reconnect message',
      !!err && /reconnected/.test(err.message), err && err.message);
    check('a rejected refresh forgets the stored refresh token',
      (await app.getSetting('dropboxRefreshToken', null)) === null);
  }

  // --- uploadToDropbox(): the CORS-safe query-param shape. ---
  {
    await app.setSetting('dropboxRefreshToken', 'rt-good');
    let tokenCalls = 0, uploadCall = null;
    app.fetch = async (url, opts) => {
      if (url === app.location.href) throw new Error('unexpected url'); // guard against a typo above leaking in
      if (String(url).includes('/oauth2/token')) {
        tokenCalls++;
        return { ok: true, json: async () => ({ access_token: 'at-fresh', expires_in: 14400 }) };
      }
      uploadCall = { url: String(url), opts };
      return { ok: true, status: 200 };
    };
    await app.uploadToDropbox('splitcraft-backup-2026-09-09.json', '{"hello":"world"}');
    check('uploading refreshes an access token exactly once', tokenCalls === 1, `tokenCalls=${tokenCalls}`);
    check('the upload call was made', !!uploadCall);
    const uploadUrl = new URL(uploadCall.url);
    check('upload targets content.dropboxapi.com/2/files/upload',
      uploadUrl.origin + uploadUrl.pathname === 'https://content.dropboxapi.com/2/files/upload');
    check('auth and arg travel as URL params (not headers), with reject_cors_preflight set',
      uploadUrl.searchParams.get('authorization') === 'Bearer at-fresh'
      && uploadUrl.searchParams.get('reject_cors_preflight') === 'true'
      && !(uploadCall.opts.headers), uploadUrl.search);
    const arg = JSON.parse(uploadUrl.searchParams.get('arg'));
    check('the arg path/mode match the intended file',
      arg.path === '/splitcraft-backup-2026-09-09.json' && arg.mode === 'overwrite', JSON.stringify(arg));
    check('the body is the plain backup text, unmodified',
      uploadCall.opts.body === '{"hello":"world"}');

    // A second upload within the same access-token lifetime must reuse it.
    uploadCall = null;
    await app.uploadToDropbox('splitcraft-backup-2026-09-09.json', '{"hello":"again"}');
    check('a second upload reuses the cached access token instead of refreshing again',
      tokenCalls === 1 && !!uploadCall, `tokenCalls=${tokenCalls}`);
  }

  // --- The button: not connected -> clicking it starts the connect flow, no upload. ---
  {
    await app.setSetting('dropboxRefreshToken', null);
    const dropboxClick = listeners.get('backup-dropbox-btn') && listeners.get('backup-dropbox-btn').click;
    check('the Dropbox button is wired', !!dropboxClick);
    let fetchCalled = false;
    app.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    if (dropboxClick) await dropboxClick({});
    check('clicking while disconnected navigates to Dropbox instead of uploading anything',
      new URL(app.location.href).host === 'www.dropbox.com' && !fetchCalled);
  }

  // --- The button: connected -> clicking it uploads and records lastBackupAt. ---
  {
    await app.setSetting('dropboxRefreshToken', 'rt-good');
    await app.setSetting('lastBackupAt', null);
    const dropboxClick = listeners.get('backup-dropbox-btn') && listeners.get('backup-dropbox-btn').click;
    let uploaded = false;
    app.fetch = async (url) => {
      if (String(url).includes('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'at-2', expires_in: 14400 }) };
      uploaded = true;
      return { ok: true, status: 200 };
    };
    if (dropboxClick) await dropboxClick({});
    check('clicking while connected uploads to Dropbox', uploaded);
    check('a completed Dropbox backup records lastBackupAt',
      Number.isFinite(await app.getSetting('lastBackupAt', null)));
  }

  // --- The button: an upload failure surfaces a message and does NOT record lastBackupAt. ---
  {
    await app.setSetting('dropboxRefreshToken', 'rt-good');
    await app.setSetting('lastBackupAt', null);
    app.fetch = async (url) => {
      if (String(url).includes('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'at-3', expires_in: 14400 }) };
      return { ok: false, status: 507, statusText: 'Insufficient Storage', text: async () => 'quota exceeded' };
    };
    const dropboxClick = listeners.get('backup-dropbox-btn').click;
    await dropboxClick({});
    check('a failed Dropbox upload surfaces an error and records no backup timestamp',
      app.document.getElementById('backup-export-status').textContent.includes('Dropbox backup failed')
      && (await app.getSetting('lastBackupAt', null)) === null);
  }

  // --- Disconnect: forgets the token and best-effort revokes it. ---
  {
    await app.setSetting('dropboxRefreshToken', 'rt-good');
    let revokeCalled = false;
    app.fetch = async (url) => {
      if (String(url).includes('/auth/token/revoke')) { revokeCalled = true; return { ok: true }; }
      return { ok: true, json: async () => ({}) };
    };
    const disconnectClick = listeners.get('dropbox-disconnect-btn') && listeners.get('dropbox-disconnect-btn').click;
    check('the disconnect button is wired', !!disconnectClick);
    if (disconnectClick) { await disconnectClick({}); await new Promise(r => setTimeout(r, 10)); }
    check('disconnecting forgets the refresh token',
      (await app.getSetting('dropboxRefreshToken', null)) === null);
    check('disconnecting best-effort revokes the token server-side', revokeCalled);
    check('the button label reverts to "Connect Dropbox…" once disconnected',
      app.document.getElementById('backup-dropbox-btn').textContent === 'Connect Dropbox…');
  }

  app.fetch = async () => { throw new Error(REAL_FETCH_ERROR); };
  app.location.search = ''; app.location.href = 'file:///x';
  app.sessionStorage.clear();
  await app.setSetting('dropboxRefreshToken', null);
}

// ---------------------------------------------------------------------------
// formatBackupAge(): human-scale relative phrasing for the Settings line.
// ---------------------------------------------------------------------------
{
  const DAY = 86400000;
  check('formatBackupAge(null) reads "No backup yet"',
    app.formatBackupAge(null) === 'No backup yet', app.formatBackupAge(null));
  check('formatBackupAge(now) reads "today"',
    app.formatBackupAge(Date.now()) === 'Last backup: today', app.formatBackupAge(Date.now()));
  check('formatBackupAge(1 day ago) is singular',
    app.formatBackupAge(Date.now() - DAY) === 'Last backup: 1 day ago', app.formatBackupAge(Date.now() - DAY));
  check('formatBackupAge(3 days ago) is plural',
    app.formatBackupAge(Date.now() - 3 * DAY) === 'Last backup: 3 days ago', app.formatBackupAge(Date.now() - 3 * DAY));
  check('formatBackupAge(a long-stale value) still reads in plain days',
    app.formatBackupAge(Date.now() - 400 * DAY) === 'Last backup: 400 days ago',
    app.formatBackupAge(Date.now() - 400 * DAY));
}

// ---------------------------------------------------------------------------
// Ramped-set progression.
//
// The bug this guards: anchoring on sets[0] reads a ramp's warm-up as the
// working weight, so the model waits forever for a 60kg set to hit the top of
// the rep range and the suggestion freezes at "stay at 60kg".
// ---------------------------------------------------------------------------
const exercises = await app.getAllRecords('exercises');
const squat = exercises.find(e => e.name === 'Back Squat');

const ymd = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const session = (daysAgo, sets) => ({
  date: ymd(daysAgo), ts: Date.now() - daysAgo * 86400000,
  planId: null, dayIndex: null, dayName: null,
  exercises: [{
    exerciseId: squat.id,
    sets: sets.map(([weight, reps], i) => ({
      ts: Date.now() - daysAgo * 86400000 + i * 180000,
      type: 'standard', entries: [{ weight, reps }]
    }))
  }]
});

// A ramp whose TOP set cleared the top of an 8-12 range.
const ramped = [session(3, [[60, 12], [70, 12], [80, 12]])];
const s1 = await app.suggestForExercise(squat.id, 8, 12, 3, ramped);
check('ramped session anchors on the TOP set, not the first',
  s1.weight > 80, `suggested ${s1.weight}kg (must exceed the 80kg top set)`);
check('ramped session is labelled as such',
  (s1.why || []).includes('top set'), JSON.stringify(s1.why));

// Same ramp, top set short of the range: hold the TOP weight, not the warm-up.
const rampedShort = [session(3, [[60, 12], [70, 12], [80, 9]])];
const s2 = await app.suggestForExercise(squat.id, 8, 12, 3, rampedShort);
check('an unfinished ramp holds the top weight',
  Math.abs(s2.weight - 80) < 0.001, `suggested ${s2.weight}kg (the old code said 60)`);
check('an unfinished ramp asks for one more rep on the top set',
  s2.reps === 10, `asked for ${s2.reps} (top set did 9)`);

// Straight sets must be completely unaffected.
const straightCleared = [session(3, [[100, 12], [100, 12], [100, 12]])];
const s3 = await app.suggestForExercise(squat.id, 8, 12, 3, straightCleared);
check('straight sets that all cleared still progress',
  s3.weight > 100, `suggested ${s3.weight}kg`);
check('straight sets are NOT labelled as ramped',
  !(s3.why || []).includes('top set'), JSON.stringify(s3.why));

// One short set gates a straight-set session, as it always did.
const straightShort = [session(3, [[100, 12], [100, 12], [100, 9]])];
const s4 = await app.suggestForExercise(squat.id, 8, 12, 3, straightShort);
check('one short set still blocks a straight-set progression',
  Math.abs(s4.weight - 100) < 0.001, `suggested ${s4.weight}kg`);

// Assisted work is stored negative, so "heaviest" has to mean LEAST
// assistance: -20 is a harder set than -40 and must win topSetOf().
//
// Note this asserts the anchor, not that the weight moves. At a 20kg
// effective load an intermediate's 2.5% target increment is 0.5kg, which is
// under the 2.5kg barbell step — so progressionPlan() correctly converts that
// into "bank 5 clean sessions first" rather than handing out a jump five times
// too big. One cleared session therefore holds the weight ON PURPOSE. What
// matters here is that it holds at -20 and never at the -40 warm-up.
const assisted = [session(3, [[-40, 12], [-30, 12], [-20, 12]])];
const s5 = await app.suggestForExercise(squat.id, 8, 12, 3, assisted);
check('assisted ramp treats the LEAST assistance as the top set',
  s5.weight >= -20, `suggested ${s5.weight} (the -40 warm-up must never be the anchor)`);
check('assisted weights are phrased as assistance, not as negative load',
  /assist/.test(s5.text) && !/-\d/.test(s5.text), s5.text);

// ---------------------------------------------------------------------------
// Drop sets and myo-rep sets counting toward progression (Task 1).
//
// Both used to be filtered out entirely (`type === 'standard'`), so a session
// logged as three myo sets or a single ramped drop set contributed NOTHING to
// the progression history — suggestForExercise() saw an empty history and
// treated a lift with real, recent work as brand new. The fix judges each
// set by its FIRST entry (workingEntry()): the working weight and reps done
// before the myo clusters or drops that follow.
// ---------------------------------------------------------------------------

// (a) Three myo sets at 60kg, each one's first entry at repRangeMax (12).
// Before the fix this history was empty (myo sets were filtered out
// entirely), so the model had nothing to progress and fell through to the
// starting-weight estimator instead of proposing a jump above 60kg.
const myoWorkout = {
  date: ymd(3), ts: Date.now() - 3 * 86400000,
  planId: null, dayIndex: null, dayName: null,
  exercises: [{
    exerciseId: squat.id,
    sets: [0, 1, 2].map(i => ({
      ts: Date.now() - 3 * 86400000 + i * 180000,
      type: 'myo',
      entries: [{ weight: 60, reps: 12 }, { weight: 60, reps: 5 }, { weight: 60, reps: 4 }]
    }))
  }]
};
const sMyo = await app.suggestForExercise(squat.id, 8, 12, 3, [myoWorkout]);
check('myo sets count toward progression, judged at their first entry',
  sMyo.weight != null && sMyo.weight > 60, `suggested ${sMyo.weight}kg (myo sets at 60kg×12 should progress past 60)`);

// (b) A drop set 80x8 -> 60x6 -> 40x5 as the TOP set of a ramped session
// (a lighter standard set makes the session ramped) must be judged at 80x8,
// not diluted by the drops that follow it.
const dropWorkout = {
  date: ymd(3), ts: Date.now() - 3 * 86400000,
  planId: null, dayIndex: null, dayName: null,
  exercises: [{
    exerciseId: squat.id,
    sets: [
      { ts: Date.now() - 3 * 86400000, type: 'standard', entries: [{ weight: 60, reps: 10 }] },
      { ts: Date.now() - 3 * 86400000 + 180000, type: 'drop',
        entries: [{ weight: 80, reps: 8 }, { weight: 60, reps: 6 }, { weight: 40, reps: 5 }] }
    ]
  }]
};
const sDrop = await app.suggestForExercise(squat.id, 6, 8, 2, [dropWorkout]);
check('a drop set is judged at its working weight (first entry), not the drops',
  sDrop.weight != null && sDrop.weight > 80, `suggested ${sDrop.weight}kg (top set was 80kg×8)`);
check('the drop set is recognised as the top of a ramped session',
  (sDrop.why || []).includes('top set'), JSON.stringify(sDrop.why));

// (c) The History tab's progress-chart exercise picker must count drop/myo
// sets in its per-exercise set count too — before the fix it filtered to
// `type === 'standard'`, so an exercise logged only as drop/myo sets never
// appeared in the picker at all (its count was 0, and a 0-count exercise is
// dropped entirely).
{
  await app.clearWorkoutHistory();
  const catForChart = await app.getAllRecords('exercises');
  const legPress = catForChart.find(e => e.name === 'Leg Press');
  await app.logSet(legPress.id, 'myo', [{ weight: 100, reps: 12 }, { weight: 100, reps: 5 }, { weight: 100, reps: 4 }], null);
  await app.logSet(legPress.id, 'drop', [{ weight: 120, reps: 8 }, { weight: 90, reps: 6 }], null);
  await app.refreshLogAndHistory();
  const pickerHtml = app.document.getElementById('history-exercise').innerHTML;
  check('the progress-chart exercise picker counts drop/myo sets, not just standard ones',
    /Leg Press \(2\)/.test(pickerHtml), pickerHtml);
  await app.clearWorkoutHistory();
}

// ---------------------------------------------------------------------------
// Start-of-week plan prompt.
// ---------------------------------------------------------------------------
const thisWeek = app.startOfWeek(app.todayStr());
check('weekKeyOfTs agrees with startOfWeek for today',
  app.weekKeyOfTs(Date.now()) === thisWeek, `${app.weekKeyOfTs(Date.now())} vs ${thisWeek}`);
check('weeksBetween counts a one-week gap as 1',
  app.weeksBetween(app.startOfWeek(ymd(7)), thisWeek) === 1,
  String(app.weeksBetween(app.startOfWeek(ymd(7)), thisWeek)));
check('weeksBetween counts the same week as 0',
  app.weeksBetween(thisWeek, thisWeek) === 0);

const promptBox = app.document.getElementById('week-plan-prompt');

// A plan generated this week: nothing to ask about.
await app.refreshWeeklyPlanPrompt({ createdAt: Date.now(), goal: 'Hypertrophy', daysPerWeek: 4 });
check('no prompt for a plan generated this week', promptBox.hidden === true);

// A plan from three weeks ago: ask.
const oldPlan = { createdAt: Date.now() - 21 * 86400000, goal: 'Hypertrophy', daysPerWeek: 4, equipment: 'gym' };
await app.refreshWeeklyPlanPrompt(oldPlan);
check('prompt appears for a plan from a previous week', promptBox.hidden === false);

// Dismissal is scoped to THIS week, and must silence only this week.
await app.setSetting('planWeekDismissed', thisWeek);
await app.refreshWeeklyPlanPrompt(oldPlan);
check('"keep current plan" silences the prompt for this week', promptBox.hidden === true);

await app.setSetting('planWeekDismissed', app.startOfWeek(ymd(14)));
await app.refreshWeeklyPlanPrompt(oldPlan);
check('a dismissal from an earlier week does NOT carry over', promptBox.hidden === false);
await app.clearSetting('planWeekDismissed');

// No plan at all — the prompt has nothing to offer regenerating.
await app.refreshWeeklyPlanPrompt(null);
check('no prompt when there is no plan yet', promptBox.hidden === true);

// ---------------------------------------------------------------------------
// Starting weight for a lift with NO history.
//
// Before this existed the weight box was simply blank for anything never
// logged — tolerable when that was a first-run event, much less so now that
// plans regenerate weekly and each new plan introduces unfamiliar movements.
//
// The thing these checks are really defending is DIRECTION. An estimate that
// comes out light costs one easy set; one that comes out heavy costs a failed
// rep on a movement the lifter has never performed, which is where people get
// hurt. Every assertion below that could be written as "roughly right" is
// instead written as "and never above the lift it was derived from".
// ---------------------------------------------------------------------------
{
  const cat = await app.getAllRecords('exercises');
  const byIdCat = Object.fromEntries(cat.map(e => [e.id, e]));
  const find = (n) => cat.find(e => e.name === n);
  const day = (daysAgo, entries) => ({
    date: ymd(daysAgo), ts: Date.now() - daysAgo * 86400000,
    planId: null, dayIndex: null, dayName: null,
    exercises: entries.map(([name, weight, reps]) => ({
      exerciseId: find(name).id,
      sets: [{ ts: Date.now() - daysAgo * 86400000, type: 'standard', entries: [{ weight, reps }] }]
    }))
  });

  // Barbell + cable chest work, machine legs. Nothing at all for delts or core.
  const hist = [
    day(7, [['Barbell Bench Press', 100, 8], ['Cable Fly', 20, 12], ['Leg Press', 150, 10]]),
    day(3, [['Barbell Bench Press', 102.5, 8], ['Cable Fly', 22.5, 12]]),
  ];
  const suggest = (name) => app.suggestForExercise(find(name).id, 8, 12, 3, hist, byIdCat);

  // Tier 1: same muscle, same equipment, compound-to-compound. No scaling.
  const incline = await suggest('Incline Barbell Bench Press');
  check('a new lift gets a starting weight instead of a blank box',
    incline.weight != null, String(incline.weight));
  check('same-muscle/same-equipment estimate lands just under the reference lift',
    incline.weight > 80 && incline.weight < 102.5, `${incline.weight}kg vs a 102.5kg bench`);
  check('the estimate is flagged as an estimate',
    (incline.why || []).includes('estimate'), JSON.stringify(incline.why));
  check('the estimate says where it came from',
    /chest/.test(incline.text) && /adjust/i.test(incline.text), incline.text);

  // Isolation must match isolation, not the compound in the same muscle.
  const pecDeck = await suggest('Pec Deck');
  check('an isolation is estimated from isolation work, not from the big compound',
    pecDeck.weight < 60, `${pecDeck.weight}kg — averaging in the 102.5kg bench would push this high`);
  check('an isolation estimate still clears zero', pecDeck.weight > 0, String(pecDeck.weight));

  // Cross-equipment scaling: dumbbells carry far less than a barbell.
  const dbFly = await suggest('Dumbbell Fly');
  check('a dumbbell movement is scaled well below barbell loads',
    dbFly.weight > 0 && dbFly.weight < 40, `${dbFly.weight}kg`);

  // Loadable numbers only.
  const step = app.loadStepKg(find('Incline Barbell Bench Press'));
  check('the estimate rounds to a weight the equipment can actually make',
    Math.abs(incline.weight / step - Math.round(incline.weight / step)) < 1e-9,
    `${incline.weight} is not a multiple of ${step}`);

  // Bodyweight has a correct answer that isn't a guess.
  const pushup = await suggest('Push-Up');
  check('bodyweight work starts at 0 rather than blank',
    pushup.weight === 0, String(pushup.weight));
  check('bodyweight is not labelled an estimate — it is just correct',
    !(pushup.why || []).includes('estimate'), JSON.stringify(pushup.why));

  // Refusing is a feature. A confident wrong number is worse than an empty box.
  const lateral = await suggest('Lateral Raise');
  check('an untrained muscle with no comparable equipment stays blank',
    lateral.weight === null, String(lateral.weight));
  const cableCrunch = await suggest('Cable Crunch');
  check('core work is not estimated from unrelated chest work',
    cableCrunch.weight === null, String(cableCrunch.weight));

  // Assisted lives on its own (negative) scale and must not be seeded from
  // loaded lifts.
  const assisted = await suggest('Assisted Pull-Up');
  check('assisted work is not estimated from loaded lifts',
    assisted.weight === null, String(assisted.weight));

  const withAssisted = hist.concat([day(2, [['Assisted Dip', -40, 8]])]);
  const aPull = await app.suggestForExercise(find('Assisted Pull-Up').id, 8, 12, 3, withAssisted, byIdCat);
  check('assisted work IS estimated from other assisted work',
    aPull.weight != null && aPull.weight < 0, String(aPull.weight));
  check('a new assisted movement starts with MORE help, not less',
    aPull.weight <= -40, `${aPull.weight} should be at or beyond -40`);

  // And none of this may touch a lift that HAS history.
  const benched = await app.suggestForExercise(find('Barbell Bench Press').id, 8, 12, 3, hist, byIdCat);
  check('an exercise with real history is unaffected by the estimator',
    !(benched.why || []).includes('estimate') && benched.weight >= 102.5,
    `${benched.weight}kg, why=${JSON.stringify(benched.why)}`);
}

// ---------------------------------------------------------------------------
// AI starting weights — the second call after plan generation.
//
// The heuristic reasons from equipment class, because that is the only
// load-scale signal in the data model. A model knows the actual relationships
// between movements, which is knowledge the taxonomy cannot encode. So the AI
// value wins where it exists — but it is untrusted input, and a 500kg lateral
// raise prefilled into a weight box is worse than an empty one. These checks
// are mostly about the guard rails, not the happy path.
// ---------------------------------------------------------------------------
{
  await app.syncDefaultExercises();
  await seedDemoData(app);   // heaviest logged lift here is a 85kg Back Squat
  const all0 = await app.getAllRecords('exercises');
  const nameOf = (n) => all0.find(e => e.name === n);

  // Exercises with no history in the demo data.
  const planDays = [{ name: 'Push', exercises: [
    { name: 'Incline Barbell Bench Press', targetSets: 3, repRangeMin: 6, repRangeMax: 10 },
    { name: 'Pec Deck', targetSets: 3, repRangeMin: 10, repRangeMax: 15 },
    { name: 'Assisted Dip', targetSets: 3, repRangeMin: 6, repRangeMax: 10 },
    { name: 'Face Pull', targetSets: 3, repRangeMin: 10, repRangeMax: 15 },
  ] }];

  let calls = 0; const prompts = [];
  const runPlan = async (estimates) => {
    calls = 0; prompts.length = 0;
    app.fetch = async (url, opts) => {
      calls++; prompts.push(JSON.parse(opts.body).messages[1].content);
      const payload = calls === 1 ? { days: planDays } : { estimates };
      return { ok: true, status: 200, statusText: 'OK', body: null,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
    };
    await app.setSetting('openrouterKey', 'sk-or-test');
    await app.setSetting('openrouterModel', 'test/model');
    return app.generatePlanWithAI({ goal: 'Hypertrophy', daysPerWeek: 4, equipment: '', notes: '',
      repRangeMin: 6, repRangeMax: 10, splitType: 'auto', fixedSets: 3 });
  };

  await runPlan([
    { name: 'Incline Barbell Bench Press', weightKg: 52.5 },   // plausible
    { name: 'Pec Deck', weightKg: 500 },                        // absurd — must be rejected
    { name: 'Assisted Dip', weightKg: -35 },                    // assistance, correct sign
    { name: 'Face Pull', weightKg: -20 },                       // negative on a cable — wrong
  ]);

  check('plan generation makes a SECOND call for starting weights', calls === 2, `${calls} call(s)`);
  check('the estimate prompt carries the lifter’s own logged lifts',
    /Barbell Bench Press.*kg/.test(prompts[1]), 'anchors missing from prompt');
  check('the estimate prompt asks only about lifts with no history',
    /FIRST time/.test(prompts[1]) && !/Back Squat —/.test(prompts[1]));

  const after = await app.getAllRecords('exercises');
  const stored = (n) => (after.find(e => e.name === n) || {}).startingWeightKg;

  check('a plausible estimate is stored', stored('Incline Barbell Bench Press') === 52.5,
    String(stored('Incline Barbell Bench Press')));
  check('an absurd estimate is REJECTED, not clamped',
    stored('Pec Deck') === undefined, `stored ${stored('Pec Deck')} (ceiling is 1.25x an 85kg squat)`);
  check('assisted work keeps its negative sign', stored('Assisted Dip') === -35, String(stored('Assisted Dip')));
  check('a negative weight on a non-assisted lift is rejected',
    stored('Face Pull') === undefined, String(stored('Face Pull')));

  // The stored value must actually reach the Log tab, and be labelled.
  const inclineId = nameOf('Incline Barbell Bench Press').id;
  const s = await app.suggestForExercise(inclineId, 6, 10, 3);
  check('the AI estimate reaches the suggestion', s.weight === 52.5, String(s.weight));
  check('the AI estimate is labelled as one', (s.why || []).includes('AI estimate'), JSON.stringify(s.why));

  // A rejected estimate must fall through to the heuristic, not to a blank box.
  const pecId = nameOf('Pec Deck').id;
  const pec = await app.suggestForExercise(pecId, 10, 15, 3);
  check('a rejected estimate falls back to the built-in estimator',
    pec.weight > 0 && (pec.why || []).includes('estimate'), `${pec.weight} ${JSON.stringify(pec.why)}`);

  // Once the lift has history, the stored estimate must stop being used.
  await app.logSet(inclineId, 'standard', [{ weight: 60, reps: 8 }], null);
  const logged = await app.suggestForExercise(inclineId, 6, 10, 3);
  check('a logged set retires the AI estimate',
    !(logged.why || []).includes('AI estimate'), JSON.stringify(logged.why));

  // A failure in the estimate step must never cost the plan.
  calls = 0;
  app.fetch = async (url, opts) => {
    calls++;
    if (calls === 1) return { ok: true, status: 200, statusText: 'OK', body: null,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ days: planDays }) } }] }) };
    throw new TypeError('network is down');
  };
  let planStillMade = null;
  try { planStillMade = await app.generatePlanWithAI({ goal: 'Hypertrophy', daysPerWeek: 4, equipment: '', notes: '',
    repRangeMin: 6, repRangeMax: 10, splitType: 'auto', fixedSets: 3 }); } catch (e) { /* must not happen */ }
  check('a failed estimate call still returns the plan',
    !!(planStillMade && planStillMade.days && planStillMade.days.length), 'plan was lost');
}

// ---------------------------------------------------------------------------
// Clear workout history — the permanent Backup & restore control
// (`clearWorkoutHistory()`, in 06-catalog-import-backup.js) that deletes
// logged workouts and nothing else.
// ---------------------------------------------------------------------------
await app.syncDefaultExercises();
await seedDemoData(app);
await app.setSetting('restDefault', 137);

const preReset = await app.buildBackup();
check('there is history to clear before testing the clear',
  preReset.counts.workouts > 0 && preReset.counts.exercises > 0);

await app.clearWorkoutHistory();
const afterClear = await app.buildBackup();
check('clear history removes every workout',
  afterClear.counts.workouts === 0 && afterClear.counts.sets === 0,
  `${afterClear.counts.workouts} days / ${afterClear.counts.sets} sets left`);
check('clear history KEEPS the exercise catalog',
  afterClear.counts.exercises === preReset.counts.exercises,
  `${afterClear.counts.exercises} vs ${preReset.counts.exercises}`);
check('clear history KEEPS plans',
  afterClear.counts.plans === preReset.counts.plans);
check('clear history KEEPS settings',
  (await app.getSetting('restDefault', 0)) === 137);
check('the app still renders with an empty history', await (async () => {
  try { await app.refreshLogAndHistory(); await app.refreshPlanTab(); return true; } catch (e) { return false; }
})());

// ---------------------------------------------------------------------------
// Settings cache (02-storage.js) — getSetting()/getSettingSync() read a Map
// loaded once by loadSettings(), instead of hitting storage on every call.
// ---------------------------------------------------------------------------
await app.setSetting('cacheProbeKey', 'cache-value-1');
check('setSetting then getSettingSync returns the value',
  app.getSettingSync('cacheProbeKey', null) === 'cache-value-1');

// A value written straight to the localStorage mirror (bypassing setSetting,
// so nothing has put it in the cache yet) should surface once loadSettings()
// re-reads storage — same "mirror fills a gap the primary store has nothing
// for" rule getSetting() used to apply per call, applied once at load time.
app.localStorage.setItem('ironlog.setting.mirrorOnlyKey', JSON.stringify('mirror-value'));
check('a mirror-only key is invisible before loadSettings() re-reads storage',
  app.getSettingSync('mirrorOnlyKey', 'fallback') === 'fallback');
await app.loadSettings();
check('a value only in the localStorage mirror is visible after loadSettings()',
  app.getSettingSync('mirrorOnlyKey', null) === 'mirror-value');
// The primary-store value set earlier must survive the reload untouched.
check('loadSettings() does not lose a value already in the primary store',
  app.getSettingSync('cacheProbeKey', null) === 'cache-value-1');

await app.setSetting('cacheClearKey', 'still here');
await app.clearSetting('cacheClearKey');
check('clearSetting removes it from the cache',
  app.getSettingSync('cacheClearKey', 'gone') === 'gone');

// ---------------------------------------------------------------------------
// Regressions found by auditing, not by a user report. Each one was silent:
// nothing threw, nothing looked wrong, and the damage only showed up later as
// a suggestion that had quietly stopped advancing or a setting that would not
// stick.
// ---------------------------------------------------------------------------
{
  const cat = await app.getAllRecords('exercises');
  const find = (n) => cat.find(e => e.name === n);

  // --- Editing REPS must not rewrite the WEIGHT. ---
  // The inputs render weight at one decimal; imported weights carry two
  // (54.43kg is real Fitbod data). Saving the row read the box back, so a
  // reps-only edit rounded the stored weight by 0.03kg — close to the 0.05
  // tolerance sameWeight() uses — and silently reset the progression streak.
  check('an unchanged weight box round-trips at full precision',
    app.weightToStore(app.displayWeight(54.43), 54.43) === 54.43,
    String(app.weightToStore(app.displayWeight(54.43), 54.43)));
  check('a deliberately changed weight is still honoured',
    app.weightToStore(60, 54.43) === 60, String(app.weightToStore(60, 54.43)));

  const benchR = find('Barbell Bench Press');
  const wR = await app.logSet(benchR.id, 'standard', [{ weight: 54.43, reps: 8 }], null);
  await app.updateStandardSet(wR.id, benchR.id, 0, app.weightToStore(app.displayWeight(54.43), 54.43), 9);
  const editedSet = (await app.getAllWorkouts()).find(x => x.id === wR.id)
    .exercises.find(e => e.exerciseId === benchR.id).sets[0];
  check('a reps-only edit leaves the stored weight untouched',
    editedSet.entries[0].weight === 54.43 && editedSet.entries[0].reps === 9,
    `${editedSet.entries[0].weight}kg x ${editedSet.entries[0].reps}`);

  // --- Set timestamps must be unique, or nothing can identify a set. ---
  // Date.now() is millisecond-resolution and consecutive logs land inside one
  // millisecond, so sets shared a ts. Set ordering, pace sampling and the RIR
  // prompt all treat ts as identity or order.
  const dl = find('Deadlift');
  let burst;
  for (let i = 0; i < 6; i++) burst = await app.logSet(dl.id, 'standard', [{ weight: 100, reps: 5 }], null);
  const tsList = burst.exercises.flatMap(e => e.sets.map(s => s.ts));
  check('sets logged in the same millisecond still get distinct timestamps',
    new Set(tsList).size === tsList.length, `${new Set(tsList).size} distinct of ${tsList.length}`);
  check('set timestamps are strictly increasing within a workout',
    tsList.every((t, i) => i === 0 || t > tsList[i - 1]));

  // --- An RIR answer must reach the set it was asked about. ---
  const curlR = find('Barbell Curl');
  let wq;
  for (const r of [10, 11, 12]) wq = await app.logSet(curlR.id, 'standard', [{ weight: 20, reps: r }], null);
  const before = (await app.getAllWorkouts()).find(x => x.id === wq.id)
    .exercises.find(e => e.exerciseId === curlR.id).sets;
  const askedAbout = before[2].ts;                 // the prompt is about the 3rd set
  await app.deleteSet(wq.id, curlR.id, 0);         // an EARLIER set is deleted first
  await app.setSetRir(wq.id, curlR.id, 2, 3, askedAbout);
  const nowSets = (await app.getAllWorkouts()).find(x => x.id === wq.id)
    .exercises.find(e => e.exerciseId === curlR.id).sets;
  check('an RIR answer lands on the set it was asked about, not a shifted index',
    nowSets.length === 2 && nowSets[1].rir === 3 && nowSets[0].rir == null,
    nowSets.map(s => `${s.entries[0].reps}rep rir=${s.rir}`).join(', '));

  // --- Undo for deleteSet(). ---
  // restoreSet() is addressed by (date, exerciseId, ts) rather than
  // (workoutId, exerciseId, index), because deleting a day's LAST set deletes
  // the record itself and any index shifts once another set is logged in
  // between — see the comment on restoreSet() in 02-storage.js.
  const row = find('Barbell Row');
  const today = app.todayStr();
  const wUndo = await app.logSet(row.id, 'standard', [{ weight: 50, reps: 8 }], null);
  const setsBeforeDelete = (await app.getAllWorkouts()).find(x => x.id === wUndo.id)
    .exercises.find(e => e.exerciseId === row.id).sets;
  const deletedSet = setsBeforeDelete[setsBeforeDelete.length - 1];
  const returned = await app.deleteSet(wUndo.id, row.id, setsBeforeDelete.length - 1);
  check('deleteSet returns the removed set, ts intact',
    !!returned && returned.ts === deletedSet.ts, JSON.stringify(returned));

  await app.restoreSet(today, row.id, returned);
  const afterRestore = (await app.getAllWorkouts()).find(w => w.date === today)
    .exercises.find(e => e.exerciseId === row.id).sets;
  check('restoreSet puts the set back at the same position (sorted by ts)',
    afterRestore.some(s => s.ts === deletedSet.ts && s.entries[0].weight === 50 && s.entries[0].reps === 8),
    JSON.stringify(afterRestore));

  await app.restoreSet(today, row.id, returned);
  const afterSecondRestore = (await app.getAllWorkouts()).find(w => w.date === today)
    .exercises.find(e => e.exerciseId === row.id).sets;
  check('a second restoreSet with the same set does not duplicate it',
    afterSecondRestore.filter(s => s.ts === deletedSet.ts).length === 1,
    `${afterSecondRestore.filter(s => s.ts === deletedSet.ts).length} copies`);

  // Deleting the day's ONLY set for an exercise removes the exercise entry
  // (and, if nothing else is logged that day, the whole workout record) — so
  // restoring it has to recreate whatever was deleted, not just push into an
  // exEntry that's still there.
  const facePull = find('Face Pull');
  await app.clearWorkoutHistory();
  const soloWorkout = await app.logSet(facePull.id, 'standard', [{ weight: 15, reps: 12 }], null);
  const soloSet = soloWorkout.exercises.find(e => e.exerciseId === facePull.id).sets[0];
  await app.deleteSet(soloWorkout.id, facePull.id, 0);
  check('deleting a day\'s only set removes the workout record entirely',
    (await app.getAllWorkouts()).find(w => w.date === today) === undefined);

  await app.restoreSet(today, facePull.id, soloSet);
  const recreated = (await app.getAllWorkouts()).find(w => w.date === today);
  check('restoreSet recreates a deleted-out-from-under-it workout record',
    !!recreated && recreated.exercises.find(e => e.exerciseId === facePull.id).sets[0].ts === soloSet.ts,
    JSON.stringify(recreated));

  // --- Session auto-start: a forgotten Start button must not erase the day
  // from the pace estimator (see collectPaceSamples/sessionOverheadSamples,
  // 07-settings.js). ---
  await app.clearWorkoutHistory();
  const lateralRaise = find('Lateral Raise');
  const autoStarted = await app.logSet(lateralRaise.id, 'standard', [{ weight: 8, reps: 15 }], null);
  const firstSetTs = autoStarted.exercises.find(e => e.exerciseId === lateralRaise.id).sets[0].ts;
  check('logging a set auto-stamps startedAt and startedAuto',
    autoStarted.startedAt === firstSetTs && autoStarted.startedAuto === true,
    JSON.stringify({ startedAt: autoStarted.startedAt, startedAuto: autoStarted.startedAuto, firstSetTs }));

  await app.startWorkoutSession();
  const afterExplicitStart = (await app.getAllWorkouts()).find(w => w.date === today);
  check('pressing Start after an auto-start keeps the earlier startedAt',
    afterExplicitStart.startedAt === firstSetTs, JSON.stringify(afterExplicitStart.startedAt));

  // sessionOverheadSamples must ignore the auto-started day even once it has
  // a real recorded duration (an auto session's startedAt already sits at its
  // first logged set, so there's no arrival gap left to measure).
  const paceAfterAuto = (await app.sessionPace([afterExplicitStart])).overheadSamples;
  check('sessionOverheadSamples ignores an auto-started session even after a real duration is recorded',
    paceAfterAuto === 0, `${paceAfterAuto} overhead samples`);

  // collectPaceSamples/sessionOverheadSamples on synthetic workouts that
  // differ ONLY in startedAuto, so the split between the two is unambiguous.
  const paceStart = Date.now() - 20 * 86400000;
  const paceSets = (base) => [0, 3, 6, 9].map(m => ({ ts: base + m * 60000, type: 'standard', entries: [{ weight: 40, reps: 10 }] }));
  const autoPaceWorkout = {
    id: 7001, date: '2020-01-01', ts: paceStart, startedAt: paceStart, startedAuto: true,
    endedAt: paceStart + 20 * 60000, durationMs: 20 * 60000,
    exercises: [{ exerciseId: lateralRaise.id, sets: paceSets(paceStart) }],
  };
  const explicitPaceWorkout = {
    ...autoPaceWorkout, id: 7002, date: '2020-01-02', startedAuto: false,
    exercises: [{ exerciseId: lateralRaise.id, sets: paceSets(paceStart + 1000) }],
  };
  check('collectPaceSamples still counts an auto-started session\'s set gaps',
    app.collectPaceSamples([autoPaceWorkout]).setGaps.length === 3,
    `${app.collectPaceSamples([autoPaceWorkout]).setGaps.length} gaps`);
  check('sessionOverheadSamples excludes the auto-started session but keeps the explicitly-started one',
    app.sessionOverheadSamples([autoPaceWorkout]).length === 0 &&
    app.sessionOverheadSamples([explicitPaceWorkout]).length === 1,
    JSON.stringify({ auto: app.sessionOverheadSamples([autoPaceWorkout]).length, explicit: app.sessionOverheadSamples([explicitPaceWorkout]).length }));

  // Deleting the only set of an auto-started, otherwise-untouched day removes
  // the record — the auto start IS the first set, so nothing is left worth
  // keeping once it's gone. An explicitly-started day survives the same
  // deletion (Start Warm-up shouldn't vanish because the one set logged
  // during it was undone).
  await app.clearWorkoutHistory();
  const soloAuto = await app.logSet(lateralRaise.id, 'standard', [{ weight: 8, reps: 15 }], null);
  await app.deleteSet(soloAuto.id, lateralRaise.id, 0);
  check('deleting the only set of an auto-started day removes the workout record entirely',
    (await app.getAllWorkouts()).find(w => w.date === today) === undefined);

  await app.clearWorkoutHistory();
  await app.startWorkoutSession();
  const soloExplicit = await app.logSet(lateralRaise.id, 'standard', [{ weight: 8, reps: 15 }], null);
  await app.deleteSet(soloExplicit.id, lateralRaise.id, 0);
  const survivedExplicit = (await app.getAllWorkouts()).find(w => w.date === today);
  check('deleting the only set of an EXPLICITLY started day keeps the (now empty) workout record',
    !!survivedExplicit && survivedExplicit.startedAt != null && survivedExplicit.startedAuto !== true,
    JSON.stringify(survivedExplicit));

  // --- Undo must bring the session-start stamp back with the set, not just
  // the set. --- Deleting an auto-started day's only set deletes the whole
  // `workouts` record (above); Undo recreates it via restoreSet(), which the
  // app always calls with deleteSet()'s OWN return value (see the
  // 'delete-set' actions in 05-history.js / 09-workout.js) — so the returned
  // value has to be the thing that carries startedAt/startedAuto back out.
  await app.clearWorkoutHistory();
  const soloUndoWorkout = await app.logSet(row.id, 'standard', [{ weight: 45, reps: 10 }], null);
  const soloUndoStartedAt = soloUndoWorkout.startedAt;
  const removedSolo = await app.deleteSet(soloUndoWorkout.id, row.id, 0);
  check('deleting the only set of an auto-started day removes the record (setup for the Undo check)',
    (await app.getAllWorkouts()).find(w => w.date === today) === undefined);
  await app.restoreSet(today, row.id, removedSolo);
  const restoredSoloDay = (await app.getAllWorkouts()).find(w => w.date === today);
  check('Undo restores startedAt/startedAuto along with the set that recreates the record',
    !!restoredSoloDay && restoredSoloDay.startedAt === soloUndoStartedAt && restoredSoloDay.startedAuto === true,
    JSON.stringify(restoredSoloDay));

  // ...but must never STOMP a record's own startedAt if the day was revived
  // some other way (a different exercise logged) before Undo was tapped.
  await app.clearWorkoutHistory();
  const soloUndoWorkout2 = await app.logSet(row.id, 'standard', [{ weight: 45, reps: 10 }], null);
  const removedSolo2 = await app.deleteSet(soloUndoWorkout2.id, row.id, 0);
  await new Promise(r => setTimeout(r, 5));   // force a distinct Date.now() from the deleted record's
  const revivedByOther = await app.logSet(lateralRaise.id, 'standard', [{ weight: 8, reps: 15 }], null);
  const revivedStartedAt = revivedByOther.startedAt;
  check('a fresh record was created for the day before Undo fired (setup)',
    revivedStartedAt !== soloUndoWorkout2.startedAt, `${revivedStartedAt} vs ${soloUndoWorkout2.startedAt}`);
  await app.restoreSet(today, row.id, removedSolo2);
  const afterLateUndo = (await app.getAllWorkouts()).find(w => w.date === today);
  check('Undo onto an already-existing record leaves ITS OWN startedAt untouched',
    afterLateUndo.startedAt === revivedStartedAt, JSON.stringify(afterLateUndo.startedAt));
  const rowEntryAfterLateUndo = afterLateUndo.exercises.find(e => e.exerciseId === row.id);
  check('Undo onto an already-existing record still restores the deleted set itself',
    !!rowEntryAfterLateUndo && rowEntryAfterLateUndo.sets.some(s => s.ts === removedSolo2.ts),
    JSON.stringify(afterLateUndo.exercises));

  // --- A hand-edited exercise must survive the catalog sync. ---
  // The Settings list offers muscle and equipment dropdowns for EVERY row,
  // built-ins included, and syncDefaultExercises() runs on every page load.
  const ohp = find('Overhead Press');
  const edited = await app.getRecord('exercises', ohp.id);
  edited.primaryMuscle = 'side_delts';
  edited.equipment = 'machine';
  edited.userEdited = true;
  await app.putRecord('exercises', edited);
  await app.syncDefaultExercises();
  const survived = await app.getRecord('exercises', ohp.id);
  check('a user-edited built-in exercise survives the catalog sync',
    survived.primaryMuscle === 'side_delts' && survived.equipment === 'machine',
    `${survived.primaryMuscle}/${survived.equipment}`);

  // ...but an UNTOUCHED built-in must still be managed by the catalog.
  const bp2 = find('Barbell Row');
  const stale = await app.getRecord('exercises', bp2.id);
  stale.primaryMuscle = 'abs';
  delete stale.userEdited;
  await app.putRecord('exercises', stale);
  await app.syncDefaultExercises();
  check('an untouched built-in is still corrected by the catalog sync',
    (await app.getRecord('exercises', bp2.id)).primaryMuscle === 'lats',
    (await app.getRecord('exercises', bp2.id)).primaryMuscle);

  // --- A damaged backup must be refused BEFORE the wipe. ---
  // Restore clears every store and then writes, so a file that passes a
  // shallow check and turns out to be malformed leaves the user with their
  // data gone and a render that throws.
  const wrap = (workouts, exercises = [], plans = []) => ({
    format: 'ironlog-backup', version: 1,
    data: { workouts, exercises, plans, exercisePrefs: [], settings: {} }
  });
  const refuses = async (label, obj) => {
    let threw = false;
    try { await app.validateBackup(obj); } catch (e) { threw = true; }
    check(`a damaged backup is refused: ${label}`, threw);
  };
  await refuses('a set with no entries',
    wrap([{ id: 1, date: '2026-01-01', ts: 1, exercises: [{ exerciseId: 1, sets: [{ ts: 1, type: 'standard', entries: [] }] }] }]));
  await refuses('a non-numeric weight',
    wrap([{ id: 1, date: '2026-01-01', ts: 1, exercises: [{ exerciseId: 1, sets: [{ ts: 1, type: 'standard', entries: [{ weight: 'heavy', reps: 5 }] }] }] }]));
  await refuses('a malformed date',
    wrap([{ id: 1, date: 'not-a-date', ts: 1, exercises: [] }]));
  await refuses('an exercise with no id', wrap([], [{ name: 'X' }]));
  await refuses('a plan day with no exercise list', wrap([], [], [{ id: 1, days: [{ name: 'Push' }] }]));
  let realOk = true;
  try { await app.validateBackup(await app.buildBackup()); } catch (e) { realOk = e.message; }
  check('a genuine backup still validates', realOk === true, String(realOk));

  // --- One slot per exercise per day. ---
  // Two rows sharing a data-exid make the Log tab incoherent: both show the
  // same logged sets, one "Log" tap ticks both off, and the Plan tab's Swap
  // edits whichever slot findIndex hits first.
  const dupDay = { days: [{ name: 'Push', exercises: [
    { name: 'Barbell Bench Press', targetSets: 3, repRangeMin: 6, repRangeMax: 10 },
    { name: 'Lateral Raise', targetSets: 3, repRangeMin: 10, repRangeMax: 15 },
    { name: 'Barbell Bench Press', targetSets: 4, repRangeMin: 8, repRangeMax: 12 },
  ] }] };
  app.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', body: null,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(dupDay) } }] }) });
  await app.setSetting('openrouterKey', 'sk-or-test');
  await app.setSetting('openrouterModel', 'test/model');
  const dedupedPlan = await app.generatePlanWithAI({ goal: 'Hypertrophy', daysPerWeek: 4, equipment: '',
    notes: '', repRangeMin: 8, repRangeMax: 12, splitType: 'auto', fixedSets: null });
  const slotIds = dedupedPlan.days[0].exercises.map(e => e.exerciseId);
  check('a repeated exercise within one plan day is deduplicated',
    new Set(slotIds).size === slotIds.length, JSON.stringify(slotIds));
  check('deduplication keeps the first occurrence and the other exercises',
    slotIds.length === 2, `${slotIds.length} slots`);
}

// ---------------------------------------------------------------------------
// History search. Wired with addEventListener, so no suite could reach it
// until the harness started exposing those handlers.
// ---------------------------------------------------------------------------
{
  await app.syncDefaultExercises();
  await seedDemoData(app);
  const listEl = app.document.getElementById('history-list');
  const note = app.document.getElementById('history-filter-note');
  const search = listeners.get('history-search');
  check('the history search box is wired at all', !!(search && search.input));

  if (search && search.input) {
    const type = async (value) => {
      search.input({ target: { value } });
      // The handler debounces by 200ms before re-rendering.
      await new Promise(r => setTimeout(r, 300));
    };

    await type('bench');
    check('searching narrows the session list', !note.hidden && /Showing only "bench"/.test(note.textContent),
      `hidden=${note.hidden} text=${note.textContent}`);
    check('the search summary counts only the matching sets',
      /\d+ sets? across \d+ sessions?/.test(note.textContent), note.textContent);

    await type('zzz-no-such-exercise');
    check('a search matching nothing says so rather than blaming the range',
      /Nothing matching/.test(note.textContent), note.textContent);

    await type('');
    check('clearing the search restores the unfiltered view', note.hidden === true, String(note.hidden));
    check('rendering survived the whole search cycle', listEl.innerHTML !== undefined);
  }
}

// ---------------------------------------------------------------------------
// Sets per muscle over time (Task 2). Reuses the demo data seeded above —
// renderMuscleTrendChart() is called from refreshLogAndHistory() via
// renderHistoryCharts(), exactly like every other History chart.
// ---------------------------------------------------------------------------
{
  await app.refreshLogAndHistory();
  const trendEl = app.document.getElementById('chart-muscle-trend');
  const sel = app.document.getElementById('history-muscle');
  check('the sets-per-muscle-over-time chart renders an SVG after seeding',
    trendEl.innerHTML.includes('<svg'), trendEl.innerHTML.slice(0, 120));
  check('the muscle-to-chart select is populated with options',
    (sel.innerHTML.match(/<option/g) || []).length > 0, sel.innerHTML);

  const muscleChange = listeners.get('history-muscle');
  check('the muscle select is wired to a change handler', !!(muscleChange && muscleChange.change));
  const firstValue = (sel.innerHTML.match(/value="([^"]+)"/) || [])[1];
  if (muscleChange && muscleChange.change && firstValue) {
    await muscleChange.change({ target: { value: firstValue } });
    check('changing the muscle selection re-renders the trend chart',
      app.document.getElementById('chart-muscle-trend').innerHTML.includes('<svg'));
  }
}

// ---------------------------------------------------------------------------
// Warm-up set suggestions (Task 3). warmupSets(workingKg, exercise) is a pure
// function of a weight and an equipment class, so these pass minimal
// {equipment} objects rather than real catalog exercises. Default equipment
// steps (barbell 2.5kg, dumbbell 2kg, cable 5kg) are used throughout, so no
// settings need to be configured first.
// ---------------------------------------------------------------------------
{
  const barbellFull = app.warmupSets(100, { equipment: 'barbell' });
  check('warmupSets(100, barbell) proposes a 50/70/85% ramp',
    JSON.stringify(barbellFull) === JSON.stringify([{ weightKg: 50, reps: 8 }, { weightKg: 70, reps: 5 }, { weightKg: 85, reps: 2 }]),
    JSON.stringify(barbellFull));

  check('warmupSets(25, barbell) is empty — an empty bar already IS the warm-up',
    app.warmupSets(25, { equipment: 'barbell' }).length === 0);

  check('warmupSets(8, dumbbell) is empty — too light relative to the dumbbell step to ramp into',
    app.warmupSets(8, { equipment: 'dumbbell' }).length === 0);

  check('warmupSets skips bodyweight work entirely',
    app.warmupSets(50, { equipment: 'bodyweight' }).length === 0);
  check('warmupSets skips assisted work entirely',
    app.warmupSets(30, { equipment: 'assisted' }).length === 0);

  check('warmupSets(null, ...) and a non-positive weight are both empty',
    app.warmupSets(null, { equipment: 'barbell' }).length === 0
    && app.warmupSets(0, { equipment: 'barbell' }).length === 0
    && app.warmupSets(-5, { equipment: 'barbell' }).length === 0);

  // Candidates that round to the same loadable step must collapse to one
  // entry, not be listed twice. 12kg on a 5kg-step cable machine is BELOW the
  // "too light to bother" gate (4 x 5kg = 20kg) and correctly returns an
  // empty list rather than ever reaching the dedup logic — 25kg is the
  // smallest cable working weight that both clears that gate and lands two
  // of the 70%/85% candidates on the same rounded step (17.5kg and 21.25kg
  // both round to 20kg at a 5kg step), which is what actually exercises it.
  check('a working weight below the "too light" gate is empty, not a duplicate-laden list',
    app.warmupSets(12, { equipment: 'cable' }).length === 0);
  const dedupCase = app.warmupSets(25, { equipment: 'cable' });
  check('candidates that collapse to the same rounded weight are deduplicated',
    dedupCase.length === 2
    && new Set(dedupCase.map(c => c.weightKg)).size === dedupCase.length
    && dedupCase[0].weightKg === 15 && dedupCase[1].weightKg === 20,
    JSON.stringify(dedupCase));
}

// ---------------------------------------------------------------------------
// Session time model:  minutes = fixed + exercises x setup + sets x perSet
//
// The old model was `sets x perSet` alone, which priced an 8-exercise, 24-set
// day at 48 minutes against a real session nearer 90. The error was structural
// rather than a bad constant: with no per-exercise term, any day whose
// exercise count differed from the calibration case was mis-priced, and the
// same number is what the plan generator is told to fit — so it kept asking
// for days that could not be done in the time available.
// ---------------------------------------------------------------------------
{
  const cat = await app.getAllRecords('exercises');
  const id = (n) => cat.find(e => e.name === n).id;

  // --- the shape of the model ---
  const flatPace = { minutesPerSet: 2, minutesPerSetup: 4, fixedMinutes: 5, byExercise: new Map() };
  const three = [
    { exerciseId: id('Barbell Bench Press'), targetSets: 3 },
    { exerciseId: id('Overhead Press'), targetSets: 3 },
    { exerciseId: id('Lateral Raise'), targetSets: 3 },
  ];
  const eight = ['Barbell Bench Press', 'Overhead Press', 'Triceps Pushdown', 'Lateral Raise',
    'Barbell Row', 'Lat Pulldown', 'Barbell Curl', 'Face Pull'].map(n => ({ exerciseId: id(n), targetSets: 3 }));

  const e3 = app.estimateSessionMinutes(three, flatPace);
  const e8 = app.estimateSessionMinutes(eight, flatPace);
  check('the estimate includes fixed overhead and per-exercise setup',
    Math.round(e8.total) === 5 + 8 * 4 + 24 * 2, `${Math.round(e8.total)} vs ${5 + 32 + 48}`);
  check('an 8-exercise day is no longer priced at 48 minutes',
    Math.round(e8.total) > 70, `${Math.round(e8.total)} min`);
  check('per-exercise minutes sum to the day total',
    Math.abs(e8.perExercise.reduce((a, x) => a + x.minutes, 0) + flatPace.fixedMinutes - e8.total) < 1e-9);

  // The structural fix: same set count, different exercise counts, different
  // durations. The old model could not tell these apart at all.
  const nineSetsThreeEx = app.estimateSessionMinutes(three, flatPace);
  const nineSetsNineEx = app.estimateSessionMinutes(
    eight.slice(0, 9).map(x => ({ ...x, targetSets: 1 })), flatPace);
  check('same sets across more exercises costs more time',
    nineSetsNineEx.total > nineSetsThreeEx.total,
    `${Math.round(nineSetsNineEx.total)} vs ${Math.round(nineSetsThreeEx.total)}`);

  // --- the budget inverts the model ---
  await app.setSetting('secondsPerSet', 120);
  await app.setSetting('exerciseSetupSeconds', 240);
  await app.setSetting('sessionMinutes', 45);
  const b45 = await app.sessionSetBudget([]);
  check('a 45-minute target no longer buys 23 working sets',
    b45.sets < 18, `${b45.sets} sets`);
  // Round-tripping: the sets the budget hands out must fit the time it was given.
  const fitted = app.estimateSessionMinutes(
    Array.from({ length: Math.round(b45.sets / 3) }, () => ({ exerciseId: -1, targetSets: 3 })),
    { ...b45, byExercise: new Map() });
  check('the budgeted sets actually fit the target time',
    Math.abs(fitted.total - 45) <= 6, `${Math.round(fitted.total)} min for a 45 min target`);

  await app.setSetting('secondsPerSet', 0);
  await app.setSetting('exerciseSetupSeconds', 0);
  await app.setSetting('sessionMinutes', 0);

  // --- all three terms are MEASURED once there is history ---
  // Six sessions: 3-minute rests inside an exercise, 6-minute changes between
  // them, and 10 minutes of session outside the logged sets.
  const M = 60000;
  const timed = [];
  for (let s = 0; s < 6; s++) {
    const start = Date.now() - (s + 2) * 86400000;
    const sets = [];
    let t = start + 5 * M;                     // 5 min of warm-up before set one
    const exA = { exerciseId: id('Back Squat'), sets: [] };
    const exB = { exerciseId: id('Leg Press'), sets: [] };
    for (let i = 0; i < 3; i++) { exA.sets.push({ ts: t, type: 'standard', entries: [{ weight: 100, reps: 5 }] }); t += 3 * M; }
    t += 3 * M;                                 // 3 + 3 = 6 minute exercise change
    for (let i = 0; i < 3; i++) { exB.sets.push({ ts: t, type: 'standard', entries: [{ weight: 150, reps: 8 }] }); t += 3 * M; }
    const lastTs = t - 3 * M;
    timed.push({
      id: 9000 + s, date: ymd(s + 2), ts: start, startedAt: start,
      endedAt: lastTs + 5 * M, durationMs: (lastTs + 5 * M) - start,
      exercises: [exA, exB]
    });
    void sets;
  }
  const measured = await app.sessionPace(timed);
  check('per-set time is measured from within-exercise rests',
    Math.abs(measured.minutesPerSet - 3) < 0.01 && /set intervals/.test(measured.source),
    `${measured.minutesPerSet} (${measured.source})`);
  check('setup time is measured from gaps BETWEEN exercises, not lumped in with rests',
    Math.abs(measured.minutesPerSetup - 6) < 0.01 && /exercise change/.test(measured.setupSource),
    `${measured.minutesPerSetup} (${measured.setupSource})`);
  check('fixed overhead is measured from time outside the logged sets',
    Math.abs(measured.fixedMinutes - 10) < 0.01 && /timed session/.test(measured.fixedSource),
    `${measured.fixedMinutes} (${measured.fixedSource})`);

  // Fed back its own measurements, the model must land NEAR a real session and
  // on the long side of it.
  //
  // Not exactly on it, and that is intentional. Gaps sit between sets, so n
  // sets give n-1 rests and the walk to the first station is already inside the
  // fixed overhead; charging every set a rest and every exercise a setup
  // over-counts by roughly one rest per exercise. The exact reconstruction
  // would be `fixed + (ex-1)*setup + (sets-ex)*perSet` — and it is not what
  // ships, because the measurement it reconstructs is blind to discarded long
  // waits, to unlogged warm-up sets, and to the tail of the session. Erring
  // long is also the safe direction: an over-long estimate is visible and
  // adjustable, an over-short one quietly prescribes a session that won't fit.
  const rebuilt = app.estimateSessionMinutes(
    [{ exerciseId: id('Back Squat'), targetSets: 3 }, { exerciseId: id('Leg Press'), targetSets: 3 }],
    measured);
  const actual = timed[0].durationMs / 60000;
  check('the model never under-estimates a real logged session',
    rebuilt.total >= actual, `model ${Math.round(rebuilt.total)} vs actual ${Math.round(actual)}`);
  check('...and its margin stays bounded rather than running away',
    rebuilt.total <= actual * 1.6, `model ${Math.round(rebuilt.total)} vs actual ${Math.round(actual)}`);
  // The exact-gap form is what the margin is measured against; if this ever
  // drifts, the comment above has stopped being true.
  const exact = measured.fixedMinutes + 1 * measured.minutesPerSetup + (6 - 2) * measured.minutesPerSet;
  check('the exact-gap arithmetic does reconstruct the session',
    Math.abs(exact - actual) < 0.01, `${exact} vs ${actual}`);
}

// ---------------------------------------------------------------------------
// Where you train — a cold-start prior for the setup term, not a rival to it.
// ---------------------------------------------------------------------------
{
  await app.setSetting('exerciseSetupSeconds', 0);
  const setupFor = async (gym) => {
    await app.setSetting('gymType', gym);
    return (await app.sessionPace([])).minutesPerSetup;
  };
  const commercial = await setupFor('commercial');
  const homeCombo = await setupFor('home_combo');
  const homeDedicated = await setupFor('home_dedicated');

  check('a commercial gym carries the most setup time (queueing)',
    commercial > homeCombo, `${commercial} vs ${homeCombo}`);
  check('a home gym with dedicated stations is the quickest',
    homeDedicated < homeCombo, `${homeDedicated} vs ${homeCombo}`);
  // The nuance that makes this worth a setting at all: "home is faster" is not
  // true when one bar and one bench mean a real changeover every time.
  check('a combo home gym sits nearer a commercial gym than a kitted-out one',
    Math.abs(homeCombo - commercial) < Math.abs(homeCombo - homeDedicated),
    `combo ${homeCombo}, commercial ${commercial}, dedicated ${homeDedicated}`);

  const eightEx = Array.from({ length: 8 }, () => ({ exerciseId: -1, targetSets: 3 }));
  const cPace = { ...(await (async () => { await app.setSetting('gymType', 'commercial'); return app.sessionPace([]); })()) };
  const hPace = { ...(await (async () => { await app.setSetting('gymType', 'home_dedicated'); return app.sessionPace([]); })()) };
  check('the choice moves a day estimate by a meaningful amount',
    app.estimateSessionMinutes(eightEx, cPace).total - app.estimateSessionMinutes(eightEx, hPace).total >= 15,
    `${Math.round(app.estimateSessionMinutes(eightEx, cPace).total)} vs ${Math.round(app.estimateSessionMinutes(eightEx, hPace).total)} min`);

  // An explicit override must still beat the preset...
  await app.setSetting('exerciseSetupSeconds', 600);
  check('a typed override beats the gym-type preset',
    Math.abs((await app.sessionPace([])).minutesPerSetup - 10) < 0.01,
    String((await app.sessionPace([])).minutesPerSetup));
  await app.setSetting('exerciseSetupSeconds', 0);

  // ...and so must real measurements, since they are specific to this lifter.
  const M = 60000;
  const measuredSessions = [];
  for (let s = 0; s < 6; s++) {
    const start = Date.now() - (s + 2) * 86400000;
    let t = start + 5 * M;
    const a = { exerciseId: 1, sets: [] }, b = { exerciseId: 2, sets: [] };
    for (let i = 0; i < 3; i++) { a.sets.push({ ts: t, type: 'standard', entries: [{ weight: 1, reps: 1 }] }); t += 3 * M; }
    t += 4 * M;                                   // 7-minute exercise change
    for (let i = 0; i < 3; i++) { b.sets.push({ ts: t, type: 'standard', entries: [{ weight: 1, reps: 1 }] }); t += 3 * M; }
    measuredSessions.push({ id: 8000 + s, date: ymd(s + 2), ts: start, startedAt: start,
      endedAt: t, durationMs: t - start, exercises: [a, b] });
  }
  await app.setSetting('gymType', 'home_dedicated');   // preset says 2 min
  const withData = await app.sessionPace(measuredSessions);
  check('measured exercise changes beat the gym-type preset',
    Math.abs(withData.minutesPerSetup - 7) < 0.01 && /exercise change/.test(withData.setupSource),
    `${withData.minutesPerSetup} (${withData.setupSource})`);
  await app.setSetting('gymType', 'commercial');
}

// ---------------------------------------------------------------------------
// Settings save on `change` — there are no Save buttons left in the Settings
// tab (07-settings.js). Two representative fields: a plain numeric setting,
// and one whose change also has to re-render something else on the page.
// ---------------------------------------------------------------------------
{
  const restEl = app.document.getElementById('setting-rest');
  restEl.value = '150';
  const restHandler = listeners.get('setting-rest');
  await restHandler.change({ target: restEl });
  check('changing setting-rest via its change listener persists restDefault',
    (await app.getSetting('restDefault', 90)) === 150,
    String(await app.getSetting('restDefault', 90)));

  const unitEl = app.document.getElementById('setting-weight-unit');
  const bwUnitLabel = app.document.getElementById('bodyweight-unit');
  const bwInput = app.document.getElementById('setting-bodyweight');
  const unitHandler = listeners.get('setting-weight-unit');

  unitEl.value = 'lb';
  await unitHandler.change({ target: unitEl });
  check('changing setting-weight-unit persists weightUnit',
    (await app.getSetting('weightUnit', 'kg')) === 'lb',
    await app.getSetting('weightUnit', 'kg'));
  check('changing setting-weight-unit re-renders the bodyweight field',
    bwUnitLabel.textContent === 'lb' && bwInput.placeholder === 'e.g. 175',
    `unit label="${bwUnitLabel.textContent}" placeholder="${bwInput.placeholder}"`);

  // Revert — later checks in this file assume kg.
  unitEl.value = 'kg';
  await unitHandler.change({ target: unitEl });
  await app.setSetting('restDefault', 90);
}

// ---------------------------------------------------------------------------
// The plan-generation disclosure opens itself when there's no plan to show
// instead, and closes once a plan exists — see refreshPlanTab(), 11-plan.js.
// ---------------------------------------------------------------------------
{
  const disclosure = app.document.getElementById('plan-form-disclosure');
  const existingPlans = await app.getAllRecords('plans');

  await app.refreshPlanTab();
  check('the plan-form disclosure is closed once a plan exists',
    disclosure.open === false, String(disclosure.open));

  for (const p of existingPlans) await app.deleteRecord('plans', p.id);
  await app.refreshPlanTab();
  check('the plan-form disclosure opens itself when there is no plan',
    disclosure.open === true, String(disclosure.open));

  // Restore the seeded plan(s) under their original ids so later checks in
  // this file (and other suites, if run against the same in-memory store)
  // see a plan again.
  for (const p of existingPlans) await app.restorePut('plans', p);
  await app.refreshPlanTab();
}

// ---------------------------------------------------------------------------
// The plan form remembers itself.
//
// Goal, equipment and notes describe the lifter, not one request. The form
// used to call reset() after every successful generation, so an injury note
// had to be retyped every time — and anything not retyped was silently
// dropped from the next plan.
// ---------------------------------------------------------------------------
{
  const goalEl = app.document.getElementById('plan-goal');
  const notesEl = app.document.getElementById('plan-notes');
  const equipEl = app.document.getElementById('plan-equipment');
  const repMinEl = app.document.getElementById('plan-rep-min');

  goalEl.value = 'Strength';
  notesEl.value = 'left knee injury, no deep knee flexion';
  equipEl.value = 'home rack, barbell, adjustable bench';
  repMinEl.value = '4';
  // The `change` handlers are what persist — the same on-blur pattern the
  // OpenRouter key uses.
  for (const [id, el] of [['plan-goal', goalEl], ['plan-notes', notesEl],
    ['plan-equipment', equipEl], ['plan-rep-min', repMinEl]]) {
    const h = listeners.get(id);
    if (h && h.change) h.change({ target: el });
  }
  await new Promise(r => setTimeout(r, 20));

  check('plan notes are persisted on edit',
    (await app.getSetting('planNotes', '')) === 'left knee injury, no deep knee flexion',
    await app.getSetting('planNotes', ''));
  check('plan equipment and goal are persisted too',
    (await app.getSetting('planEquipment', '')).includes('home rack')
    && (await app.getSetting('planGoal', '')) === 'Strength');

  // Simulate a reload: blank the form, then reload it from settings.
  goalEl.value = ''; notesEl.value = ''; equipEl.value = ''; repMinEl.value = '';
  await app.loadPlanFormFromSettings();
  check('the form comes back after a reload',
    notesEl.value === 'left knee injury, no deep knee flexion' && repMinEl.value === '4',
    `notes="${notesEl.value}" repMin="${repMinEl.value}"`);

  // The weekly regeneration must send the LIVE note, not last week's snapshot.
  let sentPrompt = null, calls = 0;
  app.fetch = async (url, opts) => {
    calls++;
    sentPrompt = JSON.parse(opts.body).messages[1].content;
    const payload = calls === 1
      ? { days: [{ name: 'A', exercises: [{ name: 'Back Squat', targetSets: 3, repRangeMin: 4, repRangeMax: 6 }] }] }
      : { estimates: [] };
    return { ok: true, status: 200, statusText: 'OK', body: null,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
  };
  await app.setSetting('openrouterKey', 'sk-or-test');
  await app.setSetting('openrouterModel', 'test/model');
  const wk = listeners.get('week-plan-generate');
  // Stand in for a plan generated last week with DIFFERENT, now-stale notes.
  await app.addRecord('plans', { createdAt: Date.now() - 14 * 86400000, goal: 'Hypertrophy',
    daysPerWeek: 4, equipment: 'old gym', notes: 'stale note from a fortnight ago',
    repRangeMin: 8, repRangeMax: 12, fixedSets: null, days: [] });
  if (wk && wk.click) { await wk.click({ target: {} }); await new Promise(r => setTimeout(r, 50)); }
  check('weekly regeneration sends the CURRENT note, not the old plan’s',
    !!sentPrompt && /left knee injury/.test(sentPrompt) && !/stale note/.test(sentPrompt),
    sentPrompt ? sentPrompt.slice(0, 0) + (/left knee/.test(sentPrompt) ? 'has new' : 'missing new')
      + (/stale note/.test(sentPrompt) ? ' + still has stale' : '') : 'no call made');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
