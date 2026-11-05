import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, type Api, type Child } from '../src/api/client';
import { createRosterController } from '../src/roster/controller';

// Fictional children and local adapters only; these drafts never leave the FE.
const children: Child[] = [
  { child_id: 'A', name: '같은 가상 이름', is_active: true },
  { child_id: 'B', name: '같은 가상 이름', is_active: true },
];
function adapter(overrides: Partial<Api> = {}): Api {
  return {
    async login() { throw new Error('unused'); }, async me() { throw new Error('unused'); }, async logout() {},
    async listChildren() { return [...children]; },
    async createChild(_, name) { return { child_id: 'NEW', name, is_active: true }; },
    async renameChild() { throw new Error('No rename expected'); },
    async deactivateChild() { throw new Error('No deactivation expected'); },
    async deleteChild() {}, ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(overrides: Partial<Api> = {}) {
  const controller = createRosterController(adapter(overrides), 'fictional-token', () => {});
  await controller.refresh();
  return controller;
}
type Controller = ReturnType<typeof createRosterController>;
function enter(controller: Controller, id: string, text: string) {
  controller.openCharacteristics(id);
  assert.equal(controller.getSnapshot().characteristicsChildId, id);
  controller.changeCharacteristics(id, text);
  assert.equal(controller.back(), false);
}

test('only loaded roster IDs open; entry and editing make no requests or change server children', async () => {
  const calls: unknown[][] = [];
  const controller = createRosterController(adapter({
    async listChildren(...args) { calls.push(['list', ...args]); return [...children]; },
    async createChild(...args) { calls.push(['create', ...args]); return { child_id: 'NEW', name: args[1], is_active: true }; },
  }), 'fictional-token', () => {});
  controller.openCharacteristics('A'); controller.changeCharacteristics('A', 'not attached');
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  await controller.refresh();
  controller.openCharacteristics('missing');
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  enter(controller, 'A', '  가상 특성\n줄바꿈 유지  ');
  assert.deepEqual(calls, [['list', 'fictional-token']]);
  assert.deepEqual(controller.getSnapshot().items, children);
  assert.equal(await controller.create('가상 새 아동'), true);
  assert.equal(controller.getSnapshot().characteristicsChildId, null); // Adding does not navigate.
  enter(controller, 'NEW', '새 아동 가상 메모');
  assert.deepEqual(calls, [['list', 'fictional-token'], ['create', 'fictional-token', '가상 새 아동']]);
  assert.deepEqual(controller.getSnapshot().items.map(child => Object.keys(child).sort()),
    Array.from({ length: 3 }, () => ['child_id', 'is_active', 'name']));
});

test('homonyms keep distinct drafts; back and reentry preserve exact text including empty input', async () => {
  const controller = await fixture();
  const text = '  좋아하는 가상 놀이\n표현 방식\n  ';
  enter(controller, 'A', text);
  controller.openCharacteristics('B');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('B'), undefined);
  controller.changeCharacteristics('B', '다른 가상 메모'); controller.back();
  controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), text);
  controller.changeCharacteristics('A', ' \n ');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), ' \n ');
  controller.changeCharacteristics('A', '');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('B'), '다른 가상 메모');
  assert.deepEqual(controller.getSnapshot().items, children);
});

test('closing settings clears drafts, disposal clears drafts, and other sessions start empty', async () => {
  const controller = await fixture();
  enter(controller, 'A', '임시 가상 메모');
  assert.equal(controller.back(), true);
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  enter(controller, 'A', '다시 쓴 가상 메모');
  controller.dispose();
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  controller.openCharacteristics('A'); controller.changeCharacteristics('A', 'late edit');
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  await controller.refresh(); // Effect setup can reuse the controller after cleanup.
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  const other = createRosterController(adapter(), 'another-fictional-token', () => {});
  await other.refresh();
  other.openCharacteristics('A');
  assert.equal(other.getSnapshot().characteristicsDrafts.size, 0);
});

test('successful refresh retains existing IDs and removes missing drafts and the missing active screen', async () => {
  let latest = [...children];
  const controller = await fixture({ async listChildren() { return latest; } });
  enter(controller, 'A', '메모 A'); enter(controller, 'B', '메모 B');
  controller.openCharacteristics('A');
  latest = [{ ...children[0], name: '변경된 가상 이름' }, children[1]];
  await controller.refresh();
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '메모 A');
  latest = [children[1]];
  await controller.refresh();
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  assert.deepEqual([...controller.getSnapshot().characteristicsDrafts], [['B', '메모 B']]);
});

test('failed refresh preserves current child and drafts until a successful list is received', async () => {
  let fail = false;
  const controller = await fixture({ async listChildren() {
    if (fail) throw new ApiError(0, 'CONNECTION', '가상 연결 실패');
    return [...children];
  } });
  controller.openCharacteristics('A'); controller.changeCharacteristics('A', '가상 메모');
  fail = true; await controller.refresh();
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '가상 메모');
  assert.deepEqual(controller.getSnapshot().items, children);
});

test('partial deletion removes only successful child drafts and preserves failed ones for retry', async () => {
  let fail = true;
  const controller = await fixture({ async deleteChild(_, id) {
    if (id === 'B' && fail) throw new ApiError(0, 'CONNECTION', '가상 연결 실패');
  } });
  enter(controller, 'A', '메모 A'); enter(controller, 'B', '메모 B');
  controller.beginSelection(); controller.toggleSelection('A'); controller.toggleSelection('B');
  controller.requestDelete();
  assert.equal(await controller.deleteSelected(), false);
  assert.deepEqual([...controller.getSnapshot().characteristicsDrafts], [['B', '메모 B']]);
  assert.deepEqual(controller.getSnapshot().items, [children[1]]);
  fail = false; controller.requestDelete();
  assert.equal(await controller.deleteSelected(), true);
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
});

test('selection, loading and saving block entry; editing cannot mutate drafts during refresh', async () => {
  const load = deferred<Child[]>();
  const create = deferred<Child>();
  let loading = false;
  const controller = await fixture({
    async listChildren() { return loading ? load.promise : [...children]; },
    async createChild() { return create.promise; },
  });
  controller.beginSelection(); controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  controller.cancelSelection();
  controller.openCharacteristics('A'); controller.changeCharacteristics('A', '원래 메모');
  controller.beginSelection();
  assert.equal(controller.getSnapshot().selecting, false);
  assert.equal(await controller.create('가상 새 아동'), false);
  loading = true; const refreshing = controller.refresh();
  controller.openCharacteristics('B'); controller.changeCharacteristics('A', 'blocked edit');
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '원래 메모');
  load.resolve([...children]); await refreshing;
  controller.back();
  const saving = controller.create('가상 새 아동');
  controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  create.resolve({ child_id: 'NEW', name: '가상 새 아동', is_active: true }); await saving;
  controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
});

for (const operation of ['refresh', 'create', 'delete'] as const) {
  test(`401 from ${operation} clears traits before notifying auth`, async () => {
    let expired = false;
    let notifications = 0;
    const rejection = () => { throw new ApiError(401, 'INVALID_TOKEN', '가상 만료'); };
    const controller = createRosterController(adapter({
      async listChildren() { if (expired && operation === 'refresh') rejection(); return [...children]; },
      async createChild() { return rejection(); },
      async deleteChild() { rejection(); },
    }), 'fictional-token', () => {
      notifications++;
      assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
      assert.equal(controller.getSnapshot().characteristicsChildId, null);
    });
    await controller.refresh();
    enter(controller, 'A', '가상 메모');
    expired = true;
    if (operation === 'refresh') { controller.openCharacteristics('A'); await controller.refresh(); }
    if (operation === 'create') await controller.create('가상 새 아동');
    if (operation === 'delete') {
      controller.beginSelection(); controller.toggleSelection('A'); controller.requestDelete();
      await controller.deleteSelected();
    }
    assert.equal(notifications, 1);
    assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  });
}

test('a pending refresh cannot restore child drafts after settings disposal', async () => {
  const load = deferred<Child[]>();
  let delay = false;
  const controller = await fixture({ async listChildren() { return delay ? load.promise : [...children]; } });
  enter(controller, 'A', '가상 메모');
  delay = true; const pending = controller.refresh();
  controller.dispose(); load.resolve([...children]); await pending;
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
});

test('a delayed input event from a previous child cannot overwrite the current homonym', async () => {
  const controller = await fixture();
  enter(controller, 'A', '메모 A');
  controller.openCharacteristics('B'); controller.changeCharacteristics('B', '메모 B');
  controller.changeCharacteristics('A', '지연된 이전 아동 입력');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '메모 A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('B'), '메모 B');
  controller.back(); controller.changeCharacteristics('B', '명단 복귀 후 지연된 입력');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('B'), '메모 B');
});
