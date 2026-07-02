/**
 * Molt Stage 3 — Component library registry.
 *
 * Every entry maps a plugin widget type (the things generic converters die on)
 * to a React implementation PROVEN in the Soul2Souls reference migration —
 * merged, verified, and running in production. The planner matches against
 * this registry; anything unmatched becomes a flag, never a silent drop.
 */

export interface LibraryEntry {
  component: string;
  confidence: 'exact' | 'probable';
  /** where the proven implementation came from / what it does */
  provenance: string;
  /** follow-up work the synthesizer must schedule when this matches */
  followUp?: string;
}

export const LIBRARY: Record<string, LibraryEntry> = {
  'sr-offcanvas': {
    component: 'OffcanvasPanels',
    confidence: 'exact',
    provenance:
      'S2S PR #13–#15: Subscribe + Menu slide-in panels with the Sonaar 3D page-push ' +
      '(rotateY(30deg) translateZ(-1344px), origin 35%, 500ms, desktop-only), state lifted ' +
      'to OffcanvasContext at the router root, PagePusher/OffcanvasLayer as siblings so ' +
      'fixed UI never tilts.',
    followUp: 'read the exact live transform from the computed sidecar per site — never hardcode',
  },
  'sr-e-menu': {
    component: 'HeaderNav',
    confidence: 'exact',
    provenance:
      'S2S header: route-aware nav (overlay-dark on home, in-flow light two-row on interior ' +
      'pages), rendered from the WP menu list, active-state underline, burger toggle → offcanvas.',
  },
  'music-player': {
    component: 'PersistentAudioPlayer',
    confidence: 'exact',
    provenance:
      'S2S PR #9–#12: wavesurfer.js bar mounted ONCE at the router __root so playback ' +
      'survives navigation; slide-up reveal; feeds from a typed episode manifest.',
    followUp: 'collect episode media URLs during crawl (audio src / plugin config JSON)',
  },
  'social-icons': {
    component: 'SocialIconRow',
    confidence: 'exact',
    provenance: 'S2S Follow Us rail: FontAwesome brand icons, brand-color hover, exact spacing re-derived.',
  },
  'icon-box': {
    component: 'IconBox',
    confidence: 'exact',
    provenance: 'S2S homepage feature boxes: icon + heading + text, exact Elementor spacing.',
  },
  // behavior-level entries (matched by page signals, not widget type)
  'woocommerce-shop': {
    component: 'SupabaseShop',
    confidence: 'exact',
    provenance:
      'S2S PR #24–#26: catalog / product detail (de-nested route) / cart (localStorage ' +
      'context) / checkout writing orders with status pending_payment on a generated ' +
      'Supabase schema (products · orders · order_items + RLS). No payment processor.',
    followUp: 'payment stays unwired — always raise the payment flag',
  },
  'wpcf7-form': {
    component: 'ContactFormMailto',
    confidence: 'exact',
    provenance:
      'S2S PR #22: CF7 rebuilt with client-side validation + prefilled mailto: handoff; ' +
      'clean TODO(backend) seam for Resend / Supabase edge function. Never fakes a send.',
    followUp: 'always raise the no-backend flag for a human call',
  },
  'mailchimp-form': {
    component: 'MailingListForm',
    confidence: 'exact',
    provenance: 'S2S footer: Mailchimp list signup rebuilt with validation + TODO(backend) seam.',
    followUp: 'always raise the no-backend flag for a human call',
  },
  'gallery-lightbox': {
    component: 'GalleryWithLightbox',
    confidence: 'exact',
    provenance:
      'S2S PR #21: grid from an ordered typed manifest (DOM order is the authority), custom ' +
      'lightbox portaled to document.body to escape will-change:transform containing blocks; ' +
      'wrap-around nav, Escape/backdrop close, scroll lock.',
  },
};

export function matchLibrary(widgetType: string): LibraryEntry | undefined {
  return LIBRARY[widgetType];
}
