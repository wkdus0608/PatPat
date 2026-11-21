import type { TokenStore } from './controller';

export interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 웹에서는 토큰을 브라우저 탭 저장소(sessionStorage)에 둬 새로고침해도 로그인이 유지되게 한다.
 * 탭을 닫으면 사라지므로 공용 컴퓨터에서 로그인이 남지 않는다. 저장소를 쓸 수 없으면(사생활 보호 모드 등) 메모리에만 둔다.
 */
export function createWebTokenStore(storage: WebStorage | null, key: string): TokenStore {
  let memory: string | null = null;
  return {
    async read() {
      try { return storage?.getItem(key) ?? memory; } catch { return memory; }
    },
    async write(token) {
      memory = token;
      try { storage?.setItem(key, token); } catch { /* 저장소를 쓸 수 없으면 메모리에만 둔다 */ }
    },
    async clear() {
      memory = null;
      try { storage?.removeItem(key); } catch { /* 같은 이유 */ }
    },
  };
}
