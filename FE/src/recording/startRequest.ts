/**
 * "Start recording" requests that come from outside the app: the iPhone side button (Siri) or
 * the Galaxy side key shortcut. The request is kept briefly so it still counts when the app has to
 * start up, restore the login or be unlocked first, and it is dropped when stale so an old request
 * never starts the microphone later by surprise.
 */
export const START_URL = 'patpat://record/start';
export const REQUEST_MAX_AGE_MS = 45_000;

export function isStartRequestUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^patpat:\/\/record\/start\/?(\?.*)?$/i.test(url.trim());
}

/** The iPhone intent writes the request time as epoch seconds, e.g. `1730000000.123`. */
export function parseRequestTimestamp(text: string): number | null {
  const seconds = Number(text.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

export function createStartRequestInbox(now: () => number = Date.now, maxAgeMillis = REQUEST_MAX_AGE_MS) {
  let requestedAt: number | null = null;
  const listeners = new Set<() => void>();
  return {
    push(at: number = now()) {
      requestedAt = Math.max(requestedAt ?? 0, at);
      listeners.forEach((listener) => listener());
    },
    /** True once per fresh request. Stale or already used requests return false. */
    take(): boolean {
      const at = requestedAt;
      requestedAt = null;
      return at !== null && now() - at <= maxAgeMillis;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type StartRequestInbox = ReturnType<typeof createStartRequestInbox>;

/** One inbox for the app. Sources push into it before sign-in; the recorder takes from it. */
export const startRequestInbox: StartRequestInbox = createStartRequestInbox();
