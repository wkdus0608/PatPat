import { compareRecordings, isDateFolder, joinFileUri, parseRecordingFileName, trimTrailingSlashes } from '../recording/files';
import type { RecordingFilePort, SavedRecording } from '../recording/storage';
import type { RecordingLibrary } from './types';

export type RecordingLibraryErrorCode = 'INVALID_PATH' | 'NOT_FOUND' | 'IO';

export class RecordingLibraryError extends Error {
  constructor(public readonly code: RecordingLibraryErrorCode, message: string) {
    super(message);
    this.name = 'RecordingLibraryError';
  }
}

const invalidPath = () => new RecordingLibraryError(
  'INVALID_PATH', '앱에 저장된 정상 녹음 파일만 열거나 삭제할 수 있어요.',
);
const notFound = () => new RecordingLibraryError(
  'NOT_FOUND', '녹음 파일을 찾을 수 없어요. 목록을 다시 확인해 주세요.',
);

function preserveLibraryError(error: unknown, message: string): RecordingLibraryError {
  return error instanceof RecordingLibraryError
    ? error
    : new RecordingLibraryError('IO', message);
}

/** Lists device files only. No recording IDs, persistence schema, or external requests. */
export function createRecordingLibrary(port: RecordingFilePort): RecordingLibrary {
  const rootUri = port.rootUri.replace(/\/+$/, '');

  function checkedPath(recording: SavedRecording): { folderUri: string; uri: string } {
    // Reject path aliases rather than decoding or normalizing caller-supplied paths.
    // This prevents ../, encoded traversal, alternate URLs and a different filename
    // from becoming a playback or deletion target after normalization.
    if (
      !recording || typeof recording !== 'object' ||
      typeof recording.uri !== 'string' ||
      typeof recording.fileName !== 'string' ||
      typeof recording.dateKey !== 'string' ||
      typeof recording.startTime !== 'string'
    ) throw invalidPath();
    const parsed = parseRecordingFileName(recording.fileName, recording.dateKey);
    if (!parsed || parsed.startTime !== recording.startTime) throw invalidPath();
    const folderUri = joinFileUri(rootUri, parsed.dateKey);
    const uri = joinFileUri(folderUri, parsed.fileName);
    if (!/^file:\/\/\//.test(rootUri) || recording.uri !== uri) throw invalidPath();
    return { folderUri, uri };
  }

  async function validate(recording: SavedRecording): Promise<void> {
    try {
      const { folderUri, uri } = checkedPath(recording);
      const root = await port.stat(rootUri);
      if (!root.exists) throw notFound();
      if (!root.isDirectory) throw invalidPath();
      const folder = await port.stat(folderUri);
      if (!folder.exists) throw notFound();
      if (!folder.isDirectory) throw invalidPath();
      const file = await port.stat(uri);
      if (!file.exists) throw notFound();
      if (file.isDirectory || !Number.isFinite(file.size) || file.size <= 0) throw invalidPath();
    } catch (error) {
      throw preserveLibraryError(error, '녹음 파일을 확인하지 못했어요. 다시 시도해 주세요.');
    }
  }

  async function list(): Promise<SavedRecording[]> {
    try {
      const root = await port.stat(rootUri);
      if (!root.exists) return [];
      if (!root.isDirectory) {
        throw new RecordingLibraryError('IO', '녹음 보관 경로를 읽을 수 없어요.');
      }
      const recordings: SavedRecording[] = [];
      const seen = new Set<string>();
      for (const folder of await port.list(rootUri)) {
        if (!folder.isDirectory || !isDateFolder(folder.name)) continue;
        const folderUri = joinFileUri(rootUri, folder.name);
        // expo-file-system reports directory URIs with a trailing slash.
        if (trimTrailingSlashes(folder.uri) !== folderUri) continue;
        for (const file of await port.list(folderUri)) {
          if (file.isDirectory || !Number.isFinite(file.size) || file.size <= 0) continue;
          const name = parseRecordingFileName(file.name, folder.name);
          if (!name) continue;
          const recording: SavedRecording = { ...name, uri: file.uri };
          const expectedUri = joinFileUri(folderUri, name.fileName);
          if (file.uri !== expectedUri || seen.has(file.uri)) continue;
          // Recheck actual files, not just the directory listing's cached metadata.
          await validate(recording);
          seen.add(recording.uri);
          recordings.push(recording);
        }
      }
      return recordings.sort(compareRecordings);
    } catch (error) {
      throw preserveLibraryError(error, '저장된 녹음 목록을 불러오지 못했어요. 다시 시도해 주세요.');
    }
  }

  async function remove(recording: SavedRecording): Promise<void> {
    try {
      const { uri } = checkedPath(recording);
      await validate(recording);
      // Validate again at the destructive boundary: the file may have disappeared
      // or changed since selection/confirmation. Never remove the date directory.
      const file = await port.stat(uri);
      if (!file.exists) throw notFound();
      if (file.isDirectory || !Number.isFinite(file.size) || file.size <= 0) throw invalidPath();
      await port.remove(uri);
      if ((await port.stat(uri)).exists) {
        throw new RecordingLibraryError('IO', '녹음 삭제를 확인하지 못했어요. 다시 시도해 주세요.');
      }
    } catch (error) {
      throw preserveLibraryError(error, '녹음을 삭제하지 못했어요. 파일은 목록에서 다시 확인해 주세요.');
    }
  }

  return { available: true, list, validate, remove };
}
