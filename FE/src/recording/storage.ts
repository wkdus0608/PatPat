import {
  describeRecording,
  formatDateKey,
  isDateFolder,
  joinFileUri,
  parseRecordingFileName,
} from './files';

export interface SavedRecording {
  uri: string;
  fileName: string;
  dateKey: string;
  startTime: string;
}

export interface RecordingSummary {
  todayCount: number;
  latest: SavedRecording | null;
}

export interface FileStat {
  exists: boolean;
  isDirectory: boolean;
  size: number;
}

export interface FileEntry {
  uri: string;
  name: string;
  isDirectory: boolean;
  size: number;
}

/** Device operations are injected so file preservation can be tested without a microphone. */
export interface RecordingFilePort {
  rootUri: string;
  stat(uri: string): Promise<FileStat>;
  list(uri: string): Promise<FileEntry[]>;
  makeDirectory(uri: string): Promise<void>;
  copy(sourceUri: string, destinationUri: string): Promise<void>;
  moveNoReplace(sourceUri: string, destinationUri: string): Promise<void>;
  remove(uri: string): Promise<void>;
}

export type RecordingStorageErrorCode = 'COLLISION' | 'EMPTY' | 'FORMAT' | 'IO';

export class RecordingStorageError extends Error {
  constructor(public readonly code: RecordingStorageErrorCode, message: string) {
    super(message);
    this.name = 'RecordingStorageError';
  }
}

export interface RecordingStorage {
  assertAvailable(startedAt: Date): Promise<void>;
  save(sourceUri: string, startedAt: Date): Promise<SavedRecording>;
  getSummary(now: Date): Promise<RecordingSummary>;
}

const collision = () => new RecordingStorageError(
  'COLLISION',
  '같은 시작 시간의 녹음이 이미 있어요. 기존 파일은 그대로 보관했어요.',
);

function asStorageError(error: unknown): RecordingStorageError {
  return error instanceof RecordingStorageError
    ? error
    : new RecordingStorageError('IO', '녹음을 저장하지 못했어요. 저장 공간을 확인하고 다시 시도해 주세요.');
}

export function createRecordingStorage(port: RecordingFilePort): RecordingStorage {
  // These are only in-memory retry guards, not recording IDs or a persistent index.
  const completed = new Map<string, SavedRecording>();
  const inFlight = new Map<string, { source: string; promise: Promise<SavedRecording> }>();

  function target(startedAt: Date): SavedRecording {
    const name = describeRecording(startedAt);
    return {
      ...name,
      uri: joinFileUri(joinFileUri(port.rootUri, name.dateKey), name.fileName),
    };
  }

  async function assertAvailable(startedAt: Date): Promise<void> {
    try {
      const destination = target(startedAt);
      if ((await port.stat(destination.uri)).exists || inFlight.has(destination.uri)) {
        throw collision();
      }
    } catch (error) {
      throw asStorageError(error);
    }
  }

  async function performSave(sourceUri: string, saved: SavedRecording): Promise<SavedRecording> {
    const retryKey = `${sourceUri}\n${saved.uri}`;
    const existingSuccess = completed.get(retryKey);
    if (existingSuccess && (await port.stat(saved.uri)).size > 0) return existingSuccess;

    if (!/^file:\/\//i.test(sourceUri) || !/\.m4a$/i.test(sourceUri)) {
      throw new RecordingStorageError('FORMAT', '기기의 M4A 녹음 파일만 저장할 수 있어요.');
    }
    if ((await port.stat(saved.uri)).exists) throw collision();
    const source = await port.stat(sourceUri);
    if (!source.exists || source.isDirectory || source.size <= 0) {
      throw new RecordingStorageError('EMPTY', '저장할 녹음 파일이 없어요. 다시 녹음해 주세요.');
    }

    const folder = joinFileUri(port.rootUri, saved.dateKey);
    const staging = joinFileUri(folder, `.${saved.fileName}.pending`);
    await port.makeDirectory(folder);
    // A partial staging copy is never counted as a saved recording. Keep the source
    // until publication succeeds, including when copying or finalization fails.
    if ((await port.stat(staging)).exists) await port.remove(staging);
    await port.copy(sourceUri, staging);
    const staged = await port.stat(staging);
    if (!staged.exists || staged.size !== source.size || staged.size <= 0) {
      throw new RecordingStorageError('IO', '녹음 파일 저장이 끝나지 않았어요. 다시 저장해 주세요.');
    }
    if ((await port.stat(saved.uri)).exists) throw collision();
    await port.moveNoReplace(staging, saved.uri);
    completed.set(retryKey, saved);
    // Cache cleanup cannot turn a successful save into a failure.
    try { await port.remove(sourceUri); } catch { /* The OS can reclaim the cache later. */ }
    return saved;
  }

  function save(sourceUri: string, startedAt: Date): Promise<SavedRecording> {
    const saved = target(startedAt);
    const running = inFlight.get(saved.uri);
    if (running) {
      return running.source === sourceUri ? running.promise : Promise.reject(collision());
    }
    const promise = performSave(sourceUri, saved)
      .catch((error: unknown) => { throw asStorageError(error); })
      .finally(() => { inFlight.delete(saved.uri); });
    inFlight.set(saved.uri, { source: sourceUri, promise });
    return promise;
  }

  async function getSummary(now: Date): Promise<RecordingSummary> {
    try {
      if (!(await port.stat(port.rootUri)).exists) return { todayCount: 0, latest: null };
      const today = formatDateKey(now);
      let todayCount = 0;
      let latest: SavedRecording | null = null;
      const folders = await port.list(port.rootUri);
      for (const folder of folders) {
        if (!folder.isDirectory || !isDateFolder(folder.name)) continue;
        for (const file of await port.list(folder.uri)) {
          if (file.isDirectory || file.size <= 0) continue;
          const name = parseRecordingFileName(file.name, folder.name);
          if (!name) continue;
          if (name.dateKey === today) todayCount += 1;
          if (!latest || name.fileName > latest.fileName) latest = { ...name, uri: file.uri };
        }
      }
      return { todayCount, latest };
    } catch {
      throw new RecordingStorageError('IO', '저장된 녹음을 확인하지 못했어요. 다시 확인해 주세요.');
    }
  }

  return { assertAvailable, save, getSummary };
}
