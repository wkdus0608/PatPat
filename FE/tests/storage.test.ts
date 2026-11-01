import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRecording, parseRecordingFileName } from '../src/recording/files';
import {
  createRecordingStorage,
  RecordingStorageError,
  type FileEntry,
  type FileStat,
  type RecordingFilePort,
} from '../src/recording/storage';

/** Synthetic bytes only; no actual names or identifiable voice fixtures. */
class MemoryFiles implements RecordingFilePort {
  rootUri = 'file:///documents/recordings';
  files = new Map<string, string>();
  directories = new Set<string>();
  failCopy = false;
  failMove = false;
  failCleanup = false;
  failRead = false;
  copyCount = 0;

  async stat(uri: string): Promise<FileStat> {
    if (this.failRead) throw new Error('device read failed');
    return {
      exists: this.files.has(uri) || this.directories.has(uri),
      isDirectory: this.directories.has(uri),
      size: this.files.get(uri)?.length ?? 0,
    };
  }

  async list(uri: string): Promise<FileEntry[]> {
    const prefix = `${uri}/`;
    return [...this.directories, ...this.files.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => ({
        uri: path,
        name: path.slice(prefix.length),
        isDirectory: this.directories.has(path),
        size: this.files.get(path)?.length ?? 0,
      }));
  }

  async makeDirectory(uri: string): Promise<void> {
    this.directories.add(this.rootUri);
    this.directories.add(uri);
  }

  async copy(source: string, destination: string): Promise<void> {
    this.copyCount += 1;
    const bytes = this.files.get(source);
    if (bytes === undefined) throw new Error('source missing');
    if (this.files.has(destination)) throw new Error('copy would overwrite');
    this.files.set(destination, this.failCopy ? bytes.slice(0, 2) : bytes);
    if (this.failCopy) throw new Error('disk full during copy');
  }

  async moveNoReplace(source: string, destination: string): Promise<void> {
    if (this.failMove) throw new Error('rename failed');
    if (this.files.has(destination)) throw new RecordingStorageError('COLLISION', 'exists');
    const bytes = this.files.get(source);
    if (bytes === undefined) throw new Error('stage missing');
    this.files.set(destination, bytes);
    this.files.delete(source);
  }

  async remove(uri: string): Promise<void> {
    if (this.failCleanup && uri.startsWith('file:///cache/')) throw new Error('cache busy');
    this.files.delete(uri);
  }

  source(name = 'take', bytes = 'synthetic-recording-bytes'): string {
    const uri = `file:///cache/${name}.m4a`;
    this.files.set(uri, bytes);
    return uri;
  }
}

const start = (hour = 9, minute = 10, day = 1) => new Date(2026, 10, day, hour, minute, 59, 999);
const hasCode = (code: string) => (error: unknown) =>
  error instanceof RecordingStorageError && error.code === code;

test('uses local start date and minute only, including valid leap-day parsing', () => {
  assert.deepEqual(describeRecording(start()), {
    dateKey: '2026-11-01', fileName: '2026-11-01_09-10.m4a', startTime: '09:10',
  });
  assert.ok(parseRecordingFileName('2028-02-29_23-59.m4a', '2028-02-29'));
  assert.equal(parseRecordingFileName('2026-02-29_09-10.m4a', '2026-02-29'), null);
  assert.equal(parseRecordingFileName('2026-11-01_24-10.m4a', '2026-11-01'), null);
  assert.equal(parseRecordingFileName('2026-11-01_09-60.m4a', '2026-11-01'), null);
});

test('ten recordings in one day remain separate and survive storage re-creation', async () => {
  const files = new MemoryFiles();
  const storage = createRecordingStorage(files);
  for (let minute = 10; minute < 20; minute += 1) {
    const source = files.source(`take-${minute}`, `synthetic-bytes-${minute}`);
    await storage.assertAvailable(start(9, minute));
    await storage.save(source, start(9, minute));
  }
  const restored = createRecordingStorage(files);
  const summary = await restored.getSummary(start());
  assert.equal(summary.todayCount, 10);
  assert.equal(summary.latest?.fileName, '2026-11-01_09-19.m4a');
  const first = `${files.rootUri}/2026-11-01/2026-11-01_09-10.m4a`;
  assert.equal(files.files.get(first), 'synthetic-bytes-10');
  await restored.save(files.source('next'), start(10, 0));
  assert.equal((await restored.getSummary(start())).todayCount, 11);
  assert.equal(files.files.get(first), 'synthetic-bytes-10');
});

test('minute collisions preserve both the existing file and unsaved new source', async () => {
  const files = new MemoryFiles();
  const storage = createRecordingStorage(files);
  const saved = await storage.save(files.source('first', 'original-bytes'), start());
  const newSource = files.source('second', 'new-bytes');
  await assert.rejects(storage.assertAvailable(start()), hasCode('COLLISION'));
  await assert.rejects(storage.save(newSource, start()), hasCode('COLLISION'));
  assert.equal(files.files.get(saved.uri), 'original-bytes');
  assert.equal(files.files.get(newSource), 'new-bytes');
  assert.equal((await storage.getSummary(start())).todayCount, 1);
});

test('rejects missing, empty, and non-M4A input without registering a recording', async () => {
  const files = new MemoryFiles();
  const storage = createRecordingStorage(files);
  await assert.rejects(storage.save('file:///cache/missing.m4a', start()), hasCode('EMPTY'));
  await assert.rejects(storage.save(files.source('empty', ''), start()), hasCode('EMPTY'));
  await assert.rejects(storage.save('file:///cache/web-recording.webm', start()), hasCode('FORMAT'));
  await assert.rejects(storage.save('https://example.test/voice.m4a', start()), hasCode('FORMAT'));
  assert.deepEqual(await storage.getSummary(start()), { todayCount: 0, latest: null });
});

test('partial copy is excluded and source remains available for retry', async () => {
  const files = new MemoryFiles();
  const storage = createRecordingStorage(files);
  await storage.save(files.source('previous', 'keep-previous'), start(8, 0));
  const source = files.source('retry');
  files.failCopy = true;
  await assert.rejects(storage.save(source, start()), hasCode('IO'));
  assert.ok(files.files.has(source));
  assert.equal((await storage.getSummary(start())).todayCount, 1);
  assert.ok([...files.files.keys()].some((uri) => uri.endsWith('.pending')));
  files.failCopy = false;
  await storage.save(source, start());
  assert.equal((await storage.getSummary(start())).todayCount, 2);
  assert.equal(files.files.get(`${files.rootUri}/2026-11-01/2026-11-01_08-00.m4a`), 'keep-previous');
  assert.equal([...files.files.keys()].some((uri) => uri.endsWith('.pending')), false);
});

test('failed finalization preserves source and retry creates exactly one completed file', async () => {
  const files = new MemoryFiles();
  const storage = createRecordingStorage(files);
  const source = files.source();
  files.failMove = true;
  await assert.rejects(storage.save(source, start()), hasCode('IO'));
  assert.ok(files.files.has(source));
  assert.equal((await storage.getSummary(start())).todayCount, 0);
  files.failMove = false;
  const saved = await storage.save(source, start());
  assert.equal(files.files.has(source), false);
  assert.deepEqual(await storage.save(source, start()), saved);
  assert.equal((await storage.getSummary(start())).todayCount, 1);
});

test('cache cleanup failure does not turn a completed save into a failure', async () => {
  const files = new MemoryFiles();
  files.failCleanup = true;
  const storage = createRecordingStorage(files);
  const source = files.source();
  const saved = await storage.save(source, start());
  assert.ok(files.files.has(source));
  assert.ok(files.files.has(saved.uri));
  assert.equal((await storage.getSummary(start())).todayCount, 1);
});

test('concurrent identical saves share one publication; another source cannot overwrite it', async () => {
  const files = new MemoryFiles();
  const storage = createRecordingStorage(files);
  const source = files.source();
  const otherSource = files.source('other', 'other-bytes');
  const first = storage.save(source, start());
  const second = storage.save(source, start());
  await assert.rejects(storage.save(otherSource, start()), hasCode('COLLISION'));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(files.copyCount, 1);
  assert.equal(files.files.get(otherSource), 'other-bytes');
});

test('midnight uses recording start day while next-day count starts at zero', async () => {
  const files = new MemoryFiles();
  const storage = createRecordingStorage(files);
  const saved = await storage.save(files.source(), start(23, 59));
  assert.ok(saved.uri.includes('/2026-11-01/2026-11-01_23-59.m4a'));
  const nextDay = await storage.getSummary(start(0, 2, 2));
  assert.equal(nextDay.todayCount, 0);
  assert.equal(nextDay.latest?.fileName, saved.fileName);
  await storage.save(files.source('next-day'), start(0, 3, 2));
  assert.equal((await storage.getSummary(start(0, 4, 2))).todayCount, 1);
});

test('summary ignores temporary, empty, wrong-date and malformed files', async () => {
  const files = new MemoryFiles();
  const folder = `${files.rootUri}/2026-11-01`;
  await files.makeDirectory(folder);
  files.files.set(`${folder}/.2026-11-01_09-10.m4a.pending`, 'partial-bytes');
  files.files.set(`${folder}/2026-11-01_09-11.m4a`, '');
  files.files.set(`${folder}/2026-11-02_09-12.m4a`, 'wrong-day-bytes');
  files.files.set(`${folder}/2026-11-01_25-12.m4a`, 'invalid-time-bytes');
  files.files.set(`${folder}/2026-11-01_09-13-55.m4a`, 'seconds-format-bytes');
  files.files.set(`${folder}/2026-11-01_09-14.m4a`, 'completed-bytes');
  const summary = await createRecordingStorage(files).getSummary(start());
  assert.equal(summary.todayCount, 1);
  assert.equal(summary.latest?.fileName, '2026-11-01_09-14.m4a');
});

test('read failures are surfaced instead of falsely reporting an empty library', async () => {
  const files = new MemoryFiles();
  files.failRead = true;
  const storage = createRecordingStorage(files);
  await assert.rejects(storage.getSummary(start()), hasCode('IO'));
  await assert.rejects(storage.assertAvailable(start()), hasCode('IO'));
});
