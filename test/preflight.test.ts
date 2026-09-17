import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preflightCreditCap } from '../src/reconstruct/preflight.js';

test('preflight reserve mirrors the planning refinement model without charging anything',()=>{
  assert.deepEqual(preflightCreditCap(60,2),{refinementCredits:0,suggestedReserveCredits:60});
  assert.deepEqual(preflightCreditCap(60,4),{refinementCredits:15,suggestedReserveCredits:75});
  assert.deepEqual(preflightCreditCap(110,3),{refinementCredits:15,suggestedReserveCredits:125});
});
test('preflight credit cap rejects impossible values',()=>{
  assert.throws(()=>preflightCreditCap(9,2));
  assert.throws(()=>preflightCreditCap(60,-1));
  assert.throws(()=>preflightCreditCap(60,7));
  assert.throws(()=>preflightCreditCap(60.5,2));
});
