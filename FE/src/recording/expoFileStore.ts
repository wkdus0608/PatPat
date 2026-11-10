import { Directory, File, Paths } from 'expo-file-system';
import type { Account } from '../auth/controller';
import { accountDirectory, createSyncStore } from './syncStore';
import {
  createRecordingStorage,
  RecordingStorageError,
  type RecordingFilePort,
} from './storage';

export function createExpoFilePort(account?: Account): RecordingFilePort {
  const root = account ? accountDirectory(account) : new Directory(Paths.document, 'recordings');
  return {
    rootUri: root.uri,
    async stat(uri) {
      const path = Paths.info(uri);
      if (!path.exists) return { exists: false, isDirectory: false, size: 0 };
      if (path.isDirectory) return { exists: true, isDirectory: true, size: 0 };
      const file = new File(uri);
      return { exists: file.exists, isDirectory: false, size: file.size };
    },
    async list(uri) {
      const directory = new Directory(uri);
      if (!directory.exists) return [];
      return directory.list().map((entry) => ({
        uri: entry.uri,
        name: entry.name,
        isDirectory: entry instanceof Directory,
        size: entry instanceof Directory ? 0 : entry.size,
      }));
    },
    async makeDirectory(uri) {
      new Directory(uri).create({ intermediates: true, idempotent: true });
    },
    async copy(sourceUri, destinationUri) {
      await new File(sourceUri).copy(new File(destinationUri), { overwrite: false });
    },
    async moveNoReplace(sourceUri, destinationUri) {
      const destination = new File(destinationUri);
      if (destination.exists) {
        throw new RecordingStorageError('COLLISION', '같은 이름의 녹음 파일이 이미 있어요. 기존 파일은 그대로 보관했어요.');
      }
      await new File(sourceUri).move(destination, { overwrite: false });
    },
    async remove(uri) {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
  };
}

/** `onSaved` runs after the file and its upload record are safely on the device. */
export function createExpoRecordingStorage(account?: Account, onSaved?: () => void) {
  const storage = createRecordingStorage(createExpoFilePort(account));
  if (!account) return storage;
  const store = createSyncStore(account);
  return { ...storage, async save(uri: string, startedAt: Date, durationMillis = 0) {
    const saved = await storage.save(uri, startedAt);
    const existing = (await store.entries()).find(entry => entry.saved.uri === saved.uri);
    if (!existing) {
      if (durationMillis <= 0) throw new Error('Missing duration');
      await store.put({ saved, key: startedAt.toISOString() + '-' + Math.random().toString(36).slice(2),
        recordedAt: startedAt.toISOString(), duration: durationMillis / 1000 });
    }
    try { onSaved?.(); } catch { /* A listener failure never undoes a saved recording. */ }
    return saved;
  } };
}
