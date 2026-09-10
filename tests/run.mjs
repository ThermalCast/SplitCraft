// Runs every suite in one go:  node tests/run.mjs
// Set APP=path/to/variant.html to check a modified copy of the app.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Rebuild splitcraft.html from src/ first, so the suite can never test a
// stale artifact. Skipped when APP is set — that flag is for testing a
// variant file, not the generated one.
if (!process.env.APP) {
  const build = spawnSync(process.execPath,
    [fileURLToPath(new URL('../tools/build.mjs', import.meta.url))],
    { stdio: 'inherit', env: process.env });
  if (build.status !== 0) {
    console.error('\nbuild failed — aborting test run');
    process.exit(1);
  }
}

const suites = ['test.mjs', 'gen.mjs', 'ui.mjs', 'timing.mjs', 'features.mjs', 'docs.mjs'];
let bad = 0;
for (const s of suites) {
  console.log(`\n=== ${s} ===`);
  // fileURLToPath, not URL.pathname: on Windows the latter yields
  // "/C:/..." and any hand-rolled strip of that leading slash breaks on
  // spaces and drive letters.
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(s, import.meta.url))],
    { stdio: 'inherit', env: process.env });
  if (r.status !== 0) bad++;
}
console.log(bad ? `\n${bad} suite(s) failed` : '\nall suites passed');
process.exitCode = bad ? 1 : 0;
