import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, type Api, type Child } from '../src/api/client';
import { createRosterController, isCharacteristicsDirty } from '../src/roster/controller';
import type { ChildCharacteristicsSource } from '../src/roster/characteristics';

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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function fixture(overrides: Partial<Api> = {}, source?: ChildCharacteristicsSource) {
  const controller = createRosterController(adapter(overrides), 'fictional-token', () => {}, source);
  await controller.refresh();
  return controller;
}
type Controller = ReturnType<typeof createRosterController>;
function leaveCharacteristics(controller: Controller) {
  assert.equal(controller.back(), false);
  if (controller.getSnapshot().dialog?.kind === 'leave') controller.resolveDialog('leave');
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
}
async function enter(controller: Controller, id: string, text: string) {
  await controller.openCharacteristics(id);
  assert.equal(controller.getSnapshot().characteristicsChildId, id);
  controller.changeCharacteristics(id, text);
  leaveCharacteristics(controller);
}

test('only loaded roster IDs open; entry and editing make no requests or change server children', async () => {
  const calls: unknown[][] = [];
  const controller = createRosterController(adapter({
    async listChildren(...args) { calls.push(['list', ...args]); return [...children]; },
    async createChild(...args) { calls.push(['create', ...args]); return { child_id: 'NEW', name: args[1], is_active: true }; },
  }), 'fictional-token', () => {});
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', 'not attached');
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  await controller.refresh();
  controller.openCharacteristics('missing');
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  await enter(controller, 'A', '  가상 특성\n줄바꿈 유지  ');
  assert.deepEqual(calls, [['list', 'fictional-token']]);
  assert.deepEqual(controller.getSnapshot().items, children);
  assert.equal(await controller.create('가상 새 아동'), true);
  assert.equal(controller.getSnapshot().characteristicsChildId, null); // Adding does not navigate.
  await enter(controller, 'NEW', '새 아동 가상 메모');
  assert.deepEqual(calls, [['list', 'fictional-token'], ['create', 'fictional-token', '가상 새 아동']]);
  assert.deepEqual(controller.getSnapshot().items.map(child => Object.keys(child).sort()),
    Array.from({ length: 3 }, () => ['child_id', 'is_active', 'name']));
});

test('homonyms keep distinct drafts; back and reentry preserve exact text including empty input', async () => {
  const controller = await fixture();
  const text = '  좋아하는 가상 놀이\n표현 방식\n  ';
  await enter(controller, 'A', text);
  await controller.openCharacteristics('B');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('B'), undefined);
  controller.changeCharacteristics('B', '다른 가상 메모'); leaveCharacteristics(controller);
  await controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), text);
  controller.changeCharacteristics('A', ' \n ');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), ' \n ');
  controller.changeCharacteristics('A', '');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('B'), '다른 가상 메모');
  assert.deepEqual(controller.getSnapshot().items, children);
});

test('closing settings retains drafts until session disposal; other sessions start empty', async () => {
  const controller = await fixture();
  await enter(controller, 'A', '임시 가상 메모');
  assert.equal(controller.back(), false);
  assert.equal(controller.getSnapshot().dialog?.kind, 'leave');
  assert.equal(controller.resolveDialog('leave'), 'close');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '임시 가상 메모');
  await enter(controller, 'A', '다시 쓴 가상 메모');
  controller.dispose();
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', 'late edit');
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
  await enter(controller, 'A', '메모 A'); await enter(controller, 'B', '메모 B');
  await controller.openCharacteristics('A');
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
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', '가상 메모');
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
  await enter(controller, 'A', '메모 A'); await enter(controller, 'B', '메모 B');
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
  controller.beginSelection(); await controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  controller.cancelSelection();
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', '원래 메모');
  controller.beginSelection();
  assert.equal(controller.getSnapshot().selecting, false);
  assert.equal(await controller.create('가상 새 아동'), false);
  loading = true; const refreshing = controller.refresh();
  controller.openCharacteristics('B'); controller.changeCharacteristics('A', 'blocked edit');
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '원래 메모');
  load.resolve([...children]); await refreshing;
  leaveCharacteristics(controller);
  const saving = controller.create('가상 새 아동');
  await controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
  create.resolve({ child_id: 'NEW', name: '가상 새 아동', is_active: true }); await saving;
  await controller.openCharacteristics('A');
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
    await enter(controller, 'A', '가상 메모');
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
  await enter(controller, 'A', '가상 메모');
  delay = true; const pending = controller.refresh();
  controller.dispose(); load.resolve([...children]); await pending;
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
});

test('a delayed input event from a previous child cannot overwrite the current homonym', async () => {
  const controller = await fixture();
  await enter(controller, 'A', '메모 A');
  await controller.openCharacteristics('B'); controller.changeCharacteristics('B', '메모 B');
  controller.changeCharacteristics('A', '지연된 이전 아동 입력');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '메모 A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('B'), '메모 B');
  leaveCharacteristics(controller); controller.changeCharacteristics('B', '명단 복귀 후 지연된 입력');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('B'), '메모 B');
});

test('connected lookup displays exact saved text without saving; a blank edit can clear it', async () => {
  const original = '  기존 가상 특성\n줄바꿈  ';
  const writes: [string, string][] = [];
  const controller = await fixture({}, {
    async load() { return original; }, async save(id, text) { writes.push([id, text]); },
  });
  await controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, original);
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), original);
  assert.equal(isCharacteristicsDirty(controller.getSnapshot(), 'A'), false);
  assert.equal(await controller.saveCharacteristics(), false);
  assert.deepEqual(writes, []);
  controller.changeCharacteristics('A', '');
  assert.equal(isCharacteristicsDirty(controller.getSnapshot(), 'A'), true);
  assert.equal(await controller.saveCharacteristics(), true);
  assert.deepEqual(writes, [['A', '']]);
  assert.equal(controller.getSnapshot().dialog?.kind, 'saved');
  controller.resolveDialog('dismiss');
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, '');
  assert.equal(isCharacteristicsDirty(controller.getSnapshot(), 'A'), false);
  controller.changeCharacteristics('A', '새 가상 특성');
  assert.equal(isCharacteristicsDirty(controller.getSnapshot(), 'A'), true);
});

test('pending explicit save preserves the baseline and locks duplicate actions until success', async () => {
  const done = deferred<void>();
  const writes: [string, string][] = [];
  const controller = await fixture({}, {
    async load() { return '기존 가상 저장본'; },
    async save(id, text) { writes.push([id, text]); await done.promise; },
  });
  await controller.openCharacteristics('A');
  const text = '  교사 가상 입력\n그대로 보존  ';
  controller.changeCharacteristics('A', text);
  const saving = controller.saveCharacteristics();
  assert.equal(controller.getSnapshot().saving, true);
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, '기존 가상 저장본');
  controller.changeCharacteristics('A', '처리 중 덮어쓰기');
  await controller.openCharacteristics('B');
  assert.equal(controller.back(), false);
  assert.equal(controller.requestLogout(), false);
  assert.equal(await controller.create('가상 새 아동'), false);
  assert.equal(await controller.saveCharacteristics(), false);
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), text);
  assert.deepEqual(writes, [['A', text]]);
  done.resolve();
  assert.equal(await saving, true);
  assert.equal(controller.getSnapshot().saving, false);
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, text);
  assert.equal(controller.getSnapshot().dialog?.kind, 'saved');
});

test('failed save keeps baseline and input across closing settings, then retries only on a click', async () => {
  let fail = true;
  const writes: string[] = [];
  const controller = await fixture({}, {
    async load() { return '기존 저장본'; },
    async save(_, text) { writes.push(text); if (fail) throw new Error('private adapter details'); },
  });
  await controller.openCharacteristics('A');
  const text = '  실패해도 남는 가상 입력\n  ';
  controller.changeCharacteristics('A', text);
  assert.equal(await controller.saveCharacteristics(), false);
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, '기존 저장본');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), text);
  assert.equal(controller.getSnapshot().dialog?.kind, 'saveFailed');
  assert.equal(JSON.stringify(controller.getSnapshot().dialog).includes('private adapter details'), false);
  controller.resolveDialog('dismiss');
  leaveCharacteristics(controller);
  assert.equal(controller.back(), false);
  assert.equal(controller.resolveDialog('leave'), 'close');
  await controller.refresh(); await controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), text);
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.saveState, 'error');
  assert.deepEqual(writes, [text]);
  fail = false;
  assert.equal(await controller.saveCharacteristics(), true);
  assert.deepEqual(writes, [text, text]);
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, text);
});

test('failure dialog retry sends the preserved text once and waits for the next response', async () => {
  let attempts = 0;
  const done = deferred<void>();
  const controller = await fixture({}, {
    async load() { return null; },
    async save() { if (++attempts === 1) throw new Error('fictional failure'); await done.promise; },
  });
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', '재시도할 가상 입력');
  await controller.saveCharacteristics();
  controller.resolveDialog('retry'); controller.resolveDialog('retry');
  assert.equal(attempts, 2);
  assert.equal(controller.getSnapshot().saving, true);
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, null);
  done.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot().dialog?.kind, 'saved');
});

test('default source reports unavailable on save and never marks temporary input saved', async () => {
  const controller = await fixture();
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', '임시 가상 특성');
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.loadState, 'unavailable');
  assert.equal(await controller.saveCharacteristics(), false);
  assert.deepEqual(controller.getSnapshot().dialog, { kind: 'saveFailed', childId: 'A', unavailable: true });
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, null);
  assert.equal(isCharacteristicsDirty(controller.getSnapshot(), 'A'), true);
  controller.resolveDialog('dismiss'); leaveCharacteristics(controller);
  controller.back(); controller.resolveDialog('leave');
  await controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '임시 가상 특성');
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.saveState, 'unavailable');
});

test('an empty user edit during loading is not overwritten by a late stored profile', async () => {
  const load = deferred<string | null>();
  const controller = await fixture({}, { async load() { return load.promise; }, async save() {} });
  const opening = controller.openCharacteristics('A');
  controller.changeCharacteristics('A', '');
  assert.equal(await controller.saveCharacteristics(), false);
  load.resolve('이전에 저장한 가상 특성'); await opening;
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '');
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, '이전에 저장한 가상 특성');
  assert.equal(isCharacteristicsDirty(controller.getSnapshot(), 'A'), true);
});

test('failed profile lookup preserves edits, blocks overwrite, and recovers on reentry', async () => {
  let fail = true;
  let writes = 0;
  const controller = await fixture({}, {
    async load() { if (fail) throw new Error('private lookup detail'); return '기존 가상 저장본'; },
    async save() { writes++; },
  });
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', '불러오기 실패 후 가상 입력');
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.loadState, 'error');
  assert.equal(await controller.saveCharacteristics(), false);
  assert.equal(writes, 0);
  leaveCharacteristics(controller); fail = false;
  await controller.openCharacteristics('A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '불러오기 실패 후 가상 입력');
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, '기존 가상 저장본');
  assert.equal(await controller.saveCharacteristics(), true);
  assert.equal(writes, 1);
});

test('malformed lookup is an error rather than an empty saved profile', async () => {
  let writes = 0;
  const controller = await fixture({}, {
    async load() { return { text: 'wrong shape' } as unknown as string; }, async save() { writes++; },
  });
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', '가상 수정');
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.loadState, 'error');
  assert.equal(await controller.saveCharacteristics(), false);
  assert.equal(writes, 0);
});

test('unsaved back and close confirmations can keep writing without losing any child draft', async () => {
  const controller = await fixture();
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', '메모 A');
  assert.equal(controller.back(), false);
  assert.deepEqual(controller.getSnapshot().dialog, { kind: 'leave', childId: 'A', destination: 'roster' });
  controller.resolveDialog('stay');
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
  leaveCharacteristics(controller);
  assert.equal(controller.back(), false);
  assert.equal(controller.getSnapshot().dialog?.kind, 'leave');
  controller.resolveDialog('stay');
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '메모 A');
  leaveCharacteristics(controller);
  assert.equal(controller.requestLogout(), false);
  assert.equal(controller.getSnapshot().dialog?.kind, 'logout');
  controller.resolveDialog('stay');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '메모 A');
  assert.equal(controller.requestLogout(), false);
  assert.equal(controller.resolveDialog('logout'), 'logout');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '메모 A'); // Failed logout may leave this session active.
  controller.dispose();
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
});

test('dialogs prevent background mutations, and Android back dismisses one confirmation layer', async () => {
  const controller = await fixture();
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', '원래 가상 입력');
  controller.back();
  controller.changeCharacteristics('A', '배경의 늦은 수정');
  await controller.openCharacteristics('B');
  controller.beginSelection();
  assert.equal(await controller.saveCharacteristics(), false);
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '원래 가상 입력');
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
  assert.equal(controller.getSnapshot().selecting, false);
  assert.equal(controller.back(), false);
  assert.equal(controller.getSnapshot().dialog, null);
  assert.equal(controller.getSnapshot().characteristicsChildId, 'A');
});

test('late profile loads cannot recreate an entry removed from the roster', async () => {
  const load = deferred<string | null>();
  let latest = [...children];
  const controller = await fixture({ async listChildren() { return latest; } }, {
    async load() { return load.promise; }, async save() {},
  });
  const opening = controller.openCharacteristics('A');
  latest = [children[1]]; await controller.refresh();
  load.resolve('사라진 아동의 가상 특성'); await opening;
  assert.equal(controller.getSnapshot().characteristicsEntries.has('A'), false);
  assert.equal(controller.getSnapshot().characteristicsDrafts.has('A'), false);
  assert.equal(controller.getSnapshot().characteristicsChildId, null);
});

test('closing settings invalidates pending profile reads before the next entry', async () => {
  const old = deferred<string | null>();
  let reads = 0;
  const controller = await fixture({}, {
    async load() { return ++reads === 1 ? old.promise : '최신 가상 저장본'; }, async save() {},
  });
  const opening = controller.openCharacteristics('A');
  leaveCharacteristics(controller);
  assert.equal(controller.back(), true);
  await controller.openCharacteristics('A');
  old.resolve('오래된 가상 저장본'); await opening;
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, '최신 가상 저장본');
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '최신 가상 저장본');
});

for (const operation of ['load', 'save'] as const) {
  test(`profile ${operation} 401 clears all local trait state before notifying auth`, async () => {
    let notifications = 0;
    const rejection = () => { throw new ApiError(401, 'INVALID_TOKEN', '가상 만료'); };
    const controller = createRosterController(adapter(), 'fictional-token', () => {
      notifications++;
      assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
      assert.equal(controller.getSnapshot().characteristicsEntries.size, 0);
      assert.equal(controller.getSnapshot().dialog, null);
    }, {
      async load() { return operation === 'load' ? rejection() : null; }, async save() { rejection(); },
    });
    await controller.refresh(); await controller.openCharacteristics('A');
    if (operation === 'save') { controller.changeCharacteristics('A', '가상 입력'); await controller.saveCharacteristics(); }
    assert.equal(notifications, 1);
    assert.equal(controller.getSnapshot().characteristicsChildId, null);
  });
}

test('session disposal ignores a late save success and cannot leak into a new account', async () => {
  const save = deferred<void>();
  const controller = await fixture({}, { async load() { return null; }, async save() { await save.promise; } });
  await controller.openCharacteristics('A'); controller.changeCharacteristics('A', '이전 계정 가상 입력');
  const pending = controller.saveCharacteristics();
  controller.dispose();
  const next = await fixture();
  save.resolve();
  assert.equal(await pending, false);
  assert.equal(controller.getSnapshot().characteristicsEntries.size, 0);
  assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
  assert.equal(controller.getSnapshot().dialog, null);
  await next.openCharacteristics('A');
  assert.equal(next.getSnapshot().characteristicsEntries.get('A')?.savedText, null);
  assert.equal(next.getSnapshot().characteristicsDrafts.get('A') ?? '', '');
});

test('an explicit empty edit survives closing and reopening before the first lookup completes', async () => {
  const first = deferred<string | null>();
  let reads = 0;
  const controller = await fixture({}, {
    async load() { return ++reads === 1 ? first.promise : '기존 가상 저장본'; }, async save() {},
  });
  const opening = controller.openCharacteristics('A');
  controller.changeCharacteristics('A', '지울 가상 입력'); controller.changeCharacteristics('A', '');
  assert.equal(isCharacteristicsDirty(controller.getSnapshot(), 'A'), true);
  leaveCharacteristics(controller);
  controller.back(); assert.equal(controller.resolveDialog('leave'), 'close');
  await controller.openCharacteristics('A');
  first.resolve('오래된 가상 저장본'); await opening;
  assert.equal(controller.getSnapshot().characteristicsDrafts.get('A'), '');
  assert.equal(controller.getSnapshot().characteristicsEntries.get('A')?.savedText, '기존 가상 저장본');
  assert.equal(isCharacteristicsDirty(controller.getSnapshot(), 'A'), true);
});

test('a known empty profile stays clean when a reentry lookup is pending', async () => {
  const second = deferred<string | null>();
  let reads = 0;
  const controller = await fixture({}, {
    async load() { return ++reads === 1 ? null : second.promise; }, async save() {},
  });
  await controller.openCharacteristics('A'); leaveCharacteristics(controller);
  assert.equal(controller.back(), true);
  const opening = controller.openCharacteristics('A');
  assert.equal(isCharacteristicsDirty(controller.getSnapshot(), 'A'), false);
  second.resolve(null); await opening;
  assert.equal(isCharacteristicsDirty(controller.getSnapshot(), 'A'), false);
});

for (const operation of ['save', 'refresh'] as const) {
  test(`a cross-child lookup 401 invalidates pending ${operation} work and releases its lock`, async () => {
    const read = deferred<string | null>();
    const write = deferred<void>();
    const roster = deferred<Child[]>();
    let rosterReads = 0;
    let expired = 0;
    const controller = createRosterController(adapter({
      async listChildren() { return ++rosterReads === 1 ? [...children] : roster.promise; },
    }), 'fictional-token', () => { expired++; }, {
      async load(id) { return id === 'A' ? read.promise : null; },
      async save() { await write.promise; },
    });
    await controller.refresh();
    const opening = controller.openCharacteristics('A'); leaveCharacteristics(controller);
    let pending: Promise<unknown>;
    if (operation === 'save') {
      await controller.openCharacteristics('B'); controller.changeCharacteristics('B', '가상 입력 B');
      pending = controller.saveCharacteristics();
    } else pending = controller.refresh();
    read.reject(new ApiError(401, 'INVALID_TOKEN', '가상 만료')); await opening;
    assert.equal(expired, 1);
    assert.equal(controller.getSnapshot().saving, false);
    assert.equal(controller.getSnapshot().loading, false);
    write.resolve(); roster.resolve([{ child_id: 'LATE', name: '늦게 온 가상 아동', is_active: true }]);
    await pending;
    assert.equal(controller.getSnapshot().characteristicsEntries.size, 0);
    assert.equal(controller.getSnapshot().characteristicsDrafts.size, 0);
    assert.equal(controller.getSnapshot().dialog, null);
    assert.equal(controller.getSnapshot().items.some(child => child.child_id === 'LATE'), false);
  });
}
