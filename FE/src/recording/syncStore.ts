import { Directory, File, Paths } from 'expo-file-system';
import type { Account } from '../auth/controller';
import { joinFileUri, parseRecordingFileName } from './files';
import type { SyncStore, UploadEntry, ServerRecording } from '../library/sync';

/** Keep `%`, `:` and `/` out of directory names: file URIs decode them inconsistently across platforms. */
function pathSafe(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return `${value.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 32)}-${hash.toString(16)}`;
}

export function accountDirectory(account: Account) {
  return new Directory(Paths.document, 'recordings', 'accounts', pathSafe(account.api.baseUrl),
    pathSafe(account.session.teacher.teacher_id));
}

const ENTRY_FILE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(?:_[2-9]|_[1-9]\d)?\.m4a\.json$/;
const RECORDING_FILE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(?:_[2-9]|_[1-9]\d)?\.m4a$/;
export function createSyncStore(account: Account): SyncStore {
  const root = new Directory(accountDirectory(account), '.sync');
  async function write(name: string, value: unknown) {
    root.create({ intermediates: true, idempotent: true });
    const destination = new File(root, name);
    const temporary = new File(root, name + '.pending');
    await temporary.write(JSON.stringify(value));
    await temporary.move(destination, { overwrite: true });
  }
  return {
    async entries() {
      if (!root.exists) return [];
      const result: UploadEntry[] = [];
      for (const file of root.list()) {
        if (!(file instanceof File) || !ENTRY_FILE.test(file.name)) continue;
        let entry: UploadEntry;
        try {
          entry = JSON.parse(await file.text()) as UploadEntry;
          const name = entry.saved && parseRecordingFileName(entry.saved.fileName, entry.saved.dateKey);
          if (!name || typeof entry.key !== 'string' || !entry.key || entry.key.length > 128 || !Number.isFinite(entry.duration) || entry.duration <= 0
            || !Number.isFinite(Date.parse(entry.recordedAt))) {
            throw new Error('Invalid recording metadata');
          }
          // iOS may relocate the app sandbox after an update; preserve identity, rebuild its URI.
          entry.saved = { ...name, uri: joinFileUri(joinFileUri(accountDirectory(account).uri, name.dateKey), name.fileName) };
        } catch (error) {
          // One unreadable sidecar must not hide every other recording or block their upload.
          console.warn('[sync] skipped unreadable upload metadata', file.name, error);
          continue;
        }
        result.push(entry);
      }
      return result;
    },
    async put(entry) {
      if (!RECORDING_FILE.test(entry.saved.fileName)) throw new Error('Invalid recording filename');
      await write(entry.saved.fileName + '.json', entry);
    },
    async cache(items?: ServerRecording[]) {
      if (items) await write('server.json', items);
      const file = new File(root, 'server.json');
      return file.exists ? JSON.parse(await file.text()) as ServerRecording[] : [];
    },
  };
}
