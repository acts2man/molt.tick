# Molt: product experience and commercial launch gates

Status: owner development beta. This document is an implementation boundary,
not permission to sell an untested migration service or charge a customer.

## Delivered in the product experience pass

- Public landing page: creative freedom, WordPress/Elementor/WPBakery/Divi/Gutenberg
  rendered-page input, portable React, AI-assisted editing after export.
- /studio: Source -> Scope -> Review/start wizard. One-page default, explicit
  API-usage consent, URL scope validation, mapped saved-folder input.
- /connections: clearly owner-only setup, gpt-6-astra preset, exact key instructions.
- /how-it-works and /guide: URL and file walkthroughs, limits, expected outputs,
  status meanings, input exclusions and backend boundaries.
- /migration-guide: mailbox, transactional email, commerce, CMS/SEO, identity,
  domain cutover and rollback checklist. Checkboxes persist locally, not as a
  claim that an integration was verified.
- /plans: proposed allowances and illustrative calculator, no checkout or prices.
- /usage: actual retained provider usage reports, including reported failures.
- Provider-call records retained before response parsing/code validation; rejected
  generated code is not mistaken for free API usage. Unreported usage is unknown.
- Measured page-complexity planning report; not a binding quote or plugin audit.
- Pure credit accounting domain with integer credits, reserve/settle/release,
  payment/event idempotency, workspace isolation and no overdrafts. This is tested
  logic, NOT a production ledger or Stripe integration.

## Critical correction: execution backend

GitHub Actions is appropriate here for development and evaluation of the Molt
repository. It is not the production job backend for a commercial reconstruction
SaaS. GitHub's Additional Products terms explicitly restrict commercial services
providing Actions, use as part of a serverless application, and unrelated work.

Source checked 2026-09-17:
https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions

The existing dispatcher therefore remains owner-only and requires explicit
`developmentTest: true`. No paid-customer job route or signup is enabled.

Railway is not a requirement. A commercial backend can use Netlify-hosted UI/API
and durable job orchestration with a separately isolated on-demand execution
boundary. Capture, generation, compile, compare and repair should be resumable
stages with durable artifacts and idempotency keys. Netlify background functions
have 15-minute limits; the current whole-agent call cannot be dropped in unchanged.
Headless Chromium, build packaging, memory/time limits, egress controls and
isolation must pass a real deployment test. Do not claim 'all free' before this.

## Customer experience to ship next

Sign up -> select source -> inspect discovered page list -> review assessment
and credit cap -> approve reservation -> reconstruct -> compare -> export/deploy.

Customers should not supply a model key or authorize the engine repository.
The owner supplies service-account model credentials. GitHub becomes an optional
export destination, authorized via a scoped GitHub App to the customer's chosen
repository, not by collecting a broad personal access token. Current owner PAT
setup is not the customer auth design. ChatGPT connector authorization, Netlify
repo deployment authorization and Studio authorization are three separate grants.

## Complexity and credit policy

Planning v1: 10 project-setup credits plus 10/simple, 20/detailed or 40/interactive
credits per page. Up to two correction rounds are represented in the base planning
allowance; each additional round adds 15% of page credits, rounded upward once.
This is a proposed packaging rule, not calibrated unit economics or current billing.

Creator 150 / Studio 500 / Agency 1500 proposed monthly credits. A five-page simple
example uses 60 credits; these correspond to 2/8/25 complete example sites, not
universal conversion limits. Five detailed pages use 110; five interactive pages
use 210. Real mixed sites sum per-page classifications. Do not sell fixed site
counts independent of complexity. Repeated-template discounts require verified
reuse, not a guess based on identical URL prefixes.

Before sale, capture an inventory and compute a server-side quote with page-level
reasons: layout/section depth, assets, unique templates, responsive states,
interactions and source completeness. Separate unsupported integrations into
manual scopes. The quote records a pricing version, model policy, allowed routes,
repair cap, expiration and approval identity. A customer should see one clear
maximum, not a bill that expands because a model kept retrying.

## Metering and the money boundary

Keep three separate measures:
1. Molt customer credits (integer entitlements).
2. Provider usage/cost (including input, cached input, output/reasoning as reported,
   failed/partial/rejected responses, and separate compute/storage).
3. Provider-specific hosting credits, e.g. Netlify (not interchangeable).

Measured standard-rate Astra estimates currently use $10/M input, $1/M cached input,
$50/M output, and the documented >272K long-context uplift. This is versioned and
excludes regional/priority/tool surcharges, taxes and unreported calls. The provider
invoice remains authoritative. Unknown model pricing must stay unknown.
Source: https://developers.openai.com/api/docs/models/gpt-6-astra (2026-09-17).

Use Stripe Billing/Checkout for Molt subscriptions and a transactional database
for the credit ledger; never use browser state or last-write-wins blob overwrites
as a paid balance. The reducer in studio/server/credit-ledger.ts must run inside a
transaction with a locked workspace wallet and unique payment/event/reservation
identifiers. Store a durable audit trail and a unique invoice-to-grant mapping.

Required webhook behavior:
- Verify signatures using the raw request body; secrets are server-only.
- Grant a cycle's credits only after the authoritative paid-invoice event.
- Deduplicate replays and handle out-of-order events, async payment failure,
  refunds, cancellations, upgrades/proration and period changes.
- Reserve the approved cap atomically before dispatch; reject insufficient balance.
- Settle or release a reservation exactly once; callbacks are authenticated.
- Platform failures must not silently burn the customer's full quote. Define a
  visible partial-delivery/cancellation policy; count provider costs internally.
- Stop before consuming an unapproved extension; do not silently auto-top-up.
- Customer portal, invoices, low-credit notices and consented top-ups are separate
  features. Test renewal and failure cases before enabling live Stripe prices.

Subscription prices are intentionally not published yet. Measure multiple genuine
jobs per complexity tier (including repairs, failed runs, support and infra), then
choose prices using an explicit contribution-margin target and worst-case reserve.

## Service migration: no premature hosting cancellation

Website frontend: static-hosting/free-tier eligibility depends on limits, traffic,
build usage and backend needs. Netlify's free credit plan currently provides 300
monthly credits with a hard limit; exceeding free limits can pause sites. Team-wide
usage matters. Do not promise unlimited free client hosting or guaranteed savings.

Mailboxes: inventory provider, inboxes, aliases, forwarding, archived mail and
DNS. Preserve MX, SPF, DKIM and DMARC. Keep the current mailbox host initially or
migrate to a mailbox provider with real send/receive tests before cancellation.
Resend can send transactional mail and receive mail for application processing;
it is not a drop-in human mailbox suite. Use a subdomain for application mail when
needed; do not replace the primary domain's existing MX records blindly.

Forms: Netlify Forms or a secured endpoint plus Resend; validate input, rate limit,
handle spam, verify the sender domain and test actual delivery/error states.
Netlify's email integration also uses an external sending provider.

Commerce: preserve the client's merchant account. React checkout UI is not an
order backend. Plan catalog, prices, inventory, taxes, shipping, webhooks,
subscriptions, refunds and required historical-data migration. Keep card data out
of Molt. Hosted checkout such as Stripe Checkout is an integration choice, not an
automatic WooCommerce migration. Never reroute client proceeds into Molt's account.

Content/identity: choose a CMS, preserve SEO/redirects and move private data only
through authorized provider APIs. Memberships and bookings need a separate plan.

Release gate: full backup, verified new site, mailbox continuity, delivery test,
payment test as applicable, SEO/redirect validation, owner/client approval and
rollback before DNS cutover or hosting cancellation. Domain registration remains
separate from web hosting.

## Remaining acceptance work

- Owner credential setup and a real, fully inspected Ceballos reconstruction.
- Commercial production executor and private multi-tenant artifact storage.
- Customer authentication and tenant isolation, transactional billing persistence,
  Stripe setup/webhook tests, live prices and plan policy approval.
- Automated integration inventory and provider-specific migration implementations.
- Full interaction-state capture/replay, not just screenshot comparison.

No cancelled Railway service, real API key, successful customer payment or completed
client reconstruction is implied by this commit. Railway shutdown requires actual
account access; deleting railway.json would not stop an existing billed service.
