import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageRecord } from '../src/reconstruct/usage.js';
test('cache writes replace the uncached rate for those input tokens', () => {
  const usage = usageRecord(1,'openai','gpt-6-astra',{input_tokens:100000,input_tokens_details:{cached_tokens:20000,cache_write_tokens:30000},output_tokens:10000},'completed');
  assert.equal(usage.cacheWriteTokens,30000);
  assert.equal(usage.estimatedUsd,1.395);
});
test('cache writes receive the documented long-context input multiplier', () => {
  const usage = usageRecord(1,'openai','gpt-6-astra',{input_tokens:300000,input_tokens_details:{cached_tokens:50000,cache_write_tokens:100000},output_tokens:10000},'completed');
  assert.equal(usage.estimatedUsd,6.35);
});
test('invalid cache details are unknown cost, not negative or free usage', () => {
  for (const writes of [-1,Infinity,20]) {
    const usage = usageRecord(1,'openai','gpt-6-astra',{input_tokens:10,input_tokens_details:{cached_tokens:1,cache_write_tokens:writes},output_tokens:0},'completed');
    assert.equal(usage.estimatedUsd,null);
  }
});
