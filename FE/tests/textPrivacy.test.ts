import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { textNames } from '../src/api/textNames';
import { createV2Api } from '../src/api/v2';
import { restoreWordNames } from '../src/writing/wordNames';

const first = '2f4c6a01-5431-46cb-9ada-a81a2dc151c1';
const second = '2f4c6a02-5431-46cb-9ada-a81a2dc151c1';
const roster = [{ child_id: first, name: '가상하린' }, { child_id: second, name: '가상지우' }];
const token = (id: string) => `⟦C:${id}⟧`;

test('typed input sends tokens with the chosen owner; returned drafts restore names locally', async context => {
  const sent: Array<{ url: string; body: string }> = [];
  context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const body = String(options.body ?? '');
    sent.push({ url, body });
    if (url.endsWith('/text-privacy')) return Response.json({ supported: true });
    return Response.json({ result: { content: token(first) + '이 블록을 건넴.' } });
  });
  const api = createV2Api('https://patpat.example', 'fake', undefined, async () => roster);
  const job = await api.draftStandaloneJournal(first, {
    content: '가상하린이 가상지우에게 블록을 건넴.', place: null, time_text: null, areas: [],
  });
  assert.match(sent[1].url, new RegExp(first + '/journal/draft\\?protect_text=true$'));
  const body = JSON.parse(sent[1].body);
  assert.equal(body.content, `${token(first)}이 ${token(second)}에게 블록을 건넴.`);
  assert.equal(job.result?.content, '가상하린이 블록을 건넴.');
  assert.doesNotMatch(sent[1].body, /가상하린|가상지우/);
});

test('a server without the text privacy capability receives no generation request', async context => {
  const called: string[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    called.push(url);
    return Response.json({}, { status: 404 });
  });
  const api = createV2Api('https://patpat.example', 'fake', undefined, async () => roster);
  await assert.rejects(api.generate('session'), /서버 업데이트/);
  assert.deepEqual(called, ['https://patpat.example/api/v2/sessions/text-privacy']);
});

test('ambiguous given names resolve only in the owner block, and Word names are XML-escaped', async () => {
  const codec = textNames([{ child_id: first, name: '김하린' }, { child_id: second, name: '박하린' }]);
  assert.equal(codec.encode('하린이 말함', first), token(first) + '이 말함');
  assert.equal(codec.encode('하린이 말함'), '아동이 말함');
  assert.equal(codec.encode(token(first)), token(first));

  const documentPath = 'word/document.xml';
  const zipped = zipSync({ [documentPath]: strToU8('<w:t>' + token(first) + '</w:t>'), 'media.bin': new Uint8Array([1, 2]) });
  const output = await restoreWordNames(new Uint8Array(zipped).buffer, async () => textNames([{ child_id: first, name: '가&나' }]));
  const files = unzipSync(new Uint8Array(output));
  assert.equal(strFromU8(files[documentPath]), '<w:t>가&amp;나</w:t>');
  assert.deepEqual(files['media.bin'], new Uint8Array([1, 2]));
});

test('weekly journal answers and approved text retain local name protection', async context => {
  const sent: Array<{ url: string; body: string }> = [];
  context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    sent.push({ url, body: String(options.body ?? '') });
    if (url.endsWith('/text-privacy')) return Response.json({ supported: true });
    return Response.json({ result: { entries: [{ content: token(first) + '이 말했음.' }] } });
  });
  const api = createV2Api('https://patpat.example', 'fake', undefined, async () => roster);
  await api.draftWeeklyJournal(first, '2026-11-06');
  const result = await api.answerWeeklyJournal(first, 'job', { 0: '가상하린이 말했어요.' });
  await api.confirmWeeklyJournal(first, 'clarified', { 0: '가상하린이 말했다.' });
  assert.match(sent[1].url, /\/journal\/weekly\/draft$/);
  assert.deepEqual(JSON.parse(sent[1].body), { week_of: '2026-11-06' });
  assert.match(sent[2].url, /\/journal\/weekly\/job\/answers$/);
  assert.deepEqual(JSON.parse(sent[2].body), { answers: { 0: token(first) + '이 말했어요.' } });
  assert.match(sent[3].url, /\/journal\/weekly\/clarified\/confirm$/);
  assert.deepEqual(JSON.parse(sent[3].body), { entries: { 0: token(first) + '이 말했다.' } });
  assert.equal(result.result?.entries?.[0].content, '가상하린이 말했음.');
});
