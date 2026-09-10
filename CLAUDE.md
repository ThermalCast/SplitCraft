# SplitCraft

A single-file PWA weight-training tracker. `splitcraft.html` is the shipped
app: vanilla HTML/CSS/JS, no framework, no build step, no runtime
dependencies. It is a **generated file** — see below.

- **Node full path**: `"C:\Program Files\nodejs\node.exe"` (node is not on PATH).
- **Run tests**: `"C:\Program Files\nodejs\node.exe" tests/run.mjs`. This
  builds `splitcraft.html` first, then runs every suite. Expect
  "all suites passed".
- **Build only**: `"C:\Program Files\nodejs\node.exe" tools/build.mjs`
  (add `--check` to verify the built file is current without writing it).
- **Run locally**: `"C:\Program Files\nodejs\node.exe" tools/serve.mjs` —
  serves the project at `http://localhost:3000/`. Service workers refuse to
  register on `file://`, so this is how the PWA (offline support, install
  prompt) gets tested without deploying anywhere.
- **Edit `src/`, never `splitcraft.html` directly.** The app is authored as
  `src/page.html` + `src/js/*.js`, concatenated in filename order by
  `tools/build.mjs` into one classic `<script>` block. Top-level `function`
  declarations must stay top-level (no IIFE wrapping, no `'use strict'`) —
  `tests/harness.mjs` extracts the script with a regex and runs it in a `vm`
  context, and relies on that shape.
- No npm, no bundler, no ES modules anywhere in this project.
- Background: `design-summary.md` (architecture, data model, decision log).
  Test-harness details: `tests/README.md`.
