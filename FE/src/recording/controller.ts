import { RecordingStorageError, type RecordingStorage, type SavedRecording } from './storage';

export interface RecordingEngine {
  prepare(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<{ uri: string | null; durationMillis: number }>;
  cancelPreparation(): Promise<void>;
  getStatus(): { isRecording: boolean; durationMillis: number };
}

export interface RecordingState {
  phase: 'idle' | 'preparing' | 'recording' | 'saving' | 'saved' | 'error';
  durationMillis: number;
  todayCount: number | null;
  latest: SavedRecording | null;
  message: string | null;
  summaryError: string | null;
  canRetry: boolean;
  canStart: boolean;
}

interface PendingRecording {
  startedAt: Date;
  uri: string | null;
  durationMillis: number;
  interrupted: boolean;
}

/** UI coordination only: no observation IDs, database or network calls. */
export function createRecordingController(
  engine: RecordingEngine,
  storage: RecordingStorage,
  now: () => Date = () => new Date(),
) {
  let state: RecordingState = {
    phase: 'idle', durationMillis: 0, todayCount: null, latest: null,
    message: null, summaryError: null, canRetry: false, canStart: true,
  };
  let pending: PendingRecording | null = null;
  let stopRequested = false;
  let refreshVersion = 0;
  const listeners = new Set<() => void>();

  function update(patch: Partial<RecordingState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }

  async function refreshSummary() {
    const version = ++refreshVersion;
    try {
      const summary = await storage.getSummary(now());
      if (version !== refreshVersion) return;
      update({ todayCount: summary.todayCount, latest: summary.latest, summaryError: null });
    } catch {
      if (version !== refreshVersion) return;
      update({ todayCount: null, summaryError: '저장된 녹음을 확인하지 못했어요. 다시 확인해 주세요.' });
    }
  }

  async function start() {
    if (!state.canStart || pending || state.phase === 'preparing') return;
    stopRequested = false;
    update({ phase: 'preparing', durationMillis: 0, message: null, canStart: false, canRetry: false });
    const startedAt = now();
    try {
      // Check device storage is readable first. Repeat starts in one minute are allowed.
      await storage.assertAvailable(startedAt);
      if (stopRequested) {
        update({ phase: 'idle', canStart: true, message: '녹음을 시작하기 전에 화면이 전환되었어요.' });
        return;
      }
      await engine.prepare();
      if (stopRequested) {
        await engine.cancelPreparation();
        update({ phase: 'idle', canStart: true, message: '녹음을 시작하기 전에 화면이 전환되었어요.' });
        return;
      }
      pending = { startedAt, uri: null, durationMillis: 0, interrupted: false };
      await engine.start();
      update({ phase: 'recording', message: null });
      if (stopRequested) await stop(true);
    } catch (error) {
      pending = null;
      try { await engine.cancelPreparation(); } catch { /* Preserve the original start error. */ }
      const message = error instanceof RecordingStorageError ? error.message
        : '녹음을 시작하지 못했어요. 기기 상태를 확인한 뒤 다시 시도해 주세요.';
      update({ phase: 'error', canStart: true, canRetry: false, message });
    }
  }

  async function savePending() {
    if (!pending) return;
    const clip = pending;
    update({ phase: 'saving', canStart: false, canRetry: false, message: null });
    try {
      if (!clip.uri) {
        const stopped = await engine.stop();
        clip.uri = stopped.uri;
        clip.durationMillis = Math.max(clip.durationMillis, stopped.durationMillis);
      }
      if (!clip.uri || clip.durationMillis <= 0) {
        throw new RecordingStorageError('EMPTY', '저장할 녹음이 없어요. 다시 녹음해 주세요.');
      }
      const saved = await storage.save(clip.uri, clip.startedAt, clip.durationMillis);
      pending = null;
      update({
        phase: 'saved', durationMillis: clip.durationMillis,
        latest: saved, canStart: true, canRetry: false,
        message: clip.interrupted
          ? '녹음이 중단되어, 중단 전까지의 내용을 저장했어요.'
          : '녹음이 저장되었어요.',
      });
      // A summary read error must never turn a successful file save into a failure.
      await refreshSummary();
    } catch (error) {
      // A failed stop must not hide a still-active microphone behind an error UI.
      // Keep the stop button and polling active until native recording really stops.
      let stillRecording = !clip.uri;
      if (!clip.uri) {
        try { stillRecording = engine.getStatus().isRecording; } catch { /* Retry stop below. */ }
      }
      if (stillRecording) {
        update({
          phase: 'recording', canStart: false, canRetry: false,
          message: '녹음을 중지하지 못했어요. 중지를 다시 시도하고 있어요.',
        });
        return;
      }
      const unrecoverable = error instanceof RecordingStorageError
        && (error.code === 'EMPTY' || error.code === 'FORMAT');
      if (unrecoverable) pending = null;
      update({
        phase: 'error', durationMillis: clip.durationMillis,
        canStart: unrecoverable, canRetry: !unrecoverable,
        message: error instanceof RecordingStorageError ? error.message
          : '녹음을 마치지 못했어요. 다시 저장해 주세요.',
      });
    }
  }

  async function stop(interrupted = false) {
    if (state.phase === 'preparing') {
      stopRequested = true;
      return;
    }
    if (state.phase !== 'recording' || !pending) return;
    stopRequested = true;
    pending.interrupted ||= interrupted;
    try {
      pending.durationMillis = Math.max(state.durationMillis, engine.getStatus().durationMillis);
    } catch { pending.durationMillis = state.durationMillis; }
    await savePending();
  }

  async function retry() {
    if (state.phase !== 'error' || !pending || !state.canRetry) return;
    await savePending();
  }

  function poll() {
    if (state.phase !== 'recording') return;
    if (stopRequested) {
      void stop(pending?.interrupted ?? false);
      return;
    }
    try {
      const status = engine.getStatus();
      if (!status.isRecording) {
        void stop(true);
      } else if (status.durationMillis !== state.durationMillis) {
        update({ durationMillis: status.durationMillis });
      }
    } catch {
      void stop(true);
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start, stop, retry, poll, refreshSummary,
    interrupt: () => stop(true),
  };
}

export type RecordingController = ReturnType<typeof createRecordingController>;
