import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecordingLibrary } from '../src/library/types';
import type { SavedRecording } from '../src/recording/storage';
import { createWritingController, type WritingController } from '../src/writing/controller';
import type { DraftRequest, RecordType, WritingServices } from '../src/writing/types';

// Fictional observations and local adapters; no server, external AI or database.
const recording: SavedRecording = {
  uri: 'file:///documents/recordings/2026-11-05/2026-11-05_09-10.m4a',
  fileName: '2026-11-05_09-10.m4a', dateKey: '2026-11-05', startTime: '09:10',
};
const response = () => ({ common_text: '', records: [{
  record_id: 'J-DEMO', child_id: 'C-DEMO', status: '검토중', missing_evidence: false, special_notes: [],
  individual_sentences: [{ text: '가상 아동이 블록 두 개를 쌓았다.', observation_ids: ['O-DEMO'], content_kind: '관찰' }],
}] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(fileOverrides: Partial<RecordingLibrary> = {}) {
  const calls = { prepared: 0, generated: [] as DraftRequest[], validated: [] as string[] };
  const saved = new Map<string, string>();
  const files: RecordingLibrary = {
    available: true, async list() { return [recording]; },
    async validate(row) { calls.validated.push(row.uri); },
    async remove() { assert.fail('Writing inputs must never remove audio'); }, ...fileOverrides,
  };
  const services: WritingServices = {
    workflow: {
      async prepare(rows) {
        calls.prepared++;
        return { recordingUris: rows.map(row => row.uri), childIds: ['C-DEMO'], privacyVerified: true,
          observations: [{ observation_id: 'O-DEMO', child_ids: ['C-DEMO'], activity: '가상 블록 놀이',
            text: '가상 아동이 블록 두 개를 쌓음', observation_type: ['행동'], scope: 'individual', sensitive: false }] };
      },
      async generate(input) { calls.generated.push(input); return response(); },
    },
    confirmation: { async confirm(id, input) { saved.set(id, input.edited_text); return { status: '완료' }; } },
  };
  return { controller: createWritingController(files, services), files, services, calls, saved };
}
async function settled(controller: WritingController) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (controller.getSnapshot().phase === 'idle') return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Writing operation did not settle');
}
async function start(f: ReturnType<typeof fixture>) {
  f.controller.selectRecordType('관찰일지');
  await f.controller.initialize(); f.controller.toggleRecording(recording.uri);
  await f.controller.next(); await settled(f.controller);
  assert.equal(f.controller.getSnapshot().route, 'review');
}

test('type starts unselected and neither Next nor direct generation bypasses the required choice', async () => {
  const f = fixture();
  assert.equal(f.controller.getSnapshot().recordType, null);
  assert.equal(f.controller.getSnapshot().keywords, '');
  await f.controller.initialize(); f.controller.toggleRecording(recording.uri);
  await f.controller.next(); f.controller.generate(); await settled(f.controller);
  assert.equal(f.calls.prepared, 0);
  assert.deepEqual(f.calls.generated, []);
  assert.equal(f.controller.getSnapshot().draft, null);
  assert.match(f.controller.getSnapshot().notice ?? '', /유형|기록.*선택/);
});

for (const type of ['관찰일지', '알림장'] as const) {
  test(`${type} with no observations reports missing content without inventing a draft`, async () => {
    const f = fixture();
    f.controller.selectRecordType(type); f.controller.editKeywords(' \n\t ');
    await f.controller.next();
    assert.equal(f.controller.getSnapshot().notice, '작성할 관찰 내용이 없어요.');
    assert.equal(f.controller.getSnapshot().keywords, ' \n\t ');
    assert.equal(f.controller.getSnapshot().recordType, type);
    assert.equal(f.controller.getSnapshot().draft, null);
    assert.equal(f.calls.prepared, 0);
  });

  test(`${type} keyword-only entry is retained without mobile recordings or a generation adapter`, async () => {
    const files: RecordingLibrary = {
      available: false, async list() { assert.fail('Unavailable library must not be listed'); },
      async validate() { assert.fail('No recording was selected'); }, async remove() { assert.fail('No deletion'); },
    };
    const controller = createWritingController(files);
    await controller.initialize(); controller.selectRecordType(type);
    const keywords = '  가상 아동, 블록 놀이\n블록 두 개 쌓기  ';
    controller.editKeywords(keywords); await controller.next();
    assert.equal(controller.getSnapshot().recordings.status, 'unavailable');
    assert.equal(controller.getSnapshot().recordType, type);
    assert.equal(controller.getSnapshot().keywords, keywords);
    assert.deepEqual(controller.getSnapshot().checked, []);
    assert.equal(controller.getSnapshot().draft, null);
    assert.equal(controller.getSnapshot().route, 'picker');
    assert.match(controller.getSnapshot().notice ?? '', /연결/);
  });
}

for (const [type, keywords] of [
  ['관찰일지', '가상 아동 블록 놀이'], ['알림장', ''], ['알림장', '가상 아동 블록 놀이'],
] as [RecordType, string][]) {
  test(`unsupported ${type}/${keywords ? 'keywords' : 'recordings only'} never reaches prepare or generate`, async () => {
    const f = fixture(); await f.controller.initialize();
    f.controller.selectRecordType(type); f.controller.toggleRecording(recording.uri); f.controller.editKeywords(keywords);
    await f.controller.next();
    assert.ok(f.calls.validated.includes(recording.uri));
    assert.equal(f.calls.prepared, 0);
    assert.deepEqual(f.calls.generated, []);
    assert.equal(f.controller.getSnapshot().draft, null);
    assert.equal(f.controller.getSnapshot().recordType, type);
    assert.equal(f.controller.getSnapshot().keywords, keywords);
    assert.deepEqual(f.controller.getSnapshot().checked, [recording.uri]);
    assert.match(f.controller.getSnapshot().notice ?? '', /연결/);
  });
}

test('supported recording-only journal keeps the canonical request and preserves whitespace keywords', async () => {
  const f = fixture(); await f.controller.initialize();
  f.controller.selectRecordType('관찰일지'); f.controller.toggleRecording(recording.uri);
  f.controller.editKeywords(' \n\t '); await f.controller.next();
  assert.equal(f.controller.getSnapshot().route, 'review');
  assert.equal(f.controller.getSnapshot().keywords, ' \n\t ');
  assert.deepEqual(f.calls.generated, [{ record_type: '관찰일지', child_ids: ['C-DEMO'], observation_ids: ['O-DEMO'] }]);
  assert.equal(JSON.stringify(f.calls.generated).includes('file:///'), false);
  assert.equal('keywords' in f.calls.generated[0], false);
});

test('keyword entry cannot bypass validation of a selected missing recording', async () => {
  let validations = 0;
  const f = fixture({ async validate() { validations++; throw new Error('private missing file detail'); } });
  await f.controller.initialize(); f.controller.selectRecordType('알림장');
  f.controller.toggleRecording(recording.uri); f.controller.editKeywords('가상 관찰 키워드');
  await f.controller.next();
  assert.equal(validations, 1);
  assert.equal(f.calls.prepared, 0);
  assert.deepEqual(f.calls.generated, []);
  assert.equal(f.controller.getSnapshot().keywords, '가상 관찰 키워드');
  assert.deepEqual(f.controller.getSnapshot().checked, [recording.uri]);
  assert.doesNotMatch(f.controller.getSnapshot().notice ?? '', /private missing|연결 준비/);
  assert.equal(f.controller.getSnapshot().draft, null);
});

test('direct generation also refuses notice type and keyword input rather than silently dropping them', async () => {
  for (const [type, keywords] of [['알림장', ''], ['관찰일지', '가상 관찰']] as [RecordType, string][]) {
    const f = fixture(); await f.controller.openPicker();
    f.controller.selectRecordType(type); f.controller.toggleRecording(recording.uri);
    await f.controller.importRecordings(); f.controller.editKeywords(keywords);
    f.controller.generate(); await settled(f.controller);
    assert.equal(f.calls.prepared, 0);
    assert.deepEqual(f.calls.generated, []);
    assert.equal(f.controller.getSnapshot().draft, null);
    assert.match(f.controller.getSnapshot().notice ?? '', /연결/);
  }
});

test('type, raw keywords and checked recordings survive tab leave and list refresh', async () => {
  const f = fixture(); await f.controller.initialize();
  f.controller.selectRecordType('알림장'); f.controller.toggleRecording(recording.uri);
  const keywords = '  가상 아동, 산책\n솔방울 보여주기  ';
  f.controller.editKeywords(keywords);
  assert.equal(await f.controller.leave(), true);
  await f.controller.refreshRecordings();
  assert.equal(f.controller.getSnapshot().recordType, '알림장');
  assert.equal(f.controller.getSnapshot().keywords, keywords);
  assert.deepEqual(f.controller.getSnapshot().checked, [recording.uri]);
  assert.equal(f.calls.prepared, 0);
});

test('type changes preserve the draft until confirmed, and never relabel its content on cancellation', async () => {
  const f = fixture(); await start(f);
  f.controller.openEditor(); f.controller.editText('  교사의 가상 편집본\n');
  const draft = f.controller.getSnapshot().draft;
  f.controller.selectRecordType('알림장');
  assert.equal(f.controller.getSnapshot().guard?.kind, 'selection');
  assert.equal(f.controller.getSnapshot().recordType, '관찰일지');
  assert.equal(f.controller.getSnapshot().draft, draft);
  f.controller.resolveGuard(false);
  assert.equal(f.controller.getSnapshot().recordType, '관찰일지');
  assert.equal(f.controller.getSnapshot().draft?.records[0].editedText, '  교사의 가상 편집본\n');
  f.controller.selectRecordType('알림장'); f.controller.resolveGuard(true);
  assert.equal(f.controller.getSnapshot().recordType, '알림장');
  assert.equal(f.controller.getSnapshot().route, 'picker');
  assert.equal(f.controller.getSnapshot().draft, null);
  assert.deepEqual(f.controller.getSnapshot().selected, [recording]);
  assert.equal(f.calls.generated.length, 1);
});

test('keyword changes are staged by confirmation and do not erase previously saved final text', async () => {
  const f = fixture(); await start(f);
  const finalText = '  교사가 확정한 가상 관찰\n';
  f.controller.openEditor(); f.controller.editText(finalText); await f.controller.confirm();
  const keywords = '  추가 가상 키워드\n  ';
  f.controller.editKeywords(keywords);
  assert.equal(f.controller.getSnapshot().keywords, '');
  assert.equal(f.controller.getSnapshot().guard?.kind, 'selection');
  f.controller.resolveGuard(false);
  assert.equal(f.controller.getSnapshot().draft?.records[0].confirmedText, finalText);
  f.controller.editKeywords(keywords); f.controller.resolveGuard(true);
  assert.equal(f.controller.getSnapshot().keywords, keywords);
  assert.equal(f.controller.getSnapshot().draft, null);
  assert.equal(f.saved.get('J-DEMO'), finalText);
  assert.equal(f.calls.generated.length, 1);
});

test('pending Next validation locks form edits and duplicate requests', async () => {
  const wait = deferred<void>();
  let validations = 0;
  const f = fixture({ async validate() { validations++; await wait.promise; } });
  await f.controller.initialize(); f.controller.selectRecordType('관찰일지'); f.controller.toggleRecording(recording.uri);
  const next = f.controller.next();
  f.controller.selectRecordType('알림장'); f.controller.editKeywords('처리 중 입력');
  const duplicate = f.controller.next();
  assert.equal(f.controller.getSnapshot().recordType, '관찰일지');
  assert.equal(f.controller.getSnapshot().keywords, '');
  assert.equal(validations, 1);
  wait.resolve(); await Promise.all([next, duplicate]);
  assert.equal(f.calls.generated.length, 1);
});

test('late abandoned generation cannot replace a new type and keyword selection', async () => {
  const pending = deferred<unknown>();
  const f = fixture(); f.services.workflow!.generate = async input => { f.calls.generated.push(input); return pending.promise; };
  await f.controller.initialize(); f.controller.selectRecordType('관찰일지'); f.controller.toggleRecording(recording.uri);
  const next = f.controller.next(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.controller.getSnapshot().phase, 'generating');
  const leaving = f.controller.leave(); f.controller.resolveGuard(true); assert.equal(await leaving, true);
  f.controller.selectRecordType('알림장'); f.controller.editKeywords('새 가상 입력');
  pending.resolve(response()); await next;
  assert.equal(f.controller.getSnapshot().recordType, '알림장');
  assert.equal(f.controller.getSnapshot().keywords, '새 가상 입력');
  assert.equal(f.controller.getSnapshot().draft, null);
  assert.equal(f.controller.getSnapshot().route, 'picker');
});

test('keywords can be entered while recording lookup is pending and survive its failure', async () => {
  const wait = deferred<SavedRecording[]>();
  const f = fixture({ async list() { return wait.promise; } });
  const opening = f.controller.initialize();
  f.controller.selectRecordType('알림장'); f.controller.editKeywords('가상 관찰');
  await f.controller.next();
  assert.equal(f.controller.getSnapshot().keywords, '가상 관찰');
  assert.match(f.controller.getSnapshot().notice ?? '', /연결/);
  wait.reject(new Error('fictional recording lookup failure')); await opening;
  assert.equal(f.controller.getSnapshot().recordings.status, 'error');
  assert.equal(f.controller.getSnapshot().recordType, '알림장');
  assert.equal(f.controller.getSnapshot().keywords, '가상 관찰');
  assert.equal(f.controller.getSnapshot().draft, null);
});
