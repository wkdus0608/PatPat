import assert from 'node:assert/strict';
import test from 'node:test';

import type { RecordingLibrary } from '../src/library/types';
import type { SavedRecording } from '../src/recording/storage';
import { createWritingController, type WritingController } from '../src/writing/controller';
import type { JournalWorkflow, WritingServices } from '../src/writing/types';

// Fictional adapters verify screen transitions, not external AI or storage quality.
const recordings: SavedRecording[] = [1, 2].map((day) => ({
  uri: `file:///documents/recordings/2026-11-0${day}/2026-11-0${day}_09-10.m4a`,
  fileName: `2026-11-0${day}_09-10.m4a`, dateKey: `2026-11-0${day}`, startTime: '09:10',
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function settled(controller: WritingController) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (controller.getSnapshot().phase === 'idle') return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Writing operation did not settle');
}

function fixture(overrides: Partial<WritingServices> = {}) {
  let lists = 0;
  let generations = 0;
  let revisions = 0;
  let confirmations = 0;
  let failSave = false;
  const saved: { recordId: string; text: string }[] = [];
  const files: RecordingLibrary = {
    available: true,
    async list() { lists++; return [...recordings]; },
    async validate() {},
    async remove() { assert.fail('Selecting recordings must not remove source audio'); },
  };
  const workflow: JournalWorkflow = {
    async prepare(selected) {
      return {
        recordingUris: selected.map((row) => row.uri), childIds: ['C01', 'C02'], privacyVerified: true,
        observations: ['C01', 'C02'].map((child, index) => ({
          observation_id: `O${index + 1}`, child_ids: [child], activity: '가상 블록 놀이',
          text: `${child}이 가상 블록 두 개를 쌓음`, observation_type: ['행동'],
          scope: 'individual', sensitive: false,
        })),
      };
    },
    async generate() {
      generations++;
      return {
        common_text: '', records: ['C01', 'C02'].map((child, index) => ({
          record_id: `J${index + 1}`, child_id: child, status: '검토중', missing_evidence: false,
          special_notes: [], individual_sentences: [{ text: `${child}이 가상 블록 두 개를 쌓았다.`,
            observation_ids: [`O${index + 1}`], content_kind: '관찰' }],
        })),
      };
    },
    async revise() { revisions++; return { text: 'C01이 가상 블록 두 개를 쌓았다.' }; },
  };
  const controller = createWritingController(files, {
    workflow,
    confirmation: {
      async confirm(recordId, input) {
        confirmations++;
        if (failSave) throw new Error('Fake save failure');
        saved.push({ recordId, text: input.edited_text });
        return { status: '완료' };
      },
    },
    ...overrides,
  });
  // Keep these navigation cases on the supported recording-based journal path.
  controller.selectRecordType('관찰일지');
  return {
    controller, workflow, saved,
    setSaveFailure(value: boolean) { failSave = value; },
    get lists() { return lists; },
    get generations() { return generations; },
    get revisions() { return revisions; },
    get confirmations() { return confirmations; },
  };
}

async function start(f: ReturnType<typeof fixture>) {
  await f.controller.initialize();
  f.controller.toggleRecording(recordings[0].uri);
  await f.controller.next();
  await settled(f.controller);
  assert.equal(f.controller.getSnapshot().route, 'review');
}

test('first screen loads recordings once and Next selects and generates without a second action', async () => {
  const f = fixture();
  assert.equal(f.controller.getSnapshot().route, 'picker');
  assert.equal(await f.controller.back(), true);
  await Promise.all([f.controller.initialize(), f.controller.initialize()]);
  assert.equal(f.lists, 1);
  await f.controller.next();
  assert.equal(f.generations, 0);
  assert.equal(f.controller.getSnapshot().route, 'picker');

  f.controller.toggleRecording(recordings[0].uri);
  f.controller.toggleRecording(recordings[1].uri);
  await Promise.all([f.controller.next(), f.controller.next()]);
  await settled(f.controller);
  assert.equal(f.generations, 1);
  assert.deepEqual(f.controller.getSnapshot().selected, recordings);
  assert.equal(f.controller.getSnapshot().route, 'review');
});

test('manual edit and prompt are separate screens and back or tab leave preserves their input', async () => {
  const f = fixture();
  await start(f);
  f.controller.openEditor();
  assert.equal(f.controller.getSnapshot().route, 'edit');
  f.controller.editText('  C01 교사 편집본\n');
  assert.equal(await f.controller.leave(), true);
  assert.equal(f.controller.getSnapshot().route, 'edit');
  assert.equal(await f.controller.back(), false);
  assert.equal(f.controller.getSnapshot().route, 'review');
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, '  C01 교사 편집본\n');

  f.controller.openRevision();
  assert.equal(f.controller.getSnapshot().route, 'revision');
  f.controller.editPrompt('관찰 사실을 유지하며 간결하게');
  await f.controller.back();
  assert.equal(f.controller.getSnapshot().route, 'review');
  f.controller.openRevision();
  assert.equal(f.controller.getSnapshot().draft!.records[0].prompt, '관찰 사실을 유지하며 간결하게');
  assert.equal(f.generations, 1);
});

test('Next stays on recording selection until generation has actually completed', async () => {
  const f = fixture();
  const generated = deferred<unknown>();
  const response = await f.workflow.generate({ record_type: '관찰일지', child_ids: ['C01', 'C02'],
    observation_ids: ['O1', 'O2'] }, new AbortController().signal);
  f.workflow.generate = async () => generated.promise;
  await f.controller.initialize();
  f.controller.toggleRecording(recordings[0].uri);
  const next = f.controller.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.controller.getSnapshot().route, 'picker');
  assert.equal(f.controller.getSnapshot().phase, 'generating');
  assert.equal(f.controller.getSnapshot().draft, null);
  generated.resolve(response);
  await next;
  await settled(f.controller);
  assert.equal(f.controller.getSnapshot().route, 'review');
});

test('both Done paths reach the saved screen only after exact current-child confirmation', async () => {
  const f = fixture();
  await start(f);
  f.controller.openEditor();
  const text = '  C01 교사 확정문\r\n줄바꿈 유지\n\t';
  f.controller.editText(text);
  await f.controller.confirm();
  assert.equal(f.controller.getSnapshot().route, 'complete');
  assert.deepEqual(f.saved, [{ recordId: 'J1', text }]);
  assert.equal(f.controller.getSnapshot().draft!.records[1].confirmedText, null);
  assert.equal(f.generations, 1);
  assert.equal(f.revisions, 0);

  await f.controller.back();
  assert.equal(f.controller.getSnapshot().route, 'review');
  await f.controller.confirm();
  assert.equal(f.controller.getSnapshot().route, 'complete');
  assert.equal(f.confirmations, 1); // Opening an already saved record does not save again.

  await f.controller.back();
  f.controller.selectRecord('J2');
  await f.controller.confirm();
  assert.equal(f.controller.getSnapshot().route, 'complete');
  assert.deepEqual(f.saved.map((row) => row.recordId), ['J1', 'J2']);
});

test('failed and empty Done preserve the editing screen and draft for retry', async () => {
  const f = fixture();
  await start(f);
  f.controller.openEditor();
  f.controller.editText('교사가 확인한 C01 가상 관찰');
  f.setSaveFailure(true);
  await f.controller.confirm();
  assert.equal(f.controller.getSnapshot().route, 'edit');
  assert.equal(f.controller.getSnapshot().draft!.records[0].confirmedText, null);
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, '교사가 확인한 C01 가상 관찰');
  assert.deepEqual(f.saved, []);

  f.controller.editText('  \n');
  f.setSaveFailure(false);
  await f.controller.confirm();
  assert.equal(f.controller.getSnapshot().route, 'edit');
  assert.equal(f.confirmations, 1);
});

test('pending confirmation blocks back and does not show the saved screen early', async () => {
  const saved = deferred<unknown>();
  const f = fixture({ confirmation: { async confirm() { return saved.promise; } } });
  await start(f);
  f.controller.openEditor();
  f.controller.editText('저장 중인 C01 가상 확정문');
  const confirming = f.controller.confirm();
  assert.equal(f.controller.getSnapshot().phase, 'confirming');
  assert.equal(await f.controller.back(), false);
  assert.equal(f.controller.getSnapshot().route, 'edit');
  assert.equal(f.controller.getSnapshot().draft!.records[0].confirmedText, null);
  saved.resolve({ status: '완료' });
  await confirming;
  assert.equal(f.controller.getSnapshot().route, 'complete');
  assert.equal(f.controller.getSnapshot().draft!.records[0].confirmedText, '저장 중인 C01 가상 확정문');
});

test('successful AI request returns to review; unresolved candidate blocks all three branches', async () => {
  const f = fixture();
  await start(f);
  const original = f.controller.getSnapshot().draft!.records[0].editedText;
  f.controller.openRevision();
  f.controller.editPrompt('가상 문장을 간결하게');
  await f.controller.revise();
  assert.equal(f.controller.getSnapshot().route, 'review');
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, original);
  assert.ok(f.controller.getSnapshot().draft!.records[0].candidate);

  f.controller.openEditor();
  f.controller.openRevision();
  await f.controller.confirm();
  assert.equal(f.controller.getSnapshot().route, 'review');
  assert.equal(f.confirmations, 0);
  f.controller.applyCandidate();
  assert.equal(f.controller.getSnapshot().draft!.records[0].candidate, null);
  assert.equal(f.controller.getSnapshot().draft!.records[0].confirmedText, null);
  f.controller.openEditor();
  assert.equal(f.controller.getSnapshot().route, 'edit');
});

test('AI request failure remains on prompt screen with body and prompt intact', async () => {
  const f = fixture();
  await start(f);
  const original = f.controller.getSnapshot().draft!.records[0].editedText;
  f.workflow.revise = async () => { throw new Error('Fake AI failure'); };
  f.controller.openRevision();
  f.controller.editPrompt('문장을 간결하게');
  await f.controller.revise();
  assert.equal(f.controller.getSnapshot().route, 'revision');
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, original);
  assert.equal(f.controller.getSnapshot().draft!.records[0].prompt, '문장을 간결하게');
  assert.equal(f.controller.getSnapshot().draft!.records[0].candidate, null);
});

test('back during an AI request asks before cancellation and ignores a late result', async () => {
  const f = fixture();
  await start(f);
  const pending = deferred<unknown>();
  f.workflow.revise = async () => pending.promise;
  f.controller.openRevision();
  f.controller.editPrompt('문장을 간결하게');
  const revising = f.controller.revise();
  const stay = f.controller.back();
  assert.equal(f.controller.getSnapshot().guard?.kind, 'leave');
  f.controller.resolveGuard(false);
  assert.equal(await stay, false);
  assert.equal(f.controller.getSnapshot().route, 'revision');
  assert.equal(f.controller.getSnapshot().phase, 'revising');

  const back = f.controller.back();
  f.controller.resolveGuard(true);
  assert.equal(await back, false);
  assert.equal(f.controller.getSnapshot().route, 'review');
  pending.resolve({ text: '이탈 후 도착한 가상 후보' });
  await revising;
  assert.equal(f.controller.getSnapshot().route, 'review');
  assert.equal(f.controller.getSnapshot().draft!.records[0].candidate, null);
});

test('AI completion while a back confirmation is open cannot skip the review destination', async () => {
  const f = fixture();
  await start(f);
  const pending = deferred<unknown>();
  f.workflow.revise = async () => pending.promise;
  f.controller.openRevision();
  f.controller.editPrompt('가상 관찰 사실을 유지하며 수정');
  const revising = f.controller.revise();
  const back = f.controller.back();
  assert.equal(f.controller.getSnapshot().guard?.kind, 'leave');
  pending.resolve({ text: 'C01이 가상 블록 두 개를 쌓았다.' });
  await revising;
  f.controller.resolveGuard(true);
  assert.equal(await back, false);
  assert.equal(f.controller.getSnapshot().route, 'review');
});

test('back to recording selection and Next with unchanged selection resumes without regeneration', async () => {
  const f = fixture();
  await start(f);
  f.controller.openEditor();
  f.controller.editText('이어서 작성할 C01 가상 편집본');
  await f.controller.back();
  await f.controller.back();
  assert.equal(f.controller.getSnapshot().route, 'picker');
  assert.deepEqual(f.controller.getSnapshot().checked, [recordings[0].uri]);
  await f.controller.next();
  assert.equal(f.controller.getSnapshot().route, 'review');
  assert.equal(f.generations, 1);
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, '이어서 작성할 C01 가상 편집본');
});

test('concurrent back presses navigate only one screen and never exit the writing tab', async () => {
  const f = fixture();
  await start(f);
  f.controller.openEditor();
  assert.deepEqual(await Promise.all([f.controller.back(), f.controller.back()]), [false, false]);
  assert.equal(f.controller.getSnapshot().route, 'review');
  assert.deepEqual(await Promise.all([f.controller.back(), f.controller.back()]), [false, false]);
  assert.equal(f.controller.getSnapshot().route, 'picker');
});

test('unconnected generation keeps the selection screen without inventing a draft', async () => {
  const f = fixture({ workflow: undefined });
  await f.controller.initialize();
  f.controller.toggleRecording(recordings[0].uri);
  await f.controller.next();
  assert.equal(f.controller.capabilities.generation, false);
  assert.equal(f.controller.getSnapshot().route, 'picker');
  assert.equal(f.controller.getSnapshot().draft, null);
  assert.deepEqual(f.controller.getSnapshot().checked, [recordings[0].uri]);
  assert.equal(f.generations, 0);
});
