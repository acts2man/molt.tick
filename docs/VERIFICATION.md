# Reconstruction acceptance contract

This change is confined to `acts2man/molt.tick`, the engine. It does not modify
`acts2man/molt`, the Lovable editor, production data, or database schema.

## What changed

The pipeline now calls the existing generated-site renderer instead of using
source screenshots as output previews. The acceptance gate requires every
requested route to have one real render and a finite measured score at or above
`MOLT_MIN_PIXEL_MATCH` (default 95). Null scores, missing/capped renders,
structural failures, duplicate results, and partial generation block acceptance.
A zero score is retained as a real measurement, not treated as missing.

The structural verifier understands the actual `src/pages` AI scaffold. It
checks route coverage, route filename collisions, literal internal links,
relative imports, failed-page placeholders, and raw HTML injection. These are
static checks, not a substitute for compilation or browser interaction tests.

A production build must also succeed. The build subprocess has a time limit,
retains a bounded diagnostic log, and does not inherit worker/API secret
environment variables. This is NOT an OS sandbox: generated builds and browser
sessions must run in isolated workers without access to production secrets.
The older render harness itself still needs a separate isolation/security pass.

Output screenshots and source screenshots are kept separate. The existing
worker-facing `screenshot_path` now points only to generated output. Local
source evidence remains at `source_screenshot_path`. No database column was
added; existing workers ignore that optional local-only field.

Each run receives a fresh `site-*` output directory under its work directory.
The returned `outDir` is authoritative. Stale output from an earlier run cannot
be mistaken for a new successful build. On failure, the pipeline retains page
results, flags, the failure stage, and available evidence rather than wiping them.

## Configuration / behavior change

The production pipeline requires `MOLT_AI_REBUILD=1` and a server-side
`ANTHROPIC_API_KEY`. It no longer silently falls back to a WordPress HTML
snapshot. Configure these on the engine worker, never in a frontend or commit.
Existing standalone snapshot code is retained for diagnostics, not accepted as
an independent React reconstruction.

`MOLT_MIN_PIXEL_MATCH` must be greater than 0 and at most 100. Invalid values
fail configuration. This threshold is a configurable desktop pixel-comparison
criterion, not an accuracy guarantee or a percentage of completed functionality.

Existing `MOLT_RENDER_MAX`, render concurrency, and time-budget limits still
apply. Unrendered pages block acceptance rather than silently passing. Increase
worker resources/budgets or use a smaller explicit page set for large jobs.

`MOLT_VERIFICATION.json` records checks and source/output paths.
`MOLT_BUILD.log` records production compilation results. `MOLT_SHIP_REPO`
requests automatic export only after all checks pass AND no unresolved plan
flags remain. A recorded successful export returns `shipped` with the actual
repository URL. A failed export returns `error`; no success is invented.
Acknowledging a flag in an external UI is not yet a resume/export API.

## Validation

Run `npm ci`, `npm run typecheck`, and `npm test` in an environment with registry
access. The workflow runs those dependency-resolved checks without API keys.

The added 27 tests cover acceptance/structure with local file fixtures and
production-build process handling using real local npm subprocesses. They do
NOT call an AI provider, browse a client website, or exercise the production
worker/database. Local offline execution used TypeScript transpilation and
Node's test runner; it was not a full repository dependency-resolved typecheck.

## Still required before claiming high-fidelity reconstruction

- Multi-viewport source capture, geometry, and observed interaction states.
- Image tiling/provider payload limits and bounded model request handling.
- A render -> diagnose -> targeted repair loop; generation remains one-shot.
- A safe importer for saved HTML/SingleFile page bundles and localized assets.
- Runtime/interaction assertions and a multi-site visual regression suite.
- Source capture fidelity fixes (including existing forced-transform handling).
- Worker claim/retry, upload, and persistence hardening; no worker/schema
  changes are included here.
- Live end-to-end validation with authorized model credentials and deployment
  resources. Passing the local tests does not establish website parity.
