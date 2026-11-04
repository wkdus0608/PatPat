import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi, type Api, type Child } from '../src/api/client';
import { createAuthController, type TokenStore } from '../src/auth/controller';
import { createRosterController } from '../src/roster/controller';

const teacher = { teacher_id: 'fictional-teacher', display_name: '가상 교사' };
const login = { access_token: 'fictional-token', token_type: 'bearer' as const, expires_in: 604800, teacher };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function memory(initial: string | null = null) {
  let token = initial;
  const store: TokenStore = { async read() { return token; }, async write(value) { token = value; }, async clear() { token = null; } };
  return store;
}
function api(overrides: Partial<Api> = {}): Api {
  return { async login() { return login; }, async me() { return teacher; }, async logout() {},
    async listChildren() { return []; }, async createChild() { throw new Error('unused'); },
    async renameChild() { throw new Error('unused'); }, async deactivateChild() { throw new Error('unused'); }, ...overrides };
}

test('login persists the token and a new controller verifies the restored session', async () => {
  const store = memory();
  const first = createAuthController(api(), store);
  await first.restore();
  assert.equal(first.getSnapshot().phase, 'signedOut');
  await first.login('fictional-id', 'fictional-password');
  assert.equal(first.getSnapshot().phase, 'signedIn');
  first.dispose();
  const restored = createAuthController(api(), store);
  await restored.restore();
  assert.deepEqual(restored.getSnapshot().session, { token: login.access_token, teacher });
});

test('network failure preserves stored login, while 401 removes it', async () => {
  const store = memory('stored-token');
  const offline = createAuthController(api({ async me() { throw new ApiError(0, 'CONNECTION', '연결 실패'); } }), store);
  await offline.restore();
  assert.equal(offline.getSnapshot().phase, 'unavailable');
  assert.equal(await store.read(), 'stored-token');
  offline.dispose();
  const expired = createAuthController(api({ async me() { throw new ApiError(401, 'INVALID_TOKEN', '만료'); } }), store);
  await expired.restore();
  assert.equal(expired.getSnapshot().phase, 'signedOut');
  assert.equal(await store.read(), null);
});

test('failed secure storage never reports login success and revokes the issued token', async () => {
  const revoked: string[] = [];
  const store = memory();
  store.write = async () => { throw new Error('secure storage failure'); };
  const auth = createAuthController(api({ async logout(token) { revoked.push(token); } }), store);
  await auth.restore();
  await auth.login('fictional-id', 'fictional-password');
  assert.equal(auth.getSnapshot().phase, 'signedOut');
  assert.equal(auth.getSnapshot().session, null);
  assert.deepEqual(revoked, ['fictional-token']);
});

test('logout clears local login despite network failure and old account 401 cannot sign out a new account', async () => {
  const store = memory();
  const auth = createAuthController(api({ async logout() { throw new ApiError(0, 'CONNECTION', '연결 실패'); } }), store);
  await auth.restore();
  await auth.login('fictional-id', 'fictional-password');
  await auth.unauthorized(new ApiError(401, 'INVALID_TOKEN', '만료'), 'older-account-token');
  assert.equal(auth.getSnapshot().phase, 'signedIn');
  await auth.logout();
  assert.equal(auth.getSnapshot().phase, 'signedOut');
  assert.equal(await store.read(), null);
});

test('duplicate login taps issue one request; disposed controllers cannot persist a delayed result', async () => {
  const wait = deferred<typeof login>();
  let calls = 0;
  const store = memory();
  const auth = createAuthController(api({ async login() { calls++; return wait.promise; } }), store);
  await auth.restore();
  const pending = auth.login('fictional', 'password');
  await auth.login('fictional', 'password');
  auth.dispose();
  wait.resolve(login);
  await pending;
  assert.equal(calls, 1);
  assert.equal(await store.read(), null);
});

test('roster keeps duplicate names by ID and deactivation removes only the selected active row', async () => {
  const a: Child = { child_id: 'A', name: '같은 가상 이름', is_active: true };
  const b: Child = { ...a, child_id: 'B' };
  const controller = createRosterController(api({ async listChildren() { return [a]; },
    async createChild() { return b; }, async renameChild(_, id, name) { return { ...b, child_id: id, name }; },
    async deactivateChild(_, id) { return { ...a, child_id: id, is_active: false }; } }), 'token', () => {});
  await controller.refresh();
  assert.equal(await controller.create(b.name), true);
  assert.equal(await controller.rename('B', '새 가상 이름'), true);
  assert.equal(await controller.deactivate('A'), true);
  assert.deepEqual(controller.getSnapshot().items, [{ ...b, name: '새 가상 이름' }]);
});

test('roster failure preserves rows; a closed settings screen ignores a delayed response', async () => {
  const item: Child = { child_id: 'A', name: '가상 이름', is_active: true };
  const wait = deferred<Child[]>();
  let calls = 0;
  const controller = createRosterController(api({ async listChildren() { return ++calls === 1 ? [item] : wait.promise; },
    async renameChild() { throw new ApiError(0, 'CONNECTION', '연결 실패'); } }), 'token', () => {});
  await controller.refresh();
  assert.equal(await controller.rename('A', '바꿀 이름'), false);
  assert.deepEqual(controller.getSnapshot().items, [item]);
  const pending = controller.refresh(true);
  controller.dispose();
  wait.resolve([]);
  await pending;
  assert.deepEqual(controller.getSnapshot().items, [item]);
});

test('roster 401 invalidates its own session and rejects duplicate mutations', async () => {
  const wait = deferred<Child>();
  const errors: unknown[] = [];
  let creates = 0;
  const controller = createRosterController(api({ async createChild() { creates++; return wait.promise; },
    async renameChild() { throw new ApiError(401, 'INVALID_TOKEN', '만료'); } }), 'token', error => errors.push(error));
  await controller.refresh();
  const pending = controller.create('가상 이름');
  assert.equal(await controller.create('가상 이름'), false);
  wait.resolve({ child_id: 'A', name: '가상 이름', is_active: true });
  await pending;
  assert.equal(creates, 1);
  await controller.rename('A', '새 이름');
  assert.equal((errors[0] as ApiError).status, 401);
});

test('API sends the agreed paths, JSON and Bearer header without leaking arbitrary server errors', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return Response.json(login);
    if (calls.length === 2) return Response.json({ child_id: 'A', name: '가상 이름', is_active: true }, { status: 201 });
    return Response.json({ error: { code: 'INVALID_TOKEN', message: 'private-server-details' } }, { status: 401 });
  };
  const client = createApi('http://localhost:8000/', fetcher);
  await client.login('fictional', 'password');
  await client.createChild('session-token', '가상 이름');
  assert.equal(calls[0].url, 'http://localhost:8000/api/v1/auth/login');
  assert.equal(calls[0].init?.body, JSON.stringify({ login_id: 'fictional', password: 'password' }));
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, 'Bearer session-token');
  await assert.rejects(client.me('session-token'), (error: ApiError) => error.status === 401 && !error.message.includes('private-server-details'));
});

test('API rejects wrong child IDs and malformed list responses', async () => {
  const fetcher: typeof fetch = async () => Response.json({ child_id: 'other-child', name: '가상 이름', is_active: true });
  const client = createApi('http://localhost:8000', fetcher);
  await assert.rejects(client.renameChild('token', 'wanted-child', '이름'));
  await assert.rejects(client.listChildren('token', false));
});

test('effect cleanup followed by setup restores authentication again', async () => {
  const auth = createAuthController(api(), memory('stored-token'));
  await auth.restore();
  auth.dispose();
  await auth.restore();
  assert.equal(auth.getSnapshot().phase, 'signedIn');
  await auth.logout();
  assert.equal(auth.getSnapshot().phase, 'signedOut');
});

test('settings effect restart ignores old work and refreshes the roster', async () => {
  const old = deferred<Child[]>();
  let calls = 0;
  const item: Child = { child_id: 'A', name: '가상 이름', is_active: true };
  const controller = createRosterController(api({ async listChildren() { return ++calls === 1 ? old.promise : [item]; } }), 'token', () => {});
  const pending = controller.refresh();
  controller.dispose();
  await controller.refresh();
  old.resolve([]);
  await pending;
  assert.deepEqual(controller.getSnapshot().items, [item]);
});
