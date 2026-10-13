import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { extractResumeText, rankCareerJobs, requestCareerDraft } from '../backend/src/career-copilot.js';

function makeDocx(text) {
  const name = Buffer.from('word/document.xml'), contents = Buffer.from(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`), compressed = deflateRawSync(contents);
  const local = Buffer.alloc(30 + name.length + compressed.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(contents.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30); compressed.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(contents.length, 24); central.writeUInt16LE(name.length, 28); name.copy(central, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

test('career job ranking uses self-reported skills, target role, and fit signals', () => {
  const jobs = rankCareerJobs({ target_role: 'Product Designer', skills: ['Figma', 'Research'] }, [
    { id: 'low', title: 'Support Agent', description: 'Customer support', location: 'Remote', work_style: 'Remote' },
    { id: 'high', title: 'Product Designer', description: 'Figma and user research', location: 'Bengaluru', work_style: 'Hybrid' },
  ]);
  assert.equal(jobs[0].id, 'high');
  assert.deepEqual(jobs[0].matched_skills, ['Figma', 'Research']);
  assert.ok(jobs[0].match_score > jobs[1].match_score);
});

test('resume parser explains unsupported legacy DOC files', async () => {
  await assert.rejects(extractResumeText(Buffer.from('not a document'), 'doc'), /supports PDF and DOCX/);
});

test('resume parser extracts DOCX text and decodes XML entities', async () => {
  const extracted = await extractResumeText(makeDocx('Senior Designer &amp; Researcher — 8 years of product design experience. Led research, prototyping, and successful cross-functional launches.'), 'docx');
  assert.match(extracted, /Senior Designer & Researcher/);
  assert.match(extracted, /8 years/);
});

test('Career Copilot chat uses the configured provider only after server configuration', async () => {
  const oldKey = process.env.AI_API_KEY, oldModel = process.env.AI_MODEL, oldFetch = globalThis.fetch;
  process.env.AI_API_KEY = 'test-key'; process.env.AI_MODEL = 'test-model';
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: 'I can help you compare roles.', summary: '', strengths: [], missingSkills: [], cautions: [], fitScore: 0, tailoredResume: '' }) } }] });
  };
  try {
    const result = await requestCareerDraft({ action: 'chat', message: 'How should I describe my projects?', history: [{ role: 'user', content: 'Find jobs' }], profile: { skills: ['Figma'] }, resumeText: 'Private resume text' });
    assert.equal(result.reply, 'I can help you compare roles.');
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.messages[1].content.includes('Private resume text'), true);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = oldModel;
  }
});

test('Career Copilot never presents an empty tailored resume when the model omits its draft', async () => {
  const oldKey = process.env.AI_API_KEY, oldModel = process.env.AI_MODEL, oldFetch = globalThis.fetch;
  process.env.AI_API_KEY = 'test-key'; process.env.AI_MODEL = 'test-model';
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: 'Relevant product design experience.', tailoredResume: '' }) } }] });
  try {
    const original = 'A factual resume with product design, user research, prototyping, accessibility, and cross-functional product delivery experience. '.repeat(2);
    const result = await requestCareerDraft({ action: 'tailor', resumeText: original, profile: {}, job: { title: 'Product Designer' } });
    assert.equal(result.tailoredResume, original);
    assert.match(result.cautions[0], /original resume text unchanged/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = oldModel;
  }
});
