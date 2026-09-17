# Molt Studio on Netlify

This repository contains both the browser application (`studio/`) and the reconstruction engine (`src/reconstruct/`). The separate `acts2man/molt` repository is not needed for this deployment.

## Deployment contract

The root `netlify.toml` sets the build base to `studio`, the build command to `npm run build`, and the publish directory to `dist` relative to that base. It also packages the private API in `studio/netlify/functions`, adds application-route rewrites, and sets browser security headers. Do not publish the engine source directory as a static website.

The browser app is React + Vite + TypeScript. It does not require TanStack Start, a Next.js plugin, or Railway. Netlify serves the app and short API requests. A fresh GitHub Actions runner executes each longer reconstruction. Screenshots, upload bundles, and job records are stored in Netlify Blobs; build artifacts are retained in GitHub Actions for seven days. Hosting, storage, runner, and provider usage limits still apply.

The `reconstruct-site.yml` workflow must exist on the repository's default branch before the app can dispatch it. The current deployment contract runs the workflow from `main`, with callbacks to `https://moltick.netlify.app`.

## Secure setup

Set `MOLT_SESSION_SECRET` to a cryptographically random value of at least 40 characters as a secret Netlify Functions environment variable. It encrypts authenticated sessions and must never be committed. Changing it signs out existing sessions. Deployment previews use a separate data store from production.

Open the app and use **Connect GitHub**. Create a fine-grained token scoped only to `acts2man/molt.tick`, with Actions read/write, Secrets read/write, and Contents read access. The server validates the `acts2man` account and repository access. The token is held in an encrypted, authenticated HttpOnly/Secure/SameSite cookie, not local storage. Sessions last eight hours. Do not paste a token or model key into chat or commit it to source.

In **Connections**, choose OpenAI or Anthropic, enter an exact image-capable API model ID available to your account, and supply its API key. The server checks access before encrypting the value into GitHub Actions Secrets. The browser is never sent the stored credential back. Chat subscriptions do not supply the runner's API credentials. A successful model metadata lookup is not a claim that image generation/reconstruction was tested.

## Actual operations

- Submit a public URL, optionally selecting same-site page URLs and page/repair budgets.
- Upload a saved-page folder. The app provides editable route mappings and creates the page manifest. Upload limits are 4 MB per file, 50 MB total, and 300 files; reconstruction supports up to twelve selected pages in this interface.
- Read actual recorded progress and GitHub Actions activity.
- Request cancellation of an active workflow.
- Review original/candidate/difference images by route and viewport when a reconstruction report exists.
- Open retained React-source artifacts. Unresolved integrations and visual differences remain visible.

The public repository and downloadable Actions artifacts are for public website material. Do not upload confidential content into this workspace. Production multi-tenant use would require separate authorization, stronger job leasing, storage lifecycle policies, and more isolation review.

## Verification boundaries

`npm --prefix studio run build` typechecks and builds the interface. `npm --prefix studio test` covers API behavior with isolated stores and mocked external services. `scripts/studio-browser-test.ts` inspects the actual built UI at desktop, tablet, and mobile sizes with a mocked signed-out session. It does not bypass production authentication or create production users/jobs.

The engine's separate browser tests use deterministic model replies. They establish build/capture/compare/repair integration, not arbitrary website fidelity. A live paid-model reconstruction still requires an authorized configured API key, a real source, and inspection of the output.

A green deployment means the app was deployed. A green test means those checks passed. Neither should be presented as a completed client website reconstruction.
