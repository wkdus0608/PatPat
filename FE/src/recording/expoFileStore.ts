import { Directory, File, Paths } from 'expo-file-system';
import {
  createRecordingStorage,
  RecordingStorageError,
  type RecordingFilePort,
} from './storage';

export function createExpoFilePort(): RecordingFilePort {
  const root = new Directory(Paths.document, 'recordings');
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
        throw new RecordingStorageError('COLLISION', '같은 시작 시간의 녹음이 이미 있어요.');
      }
      await new File(sourceUri).move(destination, { overwrite: false });
    },
    async remove(uri) {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
  };
}

export function createExpoRecordingStorage() {
  return createRecordingStorage(createExpoFilePort());
}
