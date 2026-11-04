import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi, type Api, type Child } from '../src/api/client';
import { createRosterController } from '../src/roster/controller';

// All adapters and names here are fictional; no server or database is contacted.
const children: Child[] = [
  { child_id: 'A', name: '같은 가상 이름', is_active: true },
  { child_id: 'B', name: '같은 가상 이름', is_active: false },
  { child_id: 'C', name: '다른 가상 이름', is_active: true },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function api(overrides: Partial<Api> = {}): Api {
  return {
    async login() { throw new Error('unused'); }, async me() { throw new Error('unused'); }, async logout() {},
    async listChildren() { return children.map(child => ({ ...child })); },
    async createChild(_, name) { return { child_id: 'NEW', name, is_active: true }; },
    async renameChild(_, id, name) { return { child_id: id, name, is_active: true }; },
    async deactivateChild() { throw new Error('Settings must not deactivate children'); },
    async deleteChild() {}, ...overrides,
  };
}
async function fixture(overrides: Partial<Api> = {}) {
  const errors: unknown[] = [];
  const controller = createRosterController(api(overrides), 'fictional-token', error => errors.push(error));
  await controller.refresh();
  return { controller, errors };
}
function choose(controller: ReturnType<typeof createRosterController>, ids: string[]) {
  controller.beginSelection();
  ids.forEach(id => controller.toggleSelection(id));
  controller.requestDelete();
}

test('roster retains every server row and queries without an activity selector', async () => {
  const argumentsSeen: unknown[][] = [];
  const { controller } = await fixture({ async listChildren(...args) { argumentsSeen.push(args); return [...children]; } });
  assert.deepEqual(controller.getSnapshot().items, children);
  assert.deepEqual(argumentsSeen, [['fictional-token']]);
  assert.equal('includeInactive' in controller.getSnapshot(), false);
});

test('deletion requires nonempty selection and confirmation; back cancels one layer at a time', async () => {
  let deletes = 0;
  const { controller } = await fixture({ async deleteChild() { deletes++; } });
  assert.equal(await controller.deleteSelected(), false);
  controller.beginSelection(); controller.requestDelete();
  assert.equal(controller.getSnapshot().confirming, false);
  controller.toggleSelection('unknown');
  assert.deepEqual(controller.getSnapshot().selectedIds, []);
  controller.toggleSelection('A'); controller.requestDelete();
  assert.equal(controller.back(), false);
  assert.equal(controller.getSnapshot().confirming, false);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['A']);
  assert.equal(controller.back(), false);
  assert.equal(controller.getSnapshot().selecting, false);
  assert.deepEqual(controller.getSnapshot().selectedIds, []);
  assert.equal(controller.back(), true);
  assert.equal(deletes, 0);
});

test('selecting blocks creation; a successful fake delete removes only the selected homonym', async () => {
  let creates = 0;
  const deleted: string[] = [];
  const { controller } = await fixture({ async createChild() { creates++; return children[0]; },
    async deleteChild(_, id) { deleted.push(id); } });
  choose(controller, ['A']);
  assert.equal(await controller.create('가상 새 이름'), false);
  assert.equal(await controller.deleteSelected(), true);
  assert.deepEqual(deleted, ['A']);
  assert.deepEqual(controller.getSnapshot().items, [children[1], children[2]]);
  assert.equal(controller.getSnapshot().selecting, false);
  assert.equal(creates, 0);
});

test('refresh during selection prunes missing IDs and reopens confirmation for the changed targets', async () => {
  let latest = [...children];
  const { controller } = await fixture({ async listChildren() { return latest; } });
  choose(controller, ['A', 'B']);
  latest = [children[1], children[2]];
  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().selectedIds, ['B']);
  assert.equal(controller.getSnapshot().selecting, true);
  assert.equal(controller.getSnapshot().confirming, false);
  assert.equal(await controller.deleteSelected(), false); // Reconfirm the remaining targets.
  controller.requestDelete();
  latest = [children[2]];
  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().selectedIds, []);
  assert.equal(controller.getSnapshot().selecting, false);
  assert.equal(controller.getSnapshot().confirming, false);
});

test('failed refresh preserves rows and selected IDs without pretending the list is empty', async () => {
  let fail = false;
  const { controller } = await fixture({ async listChildren() {
    if (fail) throw new ApiError(0, 'CONNECTION', '가상 연결 실패'); return [...children];
  } });
  choose(controller, ['B']);
  fail = true;
  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().items, children);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['B']);
  assert.equal(controller.getSnapshot().loaded, true);
  assert.equal(controller.getSnapshot().loading, false);
  assert.match(controller.getSnapshot().notice!, /실패/);
});

test('batch holds its lock between fake requests and retries only failed IDs', async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const deletes: string[] = [];
  let fail = true;
  let creates = 0;
  let lists = 0;
  const { controller } = await fixture({ async listChildren() { lists++; return [...children]; },
    async createChild() { creates++; return children[0]; },
    async deleteChild(_, id) {
      deletes.push(id);
      if (id === 'A') await first.promise;
      if (id === 'B' && fail) { await second.promise; throw new ApiError(0, 'CONNECTION', '가상 연결 실패'); }
    } });
  choose(controller, ['A', 'B', 'C']);
  const batch = controller.deleteSelected();
  assert.equal(controller.getSnapshot().saving, true);
  assert.equal(controller.back(), false);
  controller.cancelDelete(); controller.cancelSelection(); controller.toggleSelection('B');
  assert.equal(await controller.deleteSelected(), false);
  assert.equal(await controller.create('가상 새 이름'), false);
  await controller.refresh();
  assert.equal(lists, 1);
  assert.deepEqual(deletes, ['A']);
  first.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot().saving, true);
  assert.deepEqual(controller.getSnapshot().items.map(child => child.child_id), ['B', 'C']);
  assert.deepEqual(deletes, ['A', 'B']);
  second.resolve();
  assert.equal(await batch, false);
  assert.equal(creates, 0);
  assert.deepEqual(controller.getSnapshot().items, [children[1]]);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['B']);
  assert.match(controller.getSnapshot().notice!, /2명 삭제.*1명/);
  fail = false; controller.requestDelete();
  assert.equal(await controller.deleteSelected(), true);
  assert.deepEqual(deletes, ['A', 'B', 'C', 'B']);
  assert.deepEqual(controller.getSnapshot().items, []);
});

test('401 stops remaining deletes and preserves failed and unattempted selection', async () => {
  const deletes: string[] = [];
  const { controller, errors } = await fixture({ async deleteChild(_, id) {
    deletes.push(id); if (id === 'B') throw new ApiError(401, 'INVALID_TOKEN', '가상 만료');
  } });
  choose(controller, ['A', 'B', 'C']);
  assert.equal(await controller.deleteSelected(), false);
  assert.deepEqual(deletes, ['A', 'B']);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['B', 'C']);
  assert.deepEqual(controller.getSnapshot().items.map(child => child.child_id), ['B', 'C']);
  assert.equal((errors[0] as ApiError).status, 401);
});

test('unconnected deletion reports 501 once without fetching, deactivating or dropping rows', async () => {
  let requests = 0;
  let deletes = 0;
  const client = createApi('http://localhost:8000', async () => { requests++; throw new Error('No request expected'); });
  const { controller, errors } = await fixture({ async deleteChild(token, id) { deletes++; return client.deleteChild(token, id); } });
  choose(controller, ['A', 'B']);
  assert.equal(await controller.deleteSelected(), false);
  assert.equal(requests, 0);
  assert.equal(deletes, 1);
  assert.deepEqual(controller.getSnapshot().items, children);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['A', 'B']);
  assert.match(controller.getSnapshot().notice!, /서버 연결 준비 중/);
  assert.match(controller.getSnapshot().notice!, /0명 삭제.*2명/);
  assert.deepEqual(errors, []);
});

test('late deletion after disposal cannot mutate state or delete another child', async () => {
  const wait = deferred<void>();
  const deletes: string[] = [];
  const { controller } = await fixture({ async deleteChild(_, id) { deletes.push(id); return wait.promise; } });
  choose(controller, ['A', 'B']);
  const batch = controller.deleteSelected();
  assert.deepEqual(controller.getSnapshot().items, children);
  controller.dispose(); wait.resolve();
  assert.equal(await batch, false);
  assert.deepEqual(deletes, ['A']);
  assert.deepEqual(controller.getSnapshot().items, children);
});

test('blank new names never call the API and creation failure does not alter existing rows', async () => {
  let creates = 0;
  const { controller } = await fixture({ async createChild() { creates++; throw new ApiError(0, 'CONNECTION', '가상 실패'); } });
  assert.equal(await controller.create(' \n\t'), false);
  assert.equal(creates, 0);
  assert.equal(await controller.create('새 가상 이름'), false);
  assert.equal(creates, 1);
  assert.deepEqual(controller.getSnapshot().items, children);
});
