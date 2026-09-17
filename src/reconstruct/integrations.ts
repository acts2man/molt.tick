import type { Evidence } from './types.js';

export type IntegrationKind = 'forms' | 'payments' | 'commerce' | 'booking' | 'media' | 'analytics' | 'email-marketing' | 'platform';
export interface IntegrationFinding {
  kind: IntegrationKind;
  provider: string;
  route: string;
  evidence: string;
  action: string;
}

const PROVIDERS:Array<{test:(u:URL)=>boolean;kind:IntegrationKind;provider:string;action:string}> = [
  {test:u=>/(^|\.)stripe\.com$/.test(u.hostname),kind:'payments',provider:'Stripe',action:'Reconnect checkout or payment links using the merchant owner\'s account and verify a real test transaction.'},
  {test:u=>/(^|\.)paypal\.com$/.test(u.hostname),kind:'payments',provider:'PayPal',action:'Reconnect payment links or checkout using the merchant owner\'s account and verify a real test transaction.'},
  {test:u=>/(^|\.)squareup\.com$|(^|\.)square\.site$/.test(u.hostname),kind:'payments',provider:'Square',action:'Reconnect the merchant-owned Square flow and verify payment, receipt, refund and webhook behavior used by the site.'},
  {test:u=>/(^|\.)shopify\.com$|(^|\.)myshopify\.com$/.test(u.hostname),kind:'commerce',provider:'Shopify',action:'Treat products, cart, orders, inventory, customers, taxes and fulfillment as a separate commerce integration.'},
  {test:u=>/(^|\.)calendly\.com$/.test(u.hostname),kind:'booking',provider:'Calendly',action:'Reconnect the booking experience and test availability, confirmations, cancellations and notifications.'},
  {test:u=>/(^|\.)acuityscheduling\.com$|(^|\.)squarespacescheduling\.com$/.test(u.hostname),kind:'booking',provider:'Acuity Scheduling',action:'Reconnect booking and test schedules, forms, notifications and timezone behavior.'},
  {test:u=>/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname),kind:'media',provider:'YouTube',action:'Re-embed the approved media and verify consent, responsive sizing and playback.'},
  {test:u=>/(^|\.)vimeo\.com$|(^|\.)player\.vimeo\.com$/.test(u.hostname),kind:'media',provider:'Vimeo',action:'Re-embed the approved media and verify responsive playback.'},
  {test:u=>/(^|\.)mailchimp\.com$|(^|\.)list-manage\.com$/.test(u.hostname),kind:'email-marketing',provider:'Mailchimp',action:'Reconnect signup forms or campaign links and test consent and list delivery.'},
  {test:u=>/(^|\.)hubspot\.com$|(^|\.)hsforms\.com$/.test(u.hostname),kind:'forms',provider:'HubSpot',action:'Reconnect the form or CRM embed and verify submissions reach the intended portal.'},
  {test:u=>/(^|\.)google-analytics\.com$|(^|\.)googletagmanager\.com$/.test(u.hostname),kind:'analytics',provider:'Google Analytics / Tag Manager',action:'Reinstall only the analytics tags the owner approves and verify consent and event collection.'},
];

function urlFinding(route:string, raw:string):IntegrationFinding|undefined{
  let url:URL; try{url=new URL(raw);}catch{return;}
  const match=PROVIDERS.find(p=>p.test(url)); if(!match)return;
  return {kind:match.kind,provider:match.provider,route,evidence:url.hostname,action:match.action};
}
function unique(items:IntegrationFinding[]):IntegrationFinding[]{
  const seen=new Set<string>();
  return items.filter(item=>{const key=[item.route,item.kind,item.provider,item.evidence].join('|');if(seen.has(key))return false;seen.add(key);return true;});
}

/** Structured migration inventory. It reports observed dependencies; it does not claim those services have been migrated. */
export function detectIntegrations(evidence:Pick<Evidence,'pages'>):IntegrationFinding[]{
  const out:IntegrationFinding[]=[];
  for(const page of evidence.pages){
    const view=page.views[0]; if(!view)continue;
    if(view.geometry.forms){
      out.push({kind:'forms',provider:'Form backend not identified',route:page.route,evidence:`${view.geometry.forms} form(s) observed`,action:'Choose and test a real submission backend such as Netlify Forms or a secured endpoint plus an email/CRM provider.'});
    }
    for(const raw of [...view.geometry.embeds,...view.geometry.links]){
      const finding=urlFinding(page.route,raw); if(finding)out.push(finding);
    }
    for(const hint of view.geometry.platformHints??[]){
      const lower=hint.toLowerCase();
      if(lower.includes('woocommerce')){
        out.push({kind:'commerce',provider:'WooCommerce',route:page.route,evidence:hint,action:'Migrate or reconnect products, cart, orders, customers, inventory, taxes, shipping, subscriptions and payment gateways that the store actually uses; do not treat the React cart UI as the store database.'});
        continue;
      }
      const formProvider=lower.includes('contact form 7')?'Contact Form 7':lower.includes('gravity')?'Gravity Forms':lower.includes('wpforms')?'WPForms':lower.includes('fluent')?'Fluent Forms':'';
      if(formProvider){
        out.push({kind:'forms',provider:formProvider,route:page.route,evidence:hint,action:'Replace the WordPress form runtime with an approved submission backend, preserve required fields/consent, and verify delivery, spam handling and notifications end to end.'});
        continue;
      }
      let provider='';
      if(lower.includes('elementor'))provider='Elementor';
      else if(lower.includes('wpbakery'))provider='WPBakery';
      else if(lower.includes('divi'))provider='Divi';
      else if(lower.includes('wordpress'))provider='WordPress';
      else if(lower.includes('shopify'))provider='Shopify';
      else if(lower.includes('wix'))provider='Wix';
      else if(lower.includes('squarespace'))provider='Squarespace';
      if(provider)out.push({kind:'platform',provider,route:page.route,evidence:hint,action:'The frontend can be reconstructed, but editing, plugin, database and account features from this platform require an explicit replacement or migration plan.'});
    }
  }
  return unique(out);
}
