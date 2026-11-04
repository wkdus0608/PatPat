import { ApiError } from '../api/client';
import { compareRecordings } from '../recording/files';
import type { SavedRecording } from '../recording/storage';
import type { RecordingLibrary, DeleteTarget } from './types';

export interface ServerRecording {
  recording_id: string; title: string; recorded_at: string; duration_seconds: number;
  size_bytes: number; content_type: string; status: string; created_at: string;
}
export interface UploadEntry {
  saved: SavedRecording; key: string; recordedAt: string; duration: number;
  serverId?: string; serverDeleted?: boolean;
}
export interface SyncStore {
  entries(): Promise<UploadEntry[]>;
  put(entry: UploadEntry): Promise<void>;
  cache(items?: ServerRecording[]): Promise<ServerRecording[]>;
}
export interface RecordingRemote {
  upload(entry: UploadEntry, signal: AbortSignal): Promise<ServerRecording>;
  list(signal: AbortSignal): Promise<ServerRecording[]>;
  remove(id: string): Promise<void>;
  playback(id: string, signal: AbortSignal): Promise<string>;
  cleanup(): Promise<void>;
}

export interface AutoSyncResult {
  uploaded: number;
  /** Local recordings still waiting for the server after this attempt. */
  remaining: number;
  /** True when the attempt stopped on a connection/server problem worth retrying. */
  failed: boolean;
}

export interface SyncedRecordingLibrary extends RecordingLibrary {
  /** Uploads pending recordings without touching the screen. Never rejects. */
  autoSync(): Promise<AutoSyncResult>;
}

const entryKey = (saved: Pick<SavedRecording, 'dateKey' | 'fileName'>) => saved.dateKey + '/' + saved.fileName;

/** A 4xx other than auth/timeout/rate-limit will not succeed on retry: skip that file, keep the rest moving. */
function isPermanentRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500
    && ![401, 408, 429].includes(error.status);
}

function serverItem(row: ServerRecording): SavedRecording {
  const date = new Date(row.recorded_at);
  const two = (n: number) => String(n).padStart(2, '0');
  const dateKey = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const startTime = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return { uri: 'patpat-server:' + row.recording_id, dateKey, startTime,
    fileName: row.title, serverId: row.recording_id, location: 'server', syncLabel: '서버에 저장됨' };
}

/** Uploads happen right after a save (autoSync), on retry, and on the library's refresh button. */
export function createSyncedLibrary(local: RecordingLibrary, legacy: RecordingLibrary, store: SyncStore,
  remote: RecordingRemote): SyncedRecordingLibrary {
  let transfer: AbortController | null = null;
  let syncing = false;
  let rerun = false;
  const waiters: Array<(result: AutoSyncResult) => void> = [];
  // Recordings the server refused for good this session; they stay on the device.
  const rejected = new Set<string>();

  async function uploadPending(signal: AbortSignal, progress: { uploaded: number }): Promise<void> {
    const files = new Set((await local.list()).map(entryKey));
    for (const entry of await store.entries()) {
      if (entry.serverId || entry.serverDeleted || !files.has(entryKey(entry.saved)) || rejected.has(entry.key)) continue;
      try { await local.validate(entry.saved); } catch { continue; }
      let row: ServerRecording;
      try {
        row = await remote.upload(entry, signal);
      } catch (error) {
        if (isPermanentRejection(error)) { console.warn('[sync] server rejected a recording', entry.saved.fileName, error); rejected.add(entry.key); continue; }
        throw error;
      }
      // Persist the stable ID before the next upload; retries reuse entry.key.
      await store.put({ ...entry, serverId: row.recording_id });
      progress.uploaded++;
      if (signal.aborted) throw new Error('Cancelled');
    }
  }

  async function pendingCount(): Promise<number> {
    const files = new Set((await local.list()).map(entryKey));
    return (await store.entries()).filter(e => !e.serverId && !e.serverDeleted && !rejected.has(e.key) && files.has(entryKey(e.saved))).length;
  }

  /** A save that lands while another pass runs is picked up by one more pass right after it. */
  function runQueued() {
    if (!rerun) return;
    rerun = false;
    const queued = waiters.splice(0);
    void autoSync().then(result => queued.forEach(resolve => resolve(result)));
  }

  async function autoSync(): Promise<AutoSyncResult> {
    if (syncing) { rerun = true; return new Promise(resolve => { waiters.push(resolve); }); }
    syncing = true;
    const progress = { uploaded: 0 };
    let failed = false;
    try {
      await uploadPending(new AbortController().signal, progress);
    } catch (error) {
      failed = true;
      console.warn('[sync] automatic upload stopped', error);
    } finally {
      syncing = false;
    }
    let remaining = 0;
    try { remaining = await pendingCount(); } catch { failed = true; }
    runQueued();
    return { uploaded: progress.uploaded, remaining, failed };
  }

  return {
    available: true,
    autoSync,
    async list() {
      const [files, old, entries, cached] = await Promise.all([local.list(), legacy.list(), store.entries(), store.cache()]);
      const byKey = new Map(entries.map(e => [entryKey(e.saved), e]));
      const mapped = files.map(file => {
        const entry = byKey.get(entryKey(file));
        return { ...file, serverId: entry?.serverId, location: entry?.serverId ? 'both' as const : 'device' as const,
          syncLabel: entry?.serverId ? '기기·서버에 저장됨' : entry?.serverDeleted ? '기기에 저장됨' : '기기에만 저장됨' };
      });
      const ids = new Set(mapped.map(e => e.serverId));
      return [...mapped, ...old.map(f => ({ ...f, location: 'device' as const, syncLabel: '기존 기기 녹음' })),
        ...cached.filter(r => !ids.has(r.recording_id)).map(serverItem)]
        .sort(compareRecordings);
    },
    async synchronize() {
      if (syncing) return '이미 새로고침 중이에요.';
      syncing = true;
      const active = new AbortController(); transfer = active;
      const progress = { uploaded: 0 };
      try {
        await uploadPending(active.signal, progress);
        const rows = await remote.list(active.signal);
        if (active.signal.aborted) throw new Error('Cancelled');
        const ids = new Set(rows.map(row => row.recording_id));
        for (const entry of await store.entries()) {
          if (entry.serverId && !ids.has(entry.serverId)) {
            await store.put({ ...entry, serverId: undefined, serverDeleted: true });
          }
        }
        await store.cache(rows);
        return progress.uploaded ? `${progress.uploaded}개 녹음을 서버에 저장했어요.` : '서버와 보관함을 새로고침했어요.';
      } catch (error) {
        console.warn('[sync] manual refresh stopped', error);
        return `${progress.uploaded ? progress.uploaded + '개 저장 완료. ' : ''}서버 연결을 마치지 못했어요. 기기 녹음은 보존돼요. 연결되면 자동으로 다시 저장해요.`;
      } finally {
        syncing = false; if (transfer === active) transfer = null;
        runQueued();
      }
    },
    async validate(file) {
      if (file.location === 'server') {
        if (!(await store.cache()).some(r => r.recording_id === file.serverId && file.uri === 'patpat-server:' + r.recording_id)) throw new Error('Unknown recording');
      } else if (file.syncLabel === '기존 기기 녹음') await legacy.validate(file);
      else await local.validate(file);
    },
    async playbackUri(file) {
      if (file.location !== 'server') return file.uri;
      if (!file.serverId) throw new Error('Missing recording ID');
      transfer = new AbortController();
      return remote.playback(file.serverId, transfer.signal);
    },
    async remove(file, target: DeleteTarget = file.location === 'both' ? 'both' : file.location === 'server' ? 'server' : 'device') {
      if (syncing) throw new Error('Sync in progress');
      const entry = (await store.entries()).find(e => e.saved.uri === file.uri || !!file.serverId && e.serverId === file.serverId);
      if (target !== 'device') {
        if (!file.serverId) throw new Error('Missing recording ID');
        await remote.remove(file.serverId);
        // Retain the tombstone so a local copy is never uploaded again implicitly.
        if (entry) await store.put({ ...entry, serverId: undefined, serverDeleted: true });
        await store.cache((await store.cache()).filter(r => r.recording_id !== file.serverId));
      }
      if (target !== 'server') {
        if (file.location === 'server') throw new Error('No device file');
        await (file.syncLabel === '기존 기기 녹음' ? legacy : local).remove(file);
      }
    },
    async releasePlayback() {
      transfer?.abort();
      await remote.cleanup();
    },
  };
}
