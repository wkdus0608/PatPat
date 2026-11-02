import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingController, type WritingController } from '../src/writing/controller';
import type { RecordingLibrary } from '../src/library/types';
import type { SavedRecording } from '../src/recording/storage';
import type { JournalWorkflow, WritingServices } from '../src/writing/types';

const recordings: SavedRecording[] = [1, 2].map((day) => ({
  uri: `file:///documents/recordings/2026-11-0${day}/2026-11-0${day}_09-10.m4a`,
  fileName: `2026-11-0${day}_09-10.m4a`, dateKey: `2026-11-0${day}`, startTime: '09:10',
}));
const observation = (id: string, child: string, scope = 'individual') => ({
  observation_id: id, child_ids: scope === 'unresolved' ? [] : [child], activity: '가상 블록 놀이',
  text: `${child}이 가상 블록을 쌓음`, observation_type: ['행동'], scope, sensitive: false,
});
const response = () => ({ common_text: '', records: ['C01', 'C02'].map((child, index) => ({
  record_id: `R${index + 1}`, child_id: child, status: '검토중', missing_evidence: false,
  special_notes: [], individual_sentences: [{ text: `${child}이 가상 블록을 쌓았다.`,
    observation_ids: [`O${index + 1}`], content_kind: '관찰' }],
})) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settled(controller: WritingController) {
  for (let count = 0; count < 100; count++) {
    if (controller.getSnapshot().phase === 'idle') return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('operation did not settle');
}
function fixture(overrides: Partial<WritingServices> = {}) {
  let removed = 0;
  let listError = false;
  let generated = 0;
  let prepared = 0;
  const missing = new Set<string>();
  const validated: string[] = [];
  const requests: unknown[] = [];
  const files: RecordingLibrary = {
    available: true,
    async list() { if (listError) throw new Error('private error'); return [...recordings].reverse(); },
    async validate(recording) { validated.push(recording.uri); if (missing.has(recording.uri)) throw new Error('missing file'); },
    async remove() { removed++; },
  };
  const workflow: JournalWorkflow = {
    async prepare(selected) {
      prepared++;
      return { recordingUris: selected.map((row) => row.uri), childIds: ['C01', 'C02'], privacyVerified: true,
        observations: [observation('O1', 'C01'), observation('O2', 'C02')] };
    },
    async generate(input) { generated++; requests.push(input); return response(); },
    async revise() { return { text: '가상 수정 제안' }; },
  };
  const services = { workflow, ...overrides };
  const controller = createWritingController(files, services);
  return { controller, files, services, workflow, missing, validated, requests,
    failList() { listError = true; }, get removed() { return removed; },
    get generated() { return generated; }, get prepared() { return prepared; } };
}
async function select(controller: WritingController, chosen = recordings) {
  await controller.openPicker();
  chosen.forEach((row) => controller.toggleRecording(row.uri));
  await controller.importRecordings();
}
async function draft(controller: WritingController) {
  await select(controller);
  controller.generate();
  await settled(controller);
  assert.ok(controller.getSnapshot().draft);
}

test('real multiselection, picker cancellation and deselection preserve source files', async () => {
  const f = fixture();
  await select(f.controller);
  assert.deepEqual(f.controller.getSnapshot().selected, recordings);
  await f.controller.openPicker();
  f.controller.toggleRecording(recordings[0].uri);
  f.controller.cancelPicker();
  assert.deepEqual(f.controller.getSnapshot().selected, recordings);
  f.controller.removeRecording(recordings[0].uri);
  assert.deepEqual(f.controller.getSnapshot().selected, [recordings[1]]);
  assert.equal(f.removed, 0);
});

test('zero-selection import is blocked and concurrent imports do not duplicate validation', async () => {
  const f = fixture();
  await f.controller.openPicker();
  await f.controller.importRecordings();
  assert.equal(f.controller.getSnapshot().route, 'picker');
  f.controller.toggleRecording(recordings[0].uri);
  await Promise.all([f.controller.importRecordings(), f.controller.importRecordings()]);
  assert.deepEqual(f.validated, [recordings[0].uri]);
  assert.deepEqual(f.controller.getSnapshot().selected, [recordings[0]]);
});

test('a vanished checked file keeps all previous selections instead of silently omitting it', async () => {
  const f = fixture();
  await select(f.controller, [recordings[0]]);
  await f.controller.openPicker();
  f.controller.toggleRecording(recordings[1].uri);
  f.missing.add(recordings[1].uri);
  await f.controller.importRecordings();
  assert.equal(f.controller.getSnapshot().route, 'picker');
  assert.deepEqual(f.controller.getSnapshot().selected, [recordings[0]]);
  assert.ok(f.controller.getSnapshot().notice);
  assert.equal(f.generated, 0);
});

test('unavailable, list failure and empty selection are different states; no fake drafts', async () => {
  const f = fixture({ workflow: undefined });
  await select(f.controller);
  f.controller.generate();
  assert.equal(f.controller.capabilities.generation, false);
  assert.equal(f.controller.getSnapshot().draft, null);
  assert.match(f.controller.getSnapshot().notice!, /연결/);
  f.failList();
  await f.controller.openPicker();
  assert.equal(f.controller.getSnapshot().recordings.status, 'error');
  const web = createWritingController({ ...f.files, available: false });
  await web.openPicker();
  assert.equal(web.getSnapshot().recordings.status, 'unavailable');
  await web.share();
  assert.equal(web.getSnapshot().draft, null);
});

test('replacing recordings requires confirmation and cancellation preserves child edits', async () => {
  const f = fixture();
  await draft(f.controller);
  f.controller.editText('C01 교사 편집');
  f.controller.selectRecord('R2');
  f.controller.editText('C02 교사 편집');
  await f.controller.openPicker();
  f.controller.toggleRecording(recordings[1].uri);
  await f.controller.importRecordings();
  assert.equal(f.controller.getSnapshot().guard?.kind, 'selection');
  f.controller.resolveGuard(false);
  assert.deepEqual(f.controller.getSnapshot().draft?.records.map((row) => row.editedText), ['C01 교사 편집', 'C02 교사 편집']);
  assert.deepEqual(f.controller.getSnapshot().selected, recordings);
  await f.controller.importRecordings();
  f.controller.resolveGuard(true);
  assert.equal(f.controller.getSnapshot().draft, null);
  assert.deepEqual(f.controller.getSnapshot().selected, [recordings[0]]);
  assert.equal(f.removed, 0);
});

test('removing final selected file also guards existing draft without deleting audio', async () => {
  const f = fixture();
  await select(f.controller, [recordings[0]]);
  f.controller.generate(); await settled(f.controller);
  f.controller.removeRecording(recordings[0].uri);
  assert.equal(f.controller.getSnapshot().selected.length, 1);
  f.controller.resolveGuard(true);
  assert.equal(f.controller.getSnapshot().selected.length, 0);
  assert.equal(f.controller.getSnapshot().draft, null);
  assert.equal(f.removed, 0);
});

test('generation rechecks every file and never prepares or generates after validation failure', async () => {
  const f = fixture();
  await select(f.controller);
  f.missing.add(recordings[0].uri);
  f.controller.generate(); await settled(f.controller);
  assert.equal(f.prepared, 0);
  assert.equal(f.generated, 0);
  assert.equal(f.controller.getSnapshot().draft, null);
  assert.equal(f.controller.getSnapshot().selected.length, 2);
});

test('privacy verification failure blocks generate and hides arbitrary adapter error contents', async () => {
  const f = fixture();
  await select(f.controller);
  f.workflow.prepare = async () => ({ privacyVerified: false });
  f.controller.generate(); await settled(f.controller);
  assert.equal(f.generated, 0);
  f.workflow.prepare = async () => { throw new Error('PRIVATE_INPUT_MUST_NOT_APPEAR'); };
  f.controller.generate(); await settled(f.controller);
  assert.doesNotMatch(f.controller.getSnapshot().notice!, /PRIVATE_INPUT/);
});

test('draft request uses only prepared, relevant observation IDs and canonical fields', async () => {
  const f = fixture();
  const prepare = f.workflow.prepare;
  f.workflow.prepare = async (...args) => ({ ...await prepare(...args) as object,
    observations: [observation('O1', 'C01'), observation('O2', 'C02'), observation('OX', '', 'unresolved'), observation('O3', 'C03')] });
  await draft(f.controller);
  assert.deepEqual(f.requests, [{ record_type: '관찰일지', child_ids: ['C01', 'C02'], observation_ids: ['O1', 'O2'] }]);
  assert.equal(JSON.stringify(f.requests).includes('file:///'), false);
});

test('regeneration guards edits, preserves them on failure and blocks duplicate generation', async () => {
  const f = fixture();
  await draft(f.controller);
  f.controller.editText('선생님 수정본');
  f.workflow.generate = async () => { throw new Error('generate failure'); };
  f.controller.generate();
  assert.equal(f.controller.getSnapshot().guard?.kind, 'regenerate');
  f.controller.resolveGuard(false);
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, '선생님 수정본');
  f.controller.generate(); f.controller.resolveGuard(true);
  f.controller.generate();
  await settled(f.controller);
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, '선생님 수정본');
});

test('abandoning delayed local preparation prevents all later generation', async () => {
  const f = fixture();
  await select(f.controller);
  const preparation = deferred<unknown>();
  const original = f.workflow.prepare;
  f.workflow.prepare = async () => preparation.promise;
  f.controller.generate();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const leaving = f.controller.leave();
  f.controller.resolveGuard(true);
  assert.equal(await leaving, true);
  preparation.resolve(await original(recordings, new AbortController().signal));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.generated, 0);
  assert.equal(f.controller.getSnapshot().draft, null);
});

test('abandoned generation ignores late response; canceled leave keeps operation alive', async () => {
  const f = fixture();
  await select(f.controller);
  const pending = deferred<unknown>();
  f.workflow.generate = async () => pending.promise;
  f.controller.generate();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stay = f.controller.leave();
  f.controller.resolveGuard(false);
  assert.equal(await stay, false);
  assert.equal(f.controller.getSnapshot().phase, 'generating');
  const leave = f.controller.leave();
  f.controller.resolveGuard(true);
  assert.equal(await leave, true);
  pending.resolve(response());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.controller.getSnapshot().draft, null);
  assert.equal(f.controller.getSnapshot().selected.length, 2);
});

test('revision failure, rejection and intervening edits preserve the authoritative body', async () => {
  const f = fixture();
  await draft(f.controller);
  f.controller.editPrompt('간결하게 수정');
  f.workflow.revise = async () => { throw new Error('revision failure'); };
  const before = f.controller.getSnapshot().draft!.records[0].editedText;
  await f.controller.revise();
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, before);
  assert.equal(f.controller.getSnapshot().draft!.records[0].prompt, '간결하게 수정');
  f.workflow.revise = async () => ({ text: '새 후보' });
  await f.controller.revise();
  f.controller.dismissCandidate();
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, before);
  await f.controller.revise();
  f.controller.editText('직접 고친 최신 본문');
  f.controller.applyCandidate();
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, '직접 고친 최신 본문');
});

test('ordinary tab leave keeps editing and pending picker selection; dispose settles guards', async () => {
  const f = fixture();
  await draft(f.controller);
  f.controller.editText('아직 확정하지 않은 편집');
  assert.equal(await f.controller.leave(), true);
  assert.equal(f.controller.getSnapshot().draft!.records[0].editedText, '아직 확정하지 않은 편집');
  const pending = deferred<unknown>();
  f.workflow.revise = async () => pending.promise;
  f.controller.editPrompt('문장 다듬기');
  const revision = f.controller.revise();
  const leaving = f.controller.leave();
  f.controller.dispose();
  assert.equal(await leaving, false);
  pending.resolve({ text: '폐기된 후보' });
  await revision;
  assert.equal(f.controller.getSnapshot().draft!.records[0].candidate, null);
});
