# Evidence-first reconstruction agent

## One production path

Molt now captures a rendered website into a builder-independent evidence bundle,
authors a shared React workspace, compiles it, measures every captured route at
desktop/tablet/mobile sizes, and makes bounded targeted repairs. The worker's
`runPipeline` is a compatibility adapter around this core. Elementor's old
sections/columns/widget normalizer is not a dependency of the new production path.
Old stage utilities remain for diagnostics; they are not silently substituted.

The model sees native-resolution crops, complete-page overviews, exact visible
copy, typography/layout measurements, localized assets, existing shared source
files, and real compiler/browser failures. Model instructions distinguish
reconstruction from redesign and treat source material as untrusted evidence.

## Run

Install the repository dependencies and trusted render toolchain:

```sh
npm ci
npm --prefix render-toolchain install
npx --no-install playwright-core install chromium
export MOLT_RENDER_DEPS="$PWD/render-toolchain/node_modules"
# Select an actual image-capable API model available to your provider account.
export MOLT_MODEL_PROVIDER=openai
export MOLT_AI_MODEL=YOUR_AVAILABLE_MODEL_ID
export OPENAI_API_KEY=YOUR_SERVER_SIDE_KEY
npm run reconstruct -- --url https://example.com --out ./work
```

Anthropic is also supported: use `MOLT_MODEL_PROVIDER=anthropic`, an explicit
`MOLT_AI_MODEL`, and `ANTHROPIC_API_KEY`. No model subscription, model identity,
API entitlement, or ChatGPT runtime is copied into this repository. These are
provider API adapters; a ChatGPT product name is not assumed to be an API model ID.
The old `MOLT_AI_REBUILD` toggle is no longer required by the new core.

No model calls are made by the tests. Never commit provider keys. Model requests
have time, count, output, image-size, and aggregate payload bounds; rate-limit
retries are bounded and counted. `MOLT_REASONING_EFFORT=high` is an optional
OpenAI setting for a model that supports that value, not a universal setting.

Use explicit page scope for deterministic jobs:

```sh
npm run reconstruct -- --url https://example.com --page / --page /about --out ./work
```

Without explicit pages, discovery follows homepage header/navigation links, not
all sitemap/blog content. Default maximum: 12 pages. Requested explicit pages are
never silently truncated; automatic discovery truncation is reported. Query-
parameter routes and authenticated sources are not currently supported. Old
worker jobs requesting all/posts scope require explicit page URLs instead of
heuristic slug classification. Legacy capture manifests are not accepted as new
evidence; recapture or create a saved-page bundle.

## Saved pages

```text
saved-pages/
  bundle.json
  home.html
  about.html
  images/...
  styles/...
```

`bundle.json`:

```json
{"site":"https://original.example","pages":[{"route":"/","file":"home.html"},{"route":"/about","file":"about.html"}]}
```

```sh
npm run reconstruct -- --bundle ./saved-pages --out ./work
```

Saved pages are rendered through a loopback server with external network access
blocked. Relative assets and embedded image data are supported. Save the assets
alongside the pages or use self-contained captures. Missing assets are reported;
a live URL is not silently fetched to fill gaps. Archives must be extracted by
the operator into a dedicated directory. Bundle routes, real paths, symlinks and
file size/type limits are checked. This is a CLI importer, not a dashboard uploader.

## Review and acceptance

Each run gets a fresh directory with `site/`, source evidence, per-attempt
screenshots/diffs/geometry/build logs, `report.json`, and an offline `review.html`.
The review UI provides page/device selection, labeled original/React views,
pixel differences, actual metrics, unresolved notes, and the attempt history.
Missing generated evidence is never replaced with the original image.

Acceptance checks production compilation, browser failures, exact normalized
visible copy/reading order, heading geometry/typography, page height, broken
images, new overflow, internal route targets, global pixel comparison (95%), and
worst horizontal-band comparison (85%). These are acceptance criteria, not a
universal fidelity guarantee. Pixel scores cannot validate interaction behavior.

The repair state machine retains only non-regressing improvements across the
entire route/device matrix. Repeated patches skip an unnecessary rebuild.
Rejected changes and failed writes are rolled back. The retained source is
compiled again at the end so a rejected candidate cannot remain in `dist`.
Default repair limit: 6; default overall budget: 30 minutes. Budget exhaustion
returns needs-work, not fabricated success. The best measured version remains
available for inspection. Warnings, unresolved integrations, API usage and
failed checks remain explicit.

The worker adapter exports only when visual checks pass and no integration
blockers remain. No dashboard changes, production database migrations or
production deployment are part of this change. Legacy worker count fields are
mapped to observed semantic sections/elements, not fabricated widget matches.

## Security and scope

This is not a hardened multi-tenant sandbox. Production workers must be isolated
from credentials/files belonging to other jobs, with an egress firewall and
resource quotas. Public-URL/DNS checks are defense in depth, not protection
against DNS rebinding by themselves. Source GET/HEAD access and captured browser
requests are filtered; service workers and WebSockets are blocked. Generated
previews are offline. Generated source cannot edit engine/build configuration,
install dependencies, or intentionally insert a raw-page HTML wrapper. AST guards
are conservative contract checks, not a complete JavaScript security proof.

Chromium sandboxing is enabled by default. `MOLT_NO_SANDBOX=1` is only for a
separately isolated, disposable environment such as the secret-free CI fixture.
Do not disable sandboxing merely to make an unisolated production worker run.

Source forms and iframe media remain integration blockers, not fake working
features. Advanced motion, interaction-state capture/replay, authentication,
ecommerce, production job leases/persistence and large-site context splitting
still require dedicated implementation/verification. The premium review UI does
not imply those integrations are complete.

## Tests

The new suite covers bounded repair/rollback, multi-device regression rejection,
provider request shapes and error handling with mocked fetch, source/route/path
contracts, workspace write restrictions, and report escaping. Browser fixtures
capture two real local pages at three sizes. Full CI compiles and renders actual
React, deliberately changes a heading, observes the mismatch, repairs it through
a deterministic model double, and checks all six page/device combinations.

These tests do not call paid models and do not establish quality on arbitrary
client sites. Live provider generation and the deployed worker still need a
separate acceptance run with authorized credentials and deployment access.
