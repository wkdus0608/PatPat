export interface Teacher { teacher_id: string; display_name: string }
export interface Child { child_id: string; name: string; is_active: boolean }
export interface Login { access_token: string; token_type: 'bearer'; expires_in: number; teacher: Teacher }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid response');
  return value;
};
function teacher(value: unknown): Teacher {
  const row = record(value);
  return { teacher_id: text(row.teacher_id), display_name: text(row.display_name) };
}
function child(value: unknown): Child {
  const row = record(value);
  if (typeof row.is_active !== 'boolean') throw new Error('Invalid response');
  return { child_id: text(row.child_id), name: text(row.name), is_active: row.is_active };
}

export function createApi(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = baseUrl.trim().replace(/\/+$/, '');
  async function request(path: string, token: string | null, method = 'GET', body?: unknown): Promise<unknown> {
    if (!/^https?:\/\//.test(base)) throw new ApiError(0, 'CONNECTION', '서버에 연결할 수 없어요.');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12000);
    try {
      const response = await fetcher(base + '/api/v1' + path, {
        method, signal: abort.signal,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        let code = '';
        try { code = text(record(record(await response.json()).error).code); } catch { /* Safe generic error below. */ }
        const message = response.status === 401
          ? (path === '/auth/login' ? '계정 ID 또는 비밀번호를 확인해 주세요.' : '로그인이 만료됐어요. 다시 로그인해 주세요.')
          : response.status === 404 ? '아동을 찾을 수 없어요. 명단을 새로고침해 주세요.'
            : response.status === 422 ? '입력한 내용을 확인해 주세요.' : '요청을 처리하지 못했어요. 다시 시도해 주세요.';
        throw new ApiError(response.status, code, message);
      }
      return response.status === 204 ? undefined : await response.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, 'CONNECTION', '서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    } finally { clearTimeout(timer); }
  }
  return {
    async login(login_id: string, password: string): Promise<Login> {
      const row = record(await request('/auth/login', null, 'POST', { login_id, password }));
      if (row.token_type !== 'bearer' || typeof row.expires_in !== 'number' || row.expires_in <= 0) throw new Error('Invalid response');
      return { access_token: text(row.access_token), token_type: 'bearer', expires_in: row.expires_in, teacher: teacher(row.teacher) };
    },
    async me(token: string) { return teacher(await request('/auth/me', token)); },
    async logout(token: string) { await request('/auth/logout', token, 'POST'); },
    async listChildren(token: string, includeInactive: boolean): Promise<Child[]> {
      const row = record(await request('/children?include_inactive=' + includeInactive, token));
      if (!Array.isArray(row.items)) throw new Error('Invalid response');
      const items = row.items.map(child);
      if (new Set(items.map(item => item.child_id)).size !== items.length) throw new Error('Invalid response');
      return items;
    },
    async createChild(token: string, name: string) { return child(await request('/children', token, 'POST', { name })); },
    async renameChild(token: string, id: string, name: string) {
      const result = child(await request('/children/' + encodeURIComponent(id), token, 'PATCH', { name }));
      if (result.child_id !== id) throw new Error('Invalid response');
      return result;
    },
    async deactivateChild(token: string, id: string) {
      const result = child(await request('/children/' + encodeURIComponent(id) + '/deactivate', token, 'POST'));
      if (result.child_id !== id || result.is_active) throw new Error('Invalid response');
      return result;
    },
  };
}

export type Api = ReturnType<typeof createApi>;
export const errorMessage = (error: unknown) => error instanceof ApiError ? error.message : '응답을 확인하지 못했어요. 다시 시도해 주세요.';
