import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, type Api, type Child } from '../src/api/client';
import {
  createRosterController, isTeacherDocumentDirty, type ChildCharacteristicsSource,
} from '../src/roster/controller';
import type { TeacherDocumentKind, TeacherDocumentSource } from '../src/roster/teacherDocuments';

// Reference text is fictional. These adapters do not access a server, AI or storage.
const kinds: TeacherDocumentKind[] = ['writing_examples', 'record_format'];
const child: Child = { child_id: 'C-DEMO', name: '가상 아동', is_active: true };
function api(overrides: Partial<Api> = {}): Api {
  return {
    async login() { throw new Error('unused'); }, async me() { throw new Error('unused'); }, async logout() {},
    async listChildren() { return [child]; },
    async createChild() { throw new Error('Teacher inputs must not create a child'); },
    async renameChild() { throw new Error('Teacher inputs must not rename a child'); },
    async deactivateChild() { throw new Error('Teacher inputs must not deactivate a child'); },
    async deleteChild() {}, ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function fixture(source?: TeacherDocumentSource, overrides: Partial<Api> = {}, childSource?: ChildCharacteristicsSource) {
  const controller = createRosterController(api(overrides), 'fictional-token', () => {}, childSource, source);
  await controller.refresh();
  return controller;
}
type Controller = ReturnType<typeof createRosterController>;
function leaveEditor(controller: Controller) {
  assert.equal(controller.back(), false);
  if (controller.getSnapshot().dialog?.kind === 'leave') controller.resolveDialog('leave');
  assert.equal(controller.getSnapshot().teacherDocumentKind, null);
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
}
async function enter(controller: Controller, kind: TeacherDocumentKind, text: string) {
  await controller.openTeacherDocument(kind);
  controller.changeTeacherDocument(kind, text);
  leaveEditor(controller);
}

test('teacher editors work with an empty roster and after roster lookup failure', async () => {
  for (const failure of [false, true]) {
    const controller = await fixture(undefined, { async listChildren() {
      if (failure) throw new ApiError(0, 'CONNECTION', '가상 명단 연결 실패');
      return [];
    } });
    for (const kind of kinds) {
      await controller.openTeacherDocument(kind);
      assert.equal(controller.getSnapshot().teacherDocumentKind, kind);
      controller.changeTeacherDocument(kind, '가상 교사 자료');
      assert.equal(controller.getSnapshot().teacherDocumentDrafts.get(kind), '가상 교사 자료');
      leaveEditor(controller);
    }
  }
});

test('each lookup uses only its document kind and never invokes the child source or saves', async () => {
  const reads: TeacherDocumentKind[] = [];
  const controller = await fixture({
    async load(kind) { reads.push(kind); return kind === 'writing_examples' ? '  가상 예시\n  ' : '가상 양식'; },
    async save() { throw new Error('No save on entry'); },
  }, {}, {
    async load() { throw new Error('Teacher data must not use child lookup'); },
    async save() { throw new Error('Teacher data must not use child save'); },
  });
  await controller.openTeacherDocument('writing_examples');
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('writing_examples'), '  가상 예시\n  ');
  assert.equal(isTeacherDocumentDirty(controller.getSnapshot(), 'writing_examples'), false);
  leaveEditor(controller);
  await controller.openTeacherDocument('record_format');
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('record_format'), '가상 양식');
  assert.deepEqual(reads, kinds);
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  assert.deepEqual(controller.getSnapshot().items, [child]);
});

test('saving one teacher document preserves other teacher edits and child characteristics', async () => {
  const writes: [TeacherDocumentKind, string][] = [];
  const controller = await fixture({ async load() { return null; }, async save(kind, text) { writes.push([kind, text]); } });
  await enter(controller, 'writing_examples', '  가상 교사 글\n  ');
  await enter(controller, 'record_format', '가상 원 양식');
  await controller.openCharacteristics(child.child_id);
  controller.changeCharacteristics(child.child_id, '가상 아동 특성'); leaveEditor(controller);
  await controller.openTeacherDocument('writing_examples');
  assert.equal(await controller.saveTeacherDocument(), true);
  assert.deepEqual(writes, [['writing_examples', '  가상 교사 글\n  ']]);
  assert.deepEqual(controller.getSnapshot().dialog, { kind: 'saved', teacherKind: 'writing_examples' });
  controller.resolveDialog('dismiss');
  assert.equal(controller.getSnapshot().teacherDocumentKind, 'writing_examples');
  assert.equal(isTeacherDocumentDirty(controller.getSnapshot(), 'writing_examples'), false);
  assert.equal(isTeacherDocumentDirty(controller.getSnapshot(), 'record_format'), true);
  assert.equal(controller.getSnapshot().characteristicsDrafts.get(child.child_id), '가상 아동 특성');
  leaveEditor(controller);
  assert.equal(controller.back(), false); // Other unsaved inputs still guard settings close.
  assert.equal(controller.getSnapshot().dialog?.kind, 'leave');
});

test('failed teacher save survives settings close and reentry until manual retry succeeds', async () => {
  let fail = true;
  const writes: string[] = [];
  const controller = await fixture({
    async load() { return '이전 가상 양식'; },
    async save(_, text) { writes.push(text); if (fail) throw new Error('private failure detail'); },
  });
  await controller.openTeacherDocument('record_format');
  const text = '  가상 양식 수정\n  ';
  controller.changeTeacherDocument('record_format', text);
  assert.equal(await controller.saveTeacherDocument(), false);
  assert.equal(controller.getSnapshot().teacherDocumentEntries.get('record_format')?.savedText, '이전 가상 양식');
  assert.deepEqual(controller.getSnapshot().dialog, { kind: 'saveFailed', teacherKind: 'record_format', unavailable: false });
  controller.resolveDialog('dismiss'); leaveEditor(controller);
  controller.back(); assert.equal(controller.resolveDialog('leave'), 'close');
  await controller.refresh(); await controller.openTeacherDocument('record_format');
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('record_format'), text);
  assert.equal(controller.getSnapshot().teacherDocumentEntries.get('record_format')?.saveState, 'error');
  assert.deepEqual(writes, [text]);
  fail = false;
  assert.equal(await controller.saveTeacherDocument(), true);
  assert.deepEqual(writes, [text, text]);
});

test('failure dialog retries the correct teacher kind once without changing another form', async () => {
  const done = deferred<void>();
  const writes: TeacherDocumentKind[] = [];
  const controller = await fixture({ async load() { return null; }, async save(kind) {
    writes.push(kind); if (writes.length === 1) throw new Error('fictional failure'); await done.promise;
  } });
  await enter(controller, 'record_format', '다른 가상 양식');
  await controller.openTeacherDocument('writing_examples'); controller.changeTeacherDocument('writing_examples', '가상 글');
  await controller.saveTeacherDocument();
  controller.resolveDialog('retry'); controller.resolveDialog('retry');
  assert.deepEqual(writes, ['writing_examples', 'writing_examples']);
  assert.equal(controller.getSnapshot().saving, true);
  done.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(controller.getSnapshot().dialog, { kind: 'saved', teacherKind: 'writing_examples' });
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('record_format'), '다른 가상 양식');
  assert.equal(isTeacherDocumentDirty(controller.getSnapshot(), 'record_format'), true);
});

for (const kind of kinds) {
  test(`default ${kind} connection fails honestly without claiming a successful save`, async () => {
    const controller = await fixture();
    await controller.openTeacherDocument(kind); controller.changeTeacherDocument(kind, '가상 교사 입력');
    assert.equal(await controller.saveTeacherDocument(), false);
    assert.deepEqual(controller.getSnapshot().dialog, { kind: 'saveFailed', teacherKind: kind, unavailable: true });
    assert.equal(controller.getSnapshot().teacherDocumentEntries.get(kind)?.savedText, null);
    assert.equal(isTeacherDocumentDirty(controller.getSnapshot(), kind), true);
    assert.equal(controller.getSnapshot().characteristicsEntries.size, 0);
  });
}

test('teacher save keeps the old baseline while pending and blocks cross-editor actions', async () => {
  const done = deferred<void>();
  let writes = 0;
  const controller = await fixture({ async load() { return '기존 가상 글'; }, async save() { writes++; await done.promise; } });
  await controller.openTeacherDocument('writing_examples'); controller.changeTeacherDocument('writing_examples', '새 가상 글');
  const pending = controller.saveTeacherDocument();
  assert.equal(controller.getSnapshot().teacherDocumentEntries.get('writing_examples')?.savedText, '기존 가상 글');
  controller.changeTeacherDocument('writing_examples', '중복 입력');
  await controller.openTeacherDocument('record_format'); await controller.openCharacteristics(child.child_id);
  assert.equal(controller.requestLogout(), false);
  assert.equal(controller.back(), false);
  assert.equal(await controller.saveTeacherDocument(), false);
  assert.equal(controller.getSnapshot().teacherDocumentKind, 'writing_examples');
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('writing_examples'), '새 가상 글');
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  assert.equal(writes, 1);
  done.resolve(); assert.equal(await pending, true);
});

test('saved teacher content can be cleared with an exact empty string', async () => {
  const writes: string[] = [];
  const controller = await fixture({ async load() { return '기존 가상 글'; }, async save(_, text) { writes.push(text); } });
  await controller.openTeacherDocument('writing_examples'); controller.changeTeacherDocument('writing_examples', '');
  assert.equal(await controller.saveTeacherDocument(), true);
  assert.deepEqual(writes, ['']);
  assert.equal(controller.getSnapshot().teacherDocumentEntries.get('writing_examples')?.savedText, '');
});

test('teacher lookup failures preserve the draft and prevent overwriting an unknown saved baseline', async () => {
  let fail = true;
  let writes = 0;
  const controller = await fixture({
    async load() { if (fail) throw new Error('private lookup detail'); return '기존 가상 양식'; }, async save() { writes++; },
  });
  await controller.openTeacherDocument('record_format'); controller.changeTeacherDocument('record_format', '가상 수정본');
  assert.equal(controller.getSnapshot().teacherDocumentEntries.get('record_format')?.loadState, 'error');
  assert.equal(await controller.saveTeacherDocument(), false);
  assert.equal(writes, 0);
  leaveEditor(controller); fail = false;
  await controller.openTeacherDocument('record_format');
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('record_format'), '가상 수정본');
  assert.equal(controller.getSnapshot().teacherDocumentEntries.get('record_format')?.savedText, '기존 가상 양식');
  assert.equal(await controller.saveTeacherDocument(), true);
});

test('clearing teacher input before initial lookup survives settings close and a restarted lookup', async () => {
  const first = deferred<string | null>();
  let reads = 0;
  const controller = await fixture({ async load() { return ++reads === 1 ? first.promise : '기존 가상 글'; }, async save() {} });
  const opening = controller.openTeacherDocument('writing_examples');
  controller.changeTeacherDocument('writing_examples', '임시 글'); controller.changeTeacherDocument('writing_examples', '');
  assert.equal(isTeacherDocumentDirty(controller.getSnapshot(), 'writing_examples'), true);
  leaveEditor(controller); controller.back(); assert.equal(controller.resolveDialog('leave'), 'close');
  await controller.openTeacherDocument('writing_examples');
  first.resolve('오래된 가상 글'); await opening;
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('writing_examples'), '');
  assert.equal(controller.getSnapshot().teacherDocumentEntries.get('writing_examples')?.savedText, '기존 가상 글');
});

test('roster refresh and child deletion leave teacher input and lookup tickets intact', async () => {
  const load = deferred<string | null>();
  let items = [{ ...child, child_id: 'teacher:writing_examples' }];
  const controller = await fixture({ async load() { return load.promise; }, async save() {} }, {
    async listChildren() { return items; },
  });
  const opening = controller.openTeacherDocument('writing_examples');
  items = []; await controller.refresh();
  load.resolve('가상 교사 글'); await opening;
  assert.equal(controller.getSnapshot().teacherDocumentKind, 'writing_examples');
  assert.equal(controller.getSnapshot().teacherDocumentEntries.get('writing_examples')?.savedText, '가상 교사 글');
  controller.changeTeacherDocument('writing_examples', '가상 수정 글'); leaveEditor(controller);
  items = [{ ...child, child_id: 'teacher:writing_examples' }]; await controller.refresh();
  controller.beginSelection(); controller.toggleSelection('teacher:writing_examples'); controller.requestDelete();
  assert.equal(await controller.deleteSelected(), true);
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('writing_examples'), '가상 수정 글');
});

test('late events from another teacher input kind cannot overwrite the current form', async () => {
  const controller = await fixture();
  await enter(controller, 'writing_examples', '예시 A');
  await controller.openTeacherDocument('record_format'); controller.changeTeacherDocument('record_format', '양식 B');
  controller.changeTeacherDocument('writing_examples', '이전 입력창의 늦은 글');
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('writing_examples'), '예시 A');
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('record_format'), '양식 B');
});

test('teacher-only unsaved exit returns to the same form on stay and confirms logout', async () => {
  const controller = await fixture();
  await controller.openTeacherDocument('record_format'); controller.changeTeacherDocument('record_format', '가상 양식');
  controller.back();
  assert.deepEqual(controller.getSnapshot().dialog, { kind: 'leave', teacherKind: 'record_format', destination: 'roster' });
  controller.resolveDialog('stay');
  assert.equal(controller.getSnapshot().teacherDocumentKind, 'record_format');
  leaveEditor(controller); controller.back();
  assert.deepEqual(controller.getSnapshot().dialog, { kind: 'leave', teacherKind: 'record_format', destination: 'close' });
  controller.resolveDialog('stay');
  assert.equal(controller.getSnapshot().teacherDocumentKind, 'record_format');
  leaveEditor(controller);
  assert.equal(controller.requestLogout(), false);
  assert.deepEqual(controller.getSnapshot().dialog, { kind: 'logout', teacherKind: 'record_format' });
  controller.resolveDialog('stay');
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('record_format'), '가상 양식');
  assert.equal(controller.requestLogout(), false);
  assert.equal(controller.resolveDialog('logout'), 'logout');
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.get('record_format'), '가상 양식');
});

for (const operation of ['load', 'save'] as const) {
  test(`teacher ${operation} 401 clears both teacher forms and child drafts before auth notification`, async () => {
    let reject = false;
    let notifications = 0;
    const failure = () => { throw new ApiError(401, 'INVALID_TOKEN', '가상 만료'); };
    const controller = createRosterController(api(), 'fictional-token', () => {
      notifications++;
      assert.equal(controller.getSnapshot().teacherDocumentDrafts.size, 0);
      assert.equal(controller.getSnapshot().teacherDocumentEntries.size, 0);
      assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
      assert.equal(controller.getSnapshot().dialog, null);
    }, undefined, {
      async load() { if (reject && operation === 'load') failure(); return null; }, async save() { failure(); },
    });
    await controller.refresh(); await enter(controller, 'record_format', '가상 양식');
    await controller.openCharacteristics(child.child_id); controller.changeCharacteristics(child.child_id, '아동 가상 특성'); leaveEditor(controller);
    reject = true; await controller.openTeacherDocument('writing_examples');
    if (operation === 'save') { controller.changeTeacherDocument('writing_examples', '가상 글'); await controller.saveTeacherDocument(); }
    assert.equal(notifications, 1);
    assert.equal(controller.getSnapshot().teacherDocumentKind, null);
  });
}

test('late teacher save after session disposal cannot revive data or affect another account', async () => {
  const done = deferred<void>();
  const controller = await fixture({ async load() { return null; }, async save() { await done.promise; } });
  await controller.openTeacherDocument('writing_examples'); controller.changeTeacherDocument('writing_examples', '이전 교사의 가상 글');
  const pending = controller.saveTeacherDocument(); controller.dispose();
  const other = createRosterController(api(), 'other-fictional-token', () => {});
  await other.refresh(); await other.openTeacherDocument('writing_examples');
  done.resolve(); assert.equal(await pending, false);
  assert.equal(controller.getSnapshot().teacherDocumentDrafts.size, 0);
  assert.equal(controller.getSnapshot().teacherDocumentEntries.size, 0);
  assert.equal(controller.getSnapshot().dialog, null);
  assert.equal(other.getSnapshot().teacherDocumentDrafts.get('writing_examples') ?? '', '');
});
