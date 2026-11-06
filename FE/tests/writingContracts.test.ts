import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeRecording } from '../src/recording/files';
import type { SavedRecording } from '../src/recording/storage';
import type { JournalDetail, JournalSource, RecordingLibrary } from '../src/library/types';
import { loadJournalDetail, loadJournalList } from '../src/library/journals';
import { createWritingController, type WritingController } from '../src/writing/controller';
import type { DraftRequest, JournalWorkflow, WritingServices } from '../src/writing/types';
import {
  readCandidate, readDraft, readPrepared, requireConfirmed, WritingInputError,
} from '../src/writing/validation';

// Fictional local inputs exercise structure and state, not generated prose quality.
function recordings(): SavedRecording[] {
  return [10, 11].map((minute) => {
    const name = describeRecording(new Date(2026, 10, 2, 9, minute));
    return { ...name, uri: `file:///documents/recordings/${name.dateKey}/${name.fileName}` };
  });
}

function preparedInput() {
  return {
    privacyVerified: true as const,
    recordingUris: recordings().map((recording) => recording.uri),
    childIds: ['C01', 'C02', 'C03'],
    observations: [
      {
        observation_id: 'O_COMMON', child_ids: ['C01', 'C02', 'C03'], activity: '블록 놀이',
        text: '반 전체가 블록 놀이를 했다.', observation_type: ['행동'], scope: 'common', sensitive: false,
      },
      {
        observation_id: 'O_C01', child_ids: ['C01'], activity: '블록 놀이',
        text: 'C01이 네모 블록 두 개를 쌓았다.', observation_type: ['행동'], scope: 'individual', sensitive: false,
      },
      {
        observation_id: 'O_C02', child_ids: ['C02'], activity: '실외 놀이',
        text: 'C02가 넘어져 오른쪽 무릎이 살짝 까졌다. 흐르는 물로 씻었다.',
        observation_type: ['부상'], scope: 'individual', sensitive: true,
      },
      {
        observation_id: 'O_PLAN', child_ids: ['C01'], activity: '블록 놀이',
        text: '다음 놀이에 C01에게 다양한 크기의 블록을 제공할 예정이다.',
        observation_type: ['지원 계획'], scope: 'individual', sensitive: false,
      },
      {
        observation_id: 'O_UNRESOLVED', child_ids: [], activity: '블록 놀이',
        text: '어느 아동인지 확인되지 않은 목소리가 들렸다.',
        observation_type: ['말'], scope: 'unresolved', sensitive: false,
      },
    ],
  };
}

function draftInput() {
  return {
    common_text: '반 전체가 블록 놀이를 했다.',
    records: [
      {
        record_id: 'R_C01', child_id: 'C01', status: '검토중', missing_evidence: false,
        special_notes: [],
        individual_sentences: [
          { text: 'C01이 네모 블록 두 개를 쌓았다.', observation_ids: ['O_C01'], content_kind: '관찰' },
          { text: '다음 놀이에 다양한 크기의 블록을 제공할 예정이다.', observation_ids: ['O_PLAN'], content_kind: '지원 계획' },
        ],
      },
      {
        record_id: 'R_C02', child_id: 'C02', status: '작성중', missing_evidence: false,
        special_notes: [],
        individual_sentences: [
          {
            text: 'C02가 넘어져 오른쪽 무릎이 살짝 까졌다. 흐르는 물로 씻었다.',
            observation_ids: ['O_C02'], content_kind: '관찰',
          },
        ],
      },
      {
        record_id: 'R_C03', child_id: 'C03', status: '검토중', missing_evidence: true,
        special_notes: [], individual_sentences: [],
      },
    ],
  };
}

function context() { return readPrepared(preparedInput(), recordings()); }

test('local preparation requires an explicit privacy check for exactly the selected files', () => {
  for (const privacyVerified of [false, undefined, 'true']) {
    assert.throws(() => readPrepared({ ...preparedInput(), privacyVerified }, recordings()), WritingInputError);
  }
  const mismatches = [
    preparedInput().recordingUris.slice(0, 1),
    [...preparedInput().recordingUris, 'file:///documents/unselected.m4a'],
    [preparedInput().recordingUris[0], preparedInput().recordingUris[0]],
    ['file:///documents/unselected.m4a', preparedInput().recordingUris[1]],
  ];
  for (const recordingUris of mismatches) {
    assert.throws(() => readPrepared({ ...preparedInput(), recordingUris }, recordings()), WritingInputError);
  }
});

test('preparation preserves source observation order and accepts non-enum observation types', () => {
  const input = preparedInput();
  input.observations[1].observation_type = ['가상의 교사 확인 유형'];
  const output = readPrepared(input, recordings());
  assert.deepEqual(output.observations.map((row) => row.observation_id), input.observations.map((row) => row.observation_id));
  assert.deepEqual(output.observations[1].observation_type, ['가상의 교사 확인 유형']);
  assert.deepEqual(output.childIds, ['C01', 'C02', 'C03']);
});

test('duplicate observation or child IDs and unresolved observations assigned to a child are invalid', () => {
  const duplicateObservation = preparedInput();
  duplicateObservation.observations[1].observation_id = 'O_COMMON';
  assert.throws(() => readPrepared(duplicateObservation, recordings()), WritingInputError);
  const duplicateChild = preparedInput();
  duplicateChild.childIds.push('C01');
  assert.throws(() => readPrepared(duplicateChild, recordings()), WritingInputError);
  const unresolved = preparedInput();
  unresolved.observations[4].child_ids = ['C01'];
  assert.throws(() => readPrepared(unresolved, recordings()), WritingInputError);
});

test('draft keeps requested child order, common text and only supplied journal sections', () => {
  const output = readDraft(draftInput(), context());
  assert.deepEqual(output.records.map((record) => record.childId), ['C01', 'C02', 'C03']);
  assert.equal(output.commonText, draftInput().common_text);
  assert.deepEqual(output.records[0].sentences.map((sentence) => sentence.contentKind), ['관찰', '지원 계획']);
  assert.doesNotMatch(output.records[0].initialText, /배움 읽기|놀이 지원/);
  assert.equal(output.records[0].confirmedText, null);
  assert.equal(output.records[2].missingEvidence, true);
  assert.equal(output.records[2].editedText, '');
});

test('draft rejects missing, duplicate or out-of-order child records', () => {
  const missing = draftInput();
  missing.records.pop();
  assert.throws(() => readDraft(missing, context()), WritingInputError);
  const reordered = draftInput();
  [reordered.records[0], reordered.records[1]] = [reordered.records[1], reordered.records[0]];
  assert.throws(() => readDraft(reordered, context()), WritingInputError);
  const duplicate = draftInput();
  duplicate.records[1].record_id = duplicate.records[0].record_id;
  assert.throws(() => readDraft(duplicate, context()), WritingInputError);
});

test('an early completed draft or journal special note cannot bypass teacher confirmation', () => {
  const completed = draftInput();
  completed.records[0].status = '완료';
  assert.throws(() => readDraft(completed, context()), WritingInputError);
  const withNotes = draftInput();
  const supplied = { ...withNotes.records[1], special_notes: [{ text: 'C02의 가상 부상 관찰', sensitive: true }] };
  assert.throws(() => readDraft({ ...withNotes, records: [withNotes.records[0], supplied, withNotes.records[2]] }, context()), WritingInputError);
});

test('individual sentences reject unselected, unresolved or another child observation IDs', () => {
  for (const observationIds of [['O_NOT_SELECTED'], ['O_UNRESOLVED'], ['O_C02'], []]) {
    const input = draftInput();
    input.records[0].individual_sentences[0].observation_ids = observationIds;
    assert.throws(() => readDraft(input, context()), WritingInputError);
  }
});

test('common evidence must concern the sentence child even when individual evidence is also present', () => {
  const inputContext = context();
  inputContext.observations[0].child_ids = ['C02', 'C03'];
  const input = draftInput();
  input.records[0].individual_sentences[0].observation_ids = ['O_COMMON', 'O_C01'];
  assert.throws(() => readDraft(input, inputContext), WritingInputError);
});

test('common-only children remain missing evidence and never receive individual prose', () => {
  const wrongFlag = draftInput();
  wrongFlag.records[2].missing_evidence = false;
  assert.throws(() => readDraft(wrongFlag, context()), WritingInputError);
  const fabricated = draftInput();
  fabricated.records[2].individual_sentences.push({
    text: 'C03도 블록을 높이 쌓았다.', observation_ids: ['O_COMMON'], content_kind: '관찰',
  });
  assert.throws(() => readDraft(fabricated, context()), WritingInputError);
  const commonOnly = draftInput();
  commonOnly.records[0].individual_sentences[0].observation_ids = ['O_COMMON'];
  assert.throws(() => readDraft(commonOnly, context()), WritingInputError);
});

test('blank sentence or unknown journal section is invalid without inventing replacements', () => {
  const blank = draftInput();
  blank.records[0].individual_sentences[0].text = ' \r\n\t';
  assert.throws(() => readDraft(blank, context()), WritingInputError);
  const unknown = draftInput();
  unknown.records[0].individual_sentences[0].content_kind = '발달 진단';
  assert.throws(() => readDraft(unknown, context()), WritingInputError);
});

test('revision candidate preserves text and whitespace but cannot be blank or a raw string', () => {
  const text = '  C01은 네모 블록 두 개를 쌓았다.\r\n\n';
  assert.equal(readCandidate({ text }), text);
  for (const value of [null, text, { text: '' }, { text: ' \t\n' }]) {
    assert.throws(() => readCandidate(value), WritingInputError);
  }
});

test('confirmation accepts the canonical status response without requiring new echoed fields', () => {
  assert.doesNotThrow(() => requireConfirmed({ status: '완료' }));
  for (const value of [null, undefined, {}, { status: '검토중' }, { status: 'done' }, { success: true }]) {
    assert.throws(() => requireConfirmed(value), WritingInputError);
  }
});

test('sparse arrays cannot bypass required recording, child, observation or sentence validation', () => {
  for (const field of ['recordingUris', 'childIds', 'observations']) {
    assert.throws(() => readPrepared({ ...preparedInput(), [field]: Array(1) }, recordings()), WritingInputError);
  }
  for (const field of ['child_ids', 'observation_type']) {
    const input = preparedInput();
    input.observations[1] = { ...input.observations[1], [field]: Array(1) };
    assert.throws(() => readPrepared(input, recordings()), WritingInputError);
  }
  assert.throws(() => readDraft({ ...draftInput(), records: Array(3) }, context()), WritingInputError);
  const sparseSentences = draftInput();
  sparseSentences.records[0].individual_sentences = Array(1);
  assert.throws(() => readDraft(sparseSentences, context()), WritingInputError);
  const sparseEvidence = draftInput();
  sparseEvidence.records[0].individual_sentences[0].observation_ids = Array(1);
  assert.throws(() => readDraft(sparseEvidence, context()), WritingInputError);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function writingFixture() {
  const calls = {
    prepare: 0, generate: [] as DraftRequest[],
    revise: [] as { input: Parameters<NonNullable<JournalWorkflow['revise']>>[0]; signal: AbortSignal }[],
    confirm: [] as { recordId: string; input: { edited_text: string } }[], share: [] as string[],
  };
  let confirmationFailure: Error | null = null;
  let confirmationResult: unknown = { status: '완료' };
  let confirmationWait: Promise<unknown> | null = null;
  let revisionWait: Promise<unknown> | null = null;
  let revisionResult: unknown = { text: 'C01이 네모 블록 두 개를 쌓았다.' };
  let shareResult: 'opened' | 'dismissed' = 'opened';
  let shareFailure = false;
  let preparationResult: unknown = preparedInput();
  const files: RecordingLibrary = {
    available: true,
    async list() { return recordings(); },
    async validate() {},
    async remove() { throw new Error('Writing must not delete the source audio'); },
  };
  const services: WritingServices = {
    workflow: {
      async prepare() { calls.prepare += 1; return preparationResult; },
      async generate(input) { calls.generate.push(input); return draftInput(); },
      async revise(input, signal) {
        calls.revise.push({ input, signal });
        return revisionWait ? await revisionWait : revisionResult;
      },
    },
    confirmation: {
      async confirm(recordId, input) {
        calls.confirm.push({ recordId, input });
        if (confirmationWait) return await confirmationWait;
        if (confirmationFailure) throw confirmationFailure;
        return confirmationResult;
      },
    },
    sharing: {
      async share(text) {
        calls.share.push(text);
        if (shareFailure) throw new Error('OS share unavailable');
        return shareResult;
      },
    },
  };
  const controller = createWritingController(files, services);
  // Existing contract cases explicitly choose the supported document type.
  controller.selectRecordType('관찰일지');
  return {
    controller, calls,
    setConfirmationFailure(value: Error | null) { confirmationFailure = value; },
    setConfirmationResult(value: unknown) { confirmationResult = value; },
    setConfirmationWait(value: Promise<unknown>) { confirmationWait = value; },
    setRevisionWait(value: Promise<unknown>) { revisionWait = value; },
    setRevisionResult(value: unknown) { revisionResult = value; },
    setShareResult(value: 'opened' | 'dismissed') { shareResult = value; },
    setShareFailure() { shareFailure = true; },
    setPreparation(value: unknown) { preparationResult = value; },
  };
}

async function importFiles(controller: WritingController) {
  await controller.openPicker();
  for (const file of recordings()) controller.toggleRecording(file.uri);
  await controller.importRecordings();
}

async function generateDraft(controller: WritingController) {
  controller.selectRecordType('관찰일지');
  await importFiles(controller);
  controller.generate();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (controller.getSnapshot().phase === 'idle') break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.ok(controller.getSnapshot().draft, controller.getSnapshot().notice ?? 'Draft missing');
}

function journal(controller: WritingController, recordId = 'R_C01') {
  const record = controller.getSnapshot().draft?.records.find((entry) => entry.recordId === recordId);
  assert.ok(record);
  return record;
}

test('generation sends only canonical observation IDs after local privacy verification', async () => {
  const f = writingFixture();
  await generateDraft(f.controller);
  assert.deepEqual(f.calls.generate, [{
    record_type: '관찰일지', child_ids: ['C01', 'C02', 'C03'],
    observation_ids: ['O_COMMON', 'O_C01', 'O_C02', 'O_PLAN'],
  }]);
  assert.equal(f.calls.prepare, 1);
  assert.equal(f.calls.generate[0].observation_ids.some((id) => id.includes('file:///')), false);

  const blocked = writingFixture();
  blocked.setPreparation({ ...preparedInput(), privacyVerified: false });
  await importFiles(blocked.controller);
  blocked.controller.generate();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(blocked.calls.prepare, 1);
  assert.equal(blocked.calls.generate.length, 0);
  assert.equal(blocked.controller.getSnapshot().draft, null);
});

test('teacher confirmation stores the exact current text without revisiting any model path', async () => {
  const f = writingFixture();
  await generateDraft(f.controller);
  const finalText = ' \t관찰\nC01이 네모 블록 두 개를 쌓았다.\r\n\n지원 계획\n다음 놀이에 블록을 제공할 예정이다.\n';
  f.controller.editText(finalText);
  await f.controller.confirm();
  assert.deepEqual(f.calls.confirm, [{ recordId: 'R_C01', input: { edited_text: finalText } }]);
  assert.equal(journal(f.controller).confirmedText, finalText);
  assert.equal(journal(f.controller).editedText, finalText);
  assert.equal(f.calls.prepare, 1);
  assert.equal(f.calls.generate.length, 1);
  assert.equal(f.calls.revise.length, 0);
  assert.equal(f.calls.share.length, 0);
});

test('sharing is per child and passes only that child stored final text', async () => {
  const f = writingFixture();
  await generateDraft(f.controller);
  await f.controller.share();
  assert.deepEqual(f.calls.share, []);
  const firstText = ' C01이 네모 블록 두 개를 쌓았다.\n';
  f.controller.editText(firstText);
  await f.controller.confirm();
  f.controller.selectRecord('R_C02');
  await f.controller.share();
  assert.deepEqual(f.calls.share, []);
  const secondText = '\nC02가 넘어져 오른쪽 무릎이 살짝 까졌다. 흐르는 물로 씻었다.  ';
  f.controller.editText(secondText);
  f.controller.editPrompt('이 가상 요청 문구는 공유하지 않는다.');
  await f.controller.confirm();
  await f.controller.share();
  assert.deepEqual(f.calls.share, [secondText]);
  f.controller.selectRecord('R_C01');
  await f.controller.share();
  assert.deepEqual(f.calls.share, [secondText, firstText]);
  assert.doesNotMatch(f.controller.getSnapshot().notice ?? '', /발송 완료|수신 완료/);
});

test('confirmation failure preserves edits and never enables sharing before a successful retry', async () => {
  const f = writingFixture();
  await generateDraft(f.controller);
  const finalText = '  C01이 네모 블록 두 개를 쌓았다.\n';
  f.controller.editText(finalText);
  f.setConfirmationFailure(new Error('Storage unavailable'));
  await f.controller.confirm();
  assert.equal(journal(f.controller).editedText, finalText);
  assert.equal(journal(f.controller).confirmedText, null);
  await f.controller.share();
  assert.deepEqual(f.calls.share, []);
  f.setConfirmationFailure(null);
  await f.controller.confirm();
  await f.controller.share();
  assert.equal(journal(f.controller).confirmedText, finalText);
  assert.deepEqual(f.calls.share, [finalText]);
  assert.equal(f.calls.prepare, 1);
  assert.equal(f.calls.generate.length, 1);
  assert.equal(f.calls.revise.length, 0);
});

test('a response that does not confirm completion cannot enable sharing', async () => {
  const f = writingFixture();
  await generateDraft(f.controller);
  for (const response of [{ status: '검토중' }, { success: true }, undefined]) {
    f.setConfirmationResult(response);
    await f.controller.confirm();
    assert.equal(journal(f.controller).confirmedText, null);
    await f.controller.share();
    assert.deepEqual(f.calls.share, []);
  }
});

test('pending confirmation locks edits, child switching, duplicate confirmation and sharing', async () => {
  const f = writingFixture();
  await generateDraft(f.controller);
  const finalText = 'C01이 네모 블록 두 개를 쌓았다.\n';
  f.controller.editText(finalText);
  const waiting = deferred<unknown>();
  f.setConfirmationWait(waiting.promise);
  const confirming = f.controller.confirm();
  assert.equal(f.controller.getSnapshot().phase, 'confirming');
  f.controller.editText('저장 대기 중에 다른 글로 바꾸려는 시도');
  f.controller.editPrompt('저장 중 요청');
  f.controller.selectRecord('R_C02');
  await f.controller.confirm();
  await f.controller.share();
  assert.equal(f.calls.confirm.length, 1);
  assert.equal(journal(f.controller).editedText, finalText);
  assert.equal(journal(f.controller).prompt, '');
  assert.equal(f.controller.getSnapshot().activeRecordId, 'R_C01');
  assert.deepEqual(f.calls.share, []);
  waiting.resolve({ status: '완료' });
  await confirming;
  assert.equal(journal(f.controller).confirmedText, finalText);
});

test('editing even back to the previous wording requires another confirmation before sharing', async () => {
  const f = writingFixture();
  await generateDraft(f.controller);
  const confirmed = 'C01이 네모 블록 두 개를 쌓았다.';
  f.controller.editText(confirmed);
  await f.controller.confirm();
  f.controller.editText('관찰: ' + confirmed);
  await f.controller.share();
  assert.equal(journal(f.controller).confirmedText, null);
  f.controller.editText(confirmed);
  await f.controller.share();
  assert.deepEqual(f.calls.share, []);
  await f.controller.confirm();
  await f.controller.share();
  assert.equal(f.calls.confirm.length, 2);
  assert.deepEqual(f.calls.share, [confirmed]);
});

test('a late revision cannot overwrite newer teacher edits or create an applicable candidate', async () => {
  const f = writingFixture();
  await generateDraft(f.controller);
  const otherChild = journal(f.controller, 'R_C02').editedText;
  const waiting = deferred<unknown>();
  f.setRevisionWait(waiting.promise);
  f.controller.editPrompt('관찰 사실을 유지하고 문장을 간결하게 바꿔줘.');
  const revising = f.controller.revise();
  assert.equal(f.controller.getSnapshot().phase, 'revising');
  const newer = '교사가 직접 정리한 글: C01은 네모 블록 두 개를 쌓았다.\n';
  f.controller.editText(newer);
  assert.equal(f.calls.revise[0].signal.aborted, true);
  waiting.resolve({ text: '늦게 도착한 C01의 가상 수정 제안' });
  await revising;
  f.controller.applyCandidate();
  assert.equal(journal(f.controller).editedText, newer);
  assert.equal(journal(f.controller).candidate, null);
  assert.equal(journal(f.controller, 'R_C02').editedText, otherChild);
  assert.equal(f.calls.revise[0].input.childId, 'C01');
  assert.deepEqual(f.calls.revise[0].input.observationIds, ['O_C01', 'O_PLAN']);
});

test('revision stays a proposal until explicit apply and application invalidates confirmation', async () => {
  const f = writingFixture();
  await generateDraft(f.controller);
  const previous = journal(f.controller).editedText;
  const otherChild = journal(f.controller, 'R_C02').editedText;
  await f.controller.confirm();
  f.controller.editPrompt('관찰 내용은 유지하고 간결하게 써줘.');
  const candidateText = '  C01은 네모 블록 두 개를 쌓았다.\n다음 놀이에 블록을 제공할 예정이다.\n';
  f.setRevisionResult({ text: candidateText });
  await f.controller.revise();
  assert.equal(journal(f.controller).editedText, previous);
  assert.equal(journal(f.controller).candidate?.text, candidateText);
  await f.controller.share();
  assert.deepEqual(f.calls.share, []);
  f.controller.applyCandidate();
  assert.equal(journal(f.controller).editedText, candidateText);
  assert.equal(journal(f.controller).confirmedText, null);
  assert.equal(journal(f.controller, 'R_C02').editedText, otherChild);
  await f.controller.share();
  assert.deepEqual(f.calls.share, []);
});

test('share dismissal and OS failure preserve the exact confirmed record', async () => {
  const f = writingFixture();
  await generateDraft(f.controller);
  const finalText = '  C01이 네모 블록 두 개를 쌓았다.\n';
  f.controller.editText(finalText);
  await f.controller.confirm();
  f.setShareResult('dismissed');
  await f.controller.share();
  assert.match(f.controller.getSnapshot().notice ?? '', /취소/);
  assert.equal(journal(f.controller).confirmedText, finalText);
  f.setShareFailure();
  await f.controller.share();
  assert.match(f.controller.getSnapshot().notice ?? '', /열지 못/);
  assert.equal(journal(f.controller).confirmedText, finalText);
  assert.deepEqual(f.calls.share, [finalText, finalText]);
});

test('an in-memory confirmation source exposes only successfully saved final text through library loaders', async () => {
  // This fake source verifies the FE boundary; it provides no database or persistence.
  const stored = new Map<string, JournalDetail>();
  let storageFailure = true;
  let generations = 0;
  const journals: JournalSource = {
    async list() { return [...stored.values()]; },
    async get(recordId) { return stored.get(recordId); },
  };
  const files: RecordingLibrary = {
    available: true,
    async list() { return recordings(); },
    async validate() {},
    async remove() { throw new Error('Source audio must be preserved'); },
  };
  const controller = createWritingController(files, {
    workflow: {
      async prepare() { return preparedInput(); },
      async generate() { generations += 1; return draftInput(); },
    },
    confirmation: {
      async confirm(recordId, input) {
        if (storageFailure) throw new Error('Fake storage failure');
        const selected = draftInput().records.find((record) => record.record_id === recordId);
        assert.ok(selected);
        stored.set(recordId, {
          recordId, childId: selected.child_id, recordType: '관찰일지', status: '완료',
          finalText: input.edited_text,
        });
        return { status: '완료' };
      },
    },
    journals,
  });
  await generateDraft(controller);
  let list = await loadJournalList(journals);
  assert.equal(list.status, 'ready');
  if (list.status !== 'ready') throw new Error('Expected a connected fake list');
  assert.deepEqual(list.data, []); // Generated drafts are not completed library records.

  const finalText = '  관찰\r\nC01이 네모 블록 두 개를 쌓았다.\n\n지원 계획\n다음 놀이에 블록을 제공할 예정이다.\n\t';
  controller.editText(finalText);
  await controller.confirm();
  assert.equal(stored.size, 0);
  list = await loadJournalList(journals);
  assert.equal(list.status, 'ready');
  if (list.status === 'ready') assert.deepEqual(list.data, []);

  storageFailure = false;
  await controller.confirm();
  list = await loadJournalList(journals);
  assert.equal(list.status, 'ready');
  if (list.status !== 'ready') throw new Error('Expected the confirmed fake list');
  assert.deepEqual(list.data.map((row) => [row.recordId, row.childId]), [['R_C01', 'C01']]);
  const detail = await loadJournalDetail(journals, list.data[0]);
  assert.equal(detail.status, 'ready');
  if (detail.status !== 'ready') throw new Error('Expected the saved fake detail');
  assert.equal(detail.data.finalText, finalText);
  assert.equal(detail.data.dateLabel, undefined);
  assert.equal(detail.data.periodLabel, undefined);

  controller.editText('아직 다시 확정하지 않은 C01의 가상 편집본');
  controller.selectRecord('R_C02');
  const unchanged = await loadJournalDetail(journals, list.data[0]);
  assert.equal(unchanged.status, 'ready');
  if (unchanged.status === 'ready') assert.equal(unchanged.data.finalText, finalText);
  assert.equal(stored.size, 1); // Neither new edits nor another child's draft became saved records.
  assert.equal(generations, 1); // Confirmation and library reads did not regenerate text.
});
