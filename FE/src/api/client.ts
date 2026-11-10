import type { ServerRecording } from '../library/sync';
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


export function serverRecording(value: unknown): ServerRecording {
  const row = record(value);
  for (const field of ['duration_seconds', 'size_bytes']) {
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || (row[field] as number) <= 0) throw new Error('Invalid recording');
  }
  for (const field of ['recorded_at', 'created_at']) if (!Number.isFinite(Date.parse(text(row[field])))) throw new Error('Invalid date');
  if (!['대기', '전사중', '완료', '실패'].includes(text(row.status))) throw new Error('Invalid recording status');
  return { recording_id: text(row.recording_id), title: text(row.title), recorded_at: text(row.recorded_at),
    created_at: text(row.created_at), duration_seconds: row.duration_seconds as number, size_bytes: row.size_bytes as number,
    content_type: text(row.content_type), status: text(row.status) };
}

export function createRequest(baseUrl: string, prefix: '/api/v1' | '/api/v2', fetcher: typeof fetch = fetch) {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return async function request(
    path: string, token: string | null, method = 'GET', body?: unknown,
    responseType: 'json' | 'text' | 'blob' | 'arrayBuffer' = 'json', signal?: AbortSignal, timeoutMs?: number,
  ): Promise<unknown> {
    if (!/^https?:\/\//.test(base)) throw new ApiError(0, 'CONNECTION', '서버에 연결할 수 없어요.');
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const binary = body instanceof ArrayBuffer;
    const timer = setTimeout(stop, timeoutMs ?? (responseType === 'blob' || responseType === 'arrayBuffer' ? 120000 : 12000));
    try {
      const response = await fetcher(base + prefix + path, {
        method, signal: abort.signal,
        headers: { ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }),
          ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
      });
      if (!response.ok) {
        let code = '';
        let serverMessage = '';
        try {
          const error = record(record(await response.json()).error);
          code = text(error.code);
          if (typeof error.message === 'string') serverMessage = error.message;
        } catch { /* Safe generic error below. */ }
        const fallback = response.status === 401
          ? (path === '/auth/login' ? '계정 ID 또는 비밀번호를 확인해 주세요.' : '로그인이 만료됐어요. 다시 로그인해 주세요.')
          : response.status === 404 ? '자료를 찾을 수 없어요. 목록을 새로고침해 주세요.'
            : response.status === 422 ? '입력한 내용을 확인해 주세요.' : '요청을 처리하지 못했어요. 다시 시도해 주세요.';
        throw new ApiError(response.status, code, prefix === '/api/v2' && response.status !== 401 && serverMessage ? serverMessage : fallback);
      }
      if (response.status === 204) return undefined;
      if (responseType === 'blob') return await response.blob();
      if (responseType === 'arrayBuffer') return await response.arrayBuffer();
      return responseType === 'text' ? await response.text() : await response.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, 'CONNECTION', '서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  };
}

export function createApi(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const request = createRequest(base, '/api/v1', fetcher);
  return {
    baseUrl: base,
    async listRecordings(token: string, offset = 0, date?: string) {
      const day = date ? '&date_from=' + encodeURIComponent(date) + '&date_to=' + encodeURIComponent(date) : '';
      const row = record(await request('/recordings?limit=100&offset=' + offset + day, token));
      if (!Array.isArray(row.items) || !Number.isInteger(row.total) || (row.total as number) < 0) throw new Error('Invalid page');
      return { items: row.items.map(serverRecording), total: row.total as number };
    },
    async getRecording(token: string, id: string) { return serverRecording(await request('/recordings/' + encodeURIComponent(id), token)); },
    async recordingAudio(token: string, id: string, signal: AbortSignal) {
      return await request('/recordings/' + encodeURIComponent(id) + '/audio', token, 'GET', undefined, 'blob', signal) as Blob;
    },
    async deleteRecording(token: string, id: string) { await request('/recordings/' + encodeURIComponent(id), token, 'DELETE'); },
    async login(login_id: string, password: string): Promise<Login> {
      const row = record(await request('/auth/login', null, 'POST', { login_id, password }));
      if (row.token_type !== 'bearer' || typeof row.expires_in !== 'number' || row.expires_in <= 0) throw new Error('Invalid response');
      return { access_token: text(row.access_token), token_type: 'bearer', expires_in: row.expires_in, teacher: teacher(row.teacher) };
    },
    async me(token: string) { return teacher(await request('/auth/me', token)); },
    async logout(token: string) { await request('/auth/logout', token, 'POST'); },
    async listChildren(token: string, includeInactive?: boolean): Promise<Child[]> {
      const path = includeInactive === undefined ? '/children' : '/children?include_inactive=' + includeInactive;
      const row = record(await request(path, token));
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
    async deleteChild(_token: string, _id: string): Promise<void> {
      // The current BE contract has no deletion endpoint. Keep the FE port
      // explicit until that contract exists; never substitute deactivation.
      throw new ApiError(501, 'NOT_IMPLEMENTED', '아동 삭제 기능은 서버 연결 준비 중이에요.');
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
