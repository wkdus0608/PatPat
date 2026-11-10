import { Directory, File, Paths } from 'expo-file-system';
import { UploadType } from 'expo-file-system';
import type { Account } from '../auth/controller';
import { ApiError, serverRecording } from '../api/client';
import type { RecordingRemote, ServerRecording } from './sync';

export function createRecordingRemote(account: Account): RecordingRemote {
  const { api, session } = account;
  const headers = { Authorization: 'Bearer ' + session.token };
  const root = api.baseUrl + '/api/v1/recordings';
  const pending = new Set<string>();
  async function authorized<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) { account.unauthorized(error); throw error; }
  }
  async function transfer<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) abort.abort();
    const timer = setTimeout(stop, 120000);
    try { return await work(abort.signal); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
  }
  return {
    upload(entry, signal) { return authorized(() => transfer(signal, async active => {
      const result = await new File(entry.saved.uri).createUploadTask(root, {
        httpMethod: 'POST', uploadType: UploadType.MULTIPART, fieldName: 'file', mimeType: 'audio/mp4',
        parameters: { title: entry.saved.fileName, recorded_at: entry.recordedAt, duration_seconds: String(entry.duration) },
        headers: { ...headers, 'Idempotency-Key': entry.key }, signal: active, sessionType: 'foreground',
      }).uploadAsync();
      if (result.status < 200 || result.status >= 300) throw new ApiError(result.status, 'UPLOAD_FAILED', '서버에 녹음을 저장하지 못했어요.');
      return serverRecording(JSON.parse(result.body));
    })); },
    list(signal) { return authorized(async () => {
      const items: ServerRecording[] = [];
      let total = 0;
      do {
        if (signal.aborted) throw new Error('Cancelled');
        const page = await api.listRecordings(session.token, items.length);
        total = page.total;
        if (!page.items.length) break;
        items.push(...page.items);
      } while (items.length < total);
      if (new Set(items.map(r => r.recording_id)).size !== items.length) throw new Error('List changed; refresh again');
      return items;
    }); },
    remove(id) { return authorized(() => api.deleteRecording(session.token, id)); },
    playback(id, signal) { return authorized(() => transfer(signal, async active => {
      const row = await api.getRecording(session.token, id);
      const directory = new Directory(Paths.cache, 'patpat-playback');
      directory.create({ intermediates: true, idempotent: true });
      const extension = ({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/aac': 'aac' } as Record<string, string>)[row.content_type] ?? 'm4a';
      const file = new File(directory, Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + extension);
      const uri = file.uri; pending.add(uri);
      try {
        const result = await File.createDownloadTask(root + '/' + encodeURIComponent(id) + '/audio', file,
          { headers, signal: active, sessionType: 'foreground' }).downloadAsync();
        if (!result || active.aborted || file.size !== row.size_bytes) throw new Error('Incomplete download');
        return uri;
      } catch (error) { if (file.exists) file.delete(); pending.delete(uri); throw error; }
    })); },
    async cleanup() {
      for (const uri of pending) { const file = new File(uri); if (file.exists) file.delete(); }
      pending.clear();
    },
  };
}
