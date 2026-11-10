import {
  MAX_RECORDINGS_PER_MINUTE,
  compareRecordings,
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
  serverId?: string;
  location?: 'device' | 'server' | 'both';
  syncLabel?: string;
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

export type RecordingStorageErrorCode = 'COLLISION' | 'EMPTY' | 'FORMAT' | 'IO' | 'PERMISSION';

export class RecordingStorageError extends Error {
  constructor(public readonly code: RecordingStorageErrorCode, message: string) {
    super(message);
    this.name = 'RecordingStorageError';
  }
}

export interface RecordingStorage {
  assertAvailable(startedAt: Date): Promise<void>;
  save(sourceUri: string, startedAt: Date, durationMillis?: number): Promise<SavedRecording>;
  getSummary(now: Date): Promise<RecordingSummary>;
}

const collision = () => new RecordingStorageError(
  'COLLISION',
  '같은 분에 저장할 수 있는 녹음 수를 넘었어요. 잠시 뒤 다시 녹음해 주세요.',
);

function asStorageError(error: unknown): RecordingStorageError {
  return error instanceof RecordingStorageError
    ? error
    : new RecordingStorageError('IO', '녹음을 저장하지 못했어요. 저장 공간을 확인하고 다시 시도해 주세요.');
}

export function createRecordingStorage(port: RecordingFilePort): RecordingStorage {
  // These are only in-memory retry guards, not recording IDs or a persistent index.
  const completed = new Map<string, SavedRecording>();
  const inFlight = new Map<string, Promise<SavedRecording>>();
  const reserved = new Set<string>();

  function target(startedAt: Date, sequence: number): SavedRecording {
    const name = describeRecording(startedAt, sequence);
    return {
      ...name,
      uri: joinFileUri(joinFileUri(port.rootUri, name.dateKey), name.fileName),
    };
  }

  /** First free name for this start minute. Existing files are never replaced or blocked. */
  async function reserve(startedAt: Date): Promise<SavedRecording> {
    for (let sequence = 1; sequence <= MAX_RECORDINGS_PER_MINUTE; sequence += 1) {
      const candidate = target(startedAt, sequence);
      // Claim the name before awaiting so a concurrent save cannot pick the same one.
      if (reserved.has(candidate.uri)) continue;
      reserved.add(candidate.uri);
      try {
        if (!(await port.stat(candidate.uri)).exists) return candidate;
      } catch (error) {
        reserved.delete(candidate.uri);
        throw error;
      }
      reserved.delete(candidate.uri);
    }
    throw collision();
  }

  /** Confirms device storage is readable before recording. A repeat start in the same minute is allowed. */
  async function assertAvailable(startedAt: Date): Promise<void> {
    try {
      await port.stat(target(startedAt, 1).uri);
    } catch (error) {
      throw asStorageError(error);
    }
  }

  async function publish(sourceUri: string, saved: SavedRecording): Promise<SavedRecording> {
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
    completed.set(sourceUri, saved);
    // Cache cleanup cannot turn a successful save into a failure.
    try { await port.remove(sourceUri); } catch { /* The OS can reclaim the cache later. */ }
    return saved;
  }

  async function performSave(sourceUri: string, startedAt: Date): Promise<SavedRecording> {
    const existingSuccess = completed.get(sourceUri);
    if (existingSuccess && (await port.stat(existingSuccess.uri)).size > 0) return existingSuccess;

    if (!/^file:\/\//i.test(sourceUri) || !/\.m4a$/i.test(sourceUri)) {
      throw new RecordingStorageError('FORMAT', '기기의 M4A 녹음 파일만 저장할 수 있어요.');
    }
    const saved = await reserve(startedAt);
    try {
      return await publish(sourceUri, saved);
    } finally {
      reserved.delete(saved.uri);
    }
  }

  function save(sourceUri: string, startedAt: Date): Promise<SavedRecording> {
    const running = inFlight.get(sourceUri);
    if (running) return running;
    const promise = performSave(sourceUri, startedAt)
      .catch((error: unknown) => { throw asStorageError(error); })
      .finally(() => { inFlight.delete(sourceUri); });
    inFlight.set(sourceUri, promise);
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
          if (!latest || compareRecordings(name, latest) < 0) latest = { ...name, uri: file.uri };
        }
      }
      return { todayCount, latest };
    } catch {
      throw new RecordingStorageError('IO', '저장된 녹음을 확인하지 못했어요. 다시 확인해 주세요.');
    }
  }

  return { assertAvailable, save, getSummary };
}
