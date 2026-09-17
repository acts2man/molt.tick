import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectIntegrations } from '../src/reconstruct/integrations.js';
import type { Evidence } from '../src/reconstruct/types.js';

function evidence():Evidence {
  return {
    site:'https://example.com',directory:'/tmp/evidence',assets:[],fontFaces:[],warnings:[],blockers:[],integrations:[],
    pages:[{route:'/',url:'https://example.com/',title:'Example',views:[{
      viewport:{name:'desktop',width:1440,height:900},screenshot:'/tmp/source.png',interactions:[],
      geometry:{
        text:'Example',title:'Example',height:1200,overflow:false,brokenImages:0,elements:[],
        links:['https://checkout.stripe.com/c/pay/demo','https://calendly.com/example/demo'],
        embeds:['https://www.youtube.com/embed/demo'],forms:1,fontFaces:[],mediaQueries:[],platformHints:['WordPress','Elementor'],truncated:false,
      },
    }]}],
  };
}

test('migration inventory identifies observed services without claiming completion',()=>{
  const items=detectIntegrations(evidence());
  assert.ok(items.some(i=>i.kind==='forms'&&i.provider==='Form backend not identified'));
  assert.ok(items.some(i=>i.kind==='payments'&&i.provider==='Stripe'));
  assert.ok(items.some(i=>i.kind==='booking'&&i.provider==='Calendly'));
  assert.ok(items.some(i=>i.kind==='media'&&i.provider==='YouTube'));
  assert.ok(items.some(i=>i.kind==='platform'&&i.provider==='WordPress'));
  assert.ok(items.some(i=>i.kind==='platform'&&i.provider==='Elementor'));
  assert.ok(items.every(i=>i.route==='/'));
  assert.ok(items.every(i=>/Reconnect|Choose|Treat|frontend/i.test(i.action)));
});

test('migration inventory deduplicates repeated service links',()=>{
  const e=evidence();
  e.pages[0].views[0].geometry.links.push('https://checkout.stripe.com/c/pay/demo');
  const items=detectIntegrations(e).filter(i=>i.provider==='Stripe');
  assert.equal(items.length,1);
});
