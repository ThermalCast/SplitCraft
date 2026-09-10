// Concatenates src/page.html + src/js/*.js (sorted by filename) into
// splitcraft.html. Dependency-free (Node builtins only). See CLAUDE.md.
//
// Usage:
//   node tools/build.mjs           build splitcraft.html
//   node tools/build.mjs --check   build in memory and diff against the
//                                  checked-in file; exit 1 if they differ
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '<!-- @@SCRIPT@@ -->';

const page = readFileSync(join(ROOT, 'src', 'page.html'), 'utf8');
if (!page.includes(MARKER)) {
  console.error(`src/page.html is missing the ${MARKER} marker`);
  process.exit(1);
}

const jsDir = join(ROOT, 'src', 'js');
const jsFiles = readdirSync(jsDir).filter(f => f.endsWith('.js')).sort();
if (jsFiles.length === 0) {
  console.error('src/js contains no .js files');
  process.exit(1);
}

const joined = jsFiles
  .map(f => readFileSync(join(jsDir, f), 'utf8'))
  .join('\n');

const output = page.replace(MARKER, `<script>\n${joined}\n</script>`);
const outPath = join(ROOT, 'splitcraft.html');

if (process.argv.includes('--check')) {
  const current = readFileSync(outPath, 'utf8');
  if (current !== output) {
    console.error('splitcraft.html is stale — run `node tools/build.mjs` to regenerate it.');
    process.exit(1);
  }
  console.log('splitcraft.html is up to date.');
} else {
  writeFileSync(outPath, output, 'utf8');
  console.log(`Wrote ${outPath} (${output.length} bytes) from ${jsFiles.length} source file(s).`);
}
