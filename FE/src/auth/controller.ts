import { ApiError, errorMessage, type Api, type Teacher } from '../api/client';

export interface TokenStore { read(): Promise<string | null>; write(token: string): Promise<void>; clear(): Promise<void> }
export interface Session { token: string; teacher: Teacher }
export interface AuthState {
  phase: 'restoring' | 'signedOut' | 'signedIn' | 'unavailable';
  busy: boolean; session: Session | null; notice: string | null;
}
export interface Account {
  api: Api; session: Session; logout(): Promise<void>; unauthorized(error: unknown): void;
  busy: boolean; notice: string | null;
}

export function createAuthController(api: Api, store: TokenStore) {
  let state: AuthState = { phase: 'restoring', busy: false, session: null, notice: null };
  let epoch = 0;
  let disposed = false;
  let remembered: string | null = null;
  let storageQueue = Promise.resolve();
  const listeners = new Set<() => void>();
  const current = (ticket: number) => !disposed && epoch === ticket;
  const set = (update: Partial<AuthState>) => {
    if (disposed) return;
    state = { ...state, ...update }; listeners.forEach(fn => fn());
  };
  function persist(action: () => Promise<void>) {
    const next = storageQueue.then(action);
    storageQueue = next.catch(() => {});
    return next;
  }
  async function restore() {
    disposed = false; // Effect setup may reuse this controller after StrictMode cleanup.
    const ticket = ++epoch;
    set({ phase: 'restoring', busy: true, session: null, notice: null });
    try {
      const token = await store.read();
      if (!current(ticket)) return;
      remembered = token;
      if (!token) { set({ phase: 'signedOut', busy: false }); return; }
      const teacher = await api.me(token);
      if (current(ticket)) set({ phase: 'signedIn', busy: false, session: { token, teacher } });
    } catch (error) {
      if (!current(ticket)) return;
      if (error instanceof ApiError && error.status === 401) {
        try {
          await persist(() => store.clear());
          if (current(ticket)) { remembered = null; set({ phase: 'signedOut', busy: false, notice: errorMessage(error) }); }
        } catch { if (current(ticket)) set({ phase: 'unavailable', busy: false, notice: '로그인 정보를 정리하지 못했어요. 다시 시도해 주세요.' }); }
      } else set({ phase: 'unavailable', busy: false, notice: errorMessage(error) });
    }
  }
  async function login(loginId: string, password: string) {
    if (state.busy || !loginId.trim() || !password) return;
    const ticket = ++epoch;
    set({ busy: true, notice: null });
    let issued: string | null = null;
    try {
      const result = await api.login(loginId, password);
      issued = result.access_token;
      await persist(async () => { if (current(ticket)) await store.write(result.access_token); });
      if (!current(ticket)) { await api.logout(result.access_token).catch(() => {}); return; }
      remembered = result.access_token;
      set({ phase: 'signedIn', busy: false, session: { token: result.access_token, teacher: result.teacher } });
    } catch (error) {
      if (issued) await api.logout(issued).catch(() => {});
      if (current(ticket)) set({ busy: false, notice: issued ? '로그인 정보를 기기에 저장하지 못했어요. 다시 시도해 주세요.' : errorMessage(error) });
    }
  }
  async function logout() {
    if (state.busy) return;
    const ticket = ++epoch;
    const token = state.session?.token ?? remembered;
    set({ busy: true, notice: null });
    try {
      // Clear local storage even when the server cannot be reached.
      await persist(() => store.clear());
      if (token) await api.logout(token).catch(() => {});
      if (current(ticket)) { remembered = null; set({ phase: 'signedOut', busy: false, session: null }); }
    } catch {
      if (current(ticket)) set({ busy: false, notice: '로그인 정보를 지우지 못했어요. 다시 시도해 주세요.' });
    }
  }
  async function unauthorized(error: unknown, token: string) {
    if (!(error instanceof ApiError) || error.status !== 401 || state.session?.token !== token || state.busy) return;
    const ticket = ++epoch;
    set({ phase: 'unavailable', busy: true, session: null, notice: errorMessage(error) });
    try {
      await persist(() => store.clear());
      if (current(ticket)) { remembered = null; set({ phase: 'signedOut', busy: false }); }
    } catch { if (current(ticket)) set({ busy: false }); }
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    restore, login, logout, unauthorized,
    dispose() { disposed = true; epoch++; listeners.clear(); },
  };
}
