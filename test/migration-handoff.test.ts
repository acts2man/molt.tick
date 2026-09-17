import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrationHandoff, scaffold } from '../src/reconstruct/workspace.js';
import type { Evidence } from '../src/reconstruct/types.js';

function fixtureEvidence():Evidence{
  return {
    site:'https://example.com',directory:'/tmp/evidence',assets:[],fontFaces:[],warnings:['One source image was unavailable'],blockers:['Membership login needs an approved replacement'],integrations:[
      {kind:'payments',provider:'Stripe',route:'/checkout',evidence:'checkout.stripe.com',action:'Reconnect checkout using the merchant owner account and verify a real test transaction.'},
      {kind:'forms',provider:'Form backend not identified',route:'/contact',evidence:'1 form(s) observed',action:'Choose and test a real form delivery backend.'},
    ],
    pages:[{route:'/',url:'https://example.com/',title:'Example',views:[{viewport:{name:'desktop',width:1440,height:900},screenshot:'/tmp/source.png',interactions:[],geometry:{text:'Example',title:'Example',height:900,overflow:false,brokenImages:0,elements:[],links:[],embeds:[],forms:0,fontFaces:[],mediaQueries:[],platformHints:['WordPress'],truncated:false}}]}],
  };
}

test('migration handoff keeps frontend completion separate from business-service cutover',()=>{
  const text=migrationHandoff(fixtureEvidence());
  assert.match(text,/Human email inboxes/);
  assert.match(text,/Stripe/);
  assert.match(text,/Form backend not identified/);
  assert.match(text,/Membership login needs an approved replacement/);
  assert.match(text,/Do not cancel the previous hosting\/platform account/);
  assert.doesNotMatch(text,/fully migrated|safe to cancel now/i);
});

test('scaffold ships machine-readable and human-readable migration inventories',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'molt-handoff-'));
  try{
    await scaffold(dir,fixtureEvidence());
    const output=JSON.parse(await readFile(join(dir,'MOLT_OUTPUT.json'),'utf8'));
    assert.equal(output.integrations.length,2);
    assert.match(await readFile(join(dir,'MOLT_MIGRATION_PLAN.md'),'utf8'),/SEO and redirects/);
    assert.match(await readFile(join(dir,'README.md'),'utf8'),/MOLT_MIGRATION_PLAN\.md/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
