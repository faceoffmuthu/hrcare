import test from 'node:test';
import assert from 'node:assert/strict';
import { rankJobsForProfile, scoreJobMatch } from '../dist/smart-match.mjs';

test('smart matching ranks relevant jobs using explainable profile signals', () => {
  const profile = { target_role: 'Product Designer', location: 'Bengaluru, India', work_style: 'Hybrid', skills: ['Figma', 'Product design', 'User research'] };
  const jobs = [
    { id: 1, title: 'Senior Product Designer', location: 'Bengaluru, India', mode: 'Hybrid', skills: ['Figma', 'Product design', 'Research'] },
    { id: 2, title: 'Data Analyst', location: 'Hyderabad, India', mode: 'On-site', skills: ['SQL', 'Python'] },
  ];
  const ranked = rankJobsForProfile(profile, jobs);
  assert.equal(ranked[0].job.id, 1);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].reasons.some((reason) => reason.startsWith('Skills:')));
});

test('smart matching does not return closed or paused roles', () => {
  assert.deepEqual(rankJobsForProfile({}, [{ id: 1, status: 'closed' }, { id: 2, status: 'paused' }, { id: 3, status: 'published' }]).map((row) => row.job.id), [3]);
});

test('missing profile data still returns a bounded neutral score', () => {
  const result = scoreJobMatch({}, { title: 'Designer', skills: [], location: 'Remote' });
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(result.reasons.length > 0);
});
