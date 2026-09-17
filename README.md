# Molt Studio - a new creative foundation

Public landing: https://moltick.netlify.app
Owner development studio: https://moltick.netlify.app/studio

This repository now contains the public product experience, guided owner beta,
and reconstruction engine. Customer subscriptions are **not** enabled. The
GitHub Actions runner is for developing and evaluating this software, not the
production backend of a commercial SaaS.

Read `docs/product/COMMERCIAL-LAUNCH.md` for credit metering, the production
executor boundary, customer onboarding, service migration, and launch gates.
`docs/product/PROVIDER-SOURCES.md` records dated provider references.

# Molt Studio

A browser workspace and evidence-first engine for recreating websites as editable React.

**Capture -> reconstruct -> compile -> compare -> refine -> review**

## One repository

- `studio/`: React + Vite interface, secure Netlify API, connection settings, saved-page uploads, job controls, activity, and visual review.
- `src/reconstruct/`: source capture, geometry, local assets, model adapters, production compilation, multi-viewport comparison, and bounded repair.
- `.github/workflows/reconstruct-site.yml`: on-demand reconstruction runner.
- `netlify.toml`: deployment configuration for the existing Netlify site.

Netlify hosts the Studio, short API requests, and job storage. GitHub Actions runs the longer reconstruction jobs. Railway is not required. The separate `acts2man/molt` repository is not part of this Studio deployment.

Deployment and secure setup: [docs/STUDIO.md](docs/STUDIO.md).
Engine configuration and limitations: [docs/RECONSTRUCTION.md](docs/RECONSTRUCTION.md).

## Use the Studio

Connect the `acts2man` GitHub account inside the app using a repository-scoped fine-grained token. In Connections, configure an image-capable API model and its key. These are real server-backed controls; a model credential is not supplied by a chat subscription.

Start a reconstruction from a public website URL or a folder of saved HTML pages and assets. Select page and refinement limits. Inspect actual job events, source/output screenshots, differences, and the retained React source. Unresolved integrations and unsuccessful comparisons are reported rather than presented as finished work.

This public repository's Actions artifacts are intended for public website material, not confidential uploads. Hosting, storage, Actions, and provider usage may apply.

## Develop

```sh
npm --prefix studio install
npm --prefix studio run dev
npm --prefix studio run build
npm --prefix studio test
```

The Netlify development plugin supplies platform integration when running locally with the required project configuration. Never commit credentials.

Engine CLI:

```sh
npm ci
npm run reconstruct -- --url https://example.com --out ./work
npm run reconstruct -- --bundle ./saved-pages --out ./work
npm run typecheck
npm test
```

Install the trusted rendering toolchain, Chromium, and server-side model configuration as described in the engine documentation before a real reconstruction.

## Verification and limits

Studio CI builds the real application, tests the API with isolated stores and mocked external services, and checks desktop/tablet/mobile UI routes and dialogs. Published checks inspect Netlify's real public routes and unauthenticated API boundaries.

Engine browser tests capture local pages and compile/compare/repair actual React using deterministic model responses. These tests do not establish live model quality on arbitrary client websites.

The app does not migrate WordPress databases, payments, authentication, or form backends. Complex interaction-state capture, large-site handling, and further production isolation/queue hardening remain dedicated work. A deployed app or passing test is not a guarantee of an exact client reconstruction.
