import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconstructionReviewStatus, reviewBlockingEvidence } from '../src/reconstruct/review-policy.js';

test('reconnectable form backends do not masquerade as visual reconstruction failures',()=>{
  const blockers=['/contact: form submission needs a backend integration; acknowledging this does not implement it.'];
  assert.deepEqual(reviewBlockingEvidence(blockers),[]);
  assert.equal(reconstructionReviewStatus(true,blockers),'review');
});

test('broken source evidence and embedded runtimes still block a clean review status',()=>{
  const broken=['/: 1 source images did not load.'];
  const embed=['/: embedded media requires an approved integration (https://player.example/embed).'];
  assert.deepEqual(reviewBlockingEvidence(broken),broken);
  assert.deepEqual(reviewBlockingEvidence(embed),embed);
  assert.equal(reconstructionReviewStatus(true,broken),'needs-work');
  assert.equal(reconstructionReviewStatus(true,embed),'needs-work');
  assert.equal(reconstructionReviewStatus(false,[]),'needs-work');
});
