# Molt - evidence-first React reconstruction

Recreate the visitor experience of a website as editable React source, using
browser evidence and a measured correction loop rather than page-builder HTML
passthrough.

**Capture -> reconstruct -> compile -> compare -> repair -> review**

The primary engine lives in `src/reconstruct`. It accepts a live URL with optional
explicit page routes, or a local bundle of saved HTML pages and assets. Each page
is captured at desktop, tablet and mobile widths. The model receives screenshots,
geometry, exact visible text and local asset references, and authors a shared
React/Vite workspace. The engine measures the output, asks for targeted repairs,
rejects regressions and retains the best measured result.

```sh
npm run reconstruct -- --url https://example.com --out ./work
npm run reconstruct -- --bundle ./saved-pages --out ./work
```

Setup, API-provider configuration, saved-page format, budgets and limitations are
in [docs/RECONSTRUCTION.md](docs/RECONSTRUCTION.md).

Each run produces React source, real source/output screenshots, difference maps,
compiler/browser diagnostics, a machine-readable report and an offline review
screen. The report never substitutes source imagery for missing output.

`src/pipeline/run.ts` adapts this engine to the existing worker API. Legacy crawl,
normalize and synthesis utilities remain as diagnostic tools, not the primary
reconstruction path. The historical verification milestone is documented in
`docs/VERIFICATION.md`; the new reconstruction documentation supersedes its
pipeline configuration and remaining-work list.

## Verification

```sh
npm run typecheck
npm test
```

CI also installs the trusted render toolchain and Chromium to run real browser
fixtures and a complete capture/React-build/compare/repair test with a deterministic
model double. Provider request tests use mocked responses; no paid model keys are
required for CI. Test success does not establish fidelity on arbitrary websites.

## Scope

This repository contains the reconstruction engine and generated review UI, not
the separate hosted dashboard. It does not migrate WordPress databases, payments,
authentication, or form backends. Unresolved source/media integrations remain
explicit. Production requires isolated browser/build workers, egress controls,
server-side model credentials, and a live end-to-end acceptance run.

No universal pixel-perfect guarantee or automatic production deployment is implied.
