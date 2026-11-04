import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRecording } from '../src/recording/files';
import type { FileEntry, FileStat, RecordingFilePort, SavedRecording } from '../src/recording/storage';
import { createRecordingLibrary, RecordingLibraryError } from '../src/library/recordingLibrary';

class LibraryFiles implements RecordingFilePort {
  rootUri = 'file:///documents/recordings';
  files = new Map<string, string>();
  directories = new Set([this.rootUri]);
  removed: string[] = [];
  failStat = false;
  failList = false;
  failRemove = false;
  fakeRemoveSuccess = false;
  beforeStat: ((uri: string) => void) | null = null;
  extraEntries: FileEntry[] = [];
  /** expo-file-system reports directory URIs with a trailing slash; files never have one. */
  nativeDirectoryUris = false;

  async stat(uri: string): Promise<FileStat> {
    if (this.failStat) throw new Error('device read failure');
    this.beforeStat?.(uri);
    return {
      exists: this.files.has(uri) || this.directories.has(uri),
      isDirectory: this.directories.has(uri),
      size: this.files.get(uri)?.length ?? 0,
    };
  }

  async list(uri: string): Promise<FileEntry[]> {
    if (this.failList) throw new Error('directory unreadable');
    const prefix = `${uri}/`;
    return [...this.directories, ...this.files.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => ({
        uri: this.nativeDirectoryUris && this.directories.has(path) ? `${path}/` : path,
        name: path.slice(prefix.length),
        isDirectory: this.directories.has(path),
        size: this.files.get(path)?.length ?? 0,
      }))
      .concat(this.extraEntries.filter((entry) => entry.uri.startsWith(prefix)));
  }

  async remove(uri: string): Promise<void> {
    this.removed.push(uri);
    if (this.failRemove) throw new Error('delete failed');
    if (!this.fakeRemoveSuccess) this.files.delete(uri);
  }

  async makeDirectory(): Promise<void> { throw new Error('library must not create directories'); }
  async copy(): Promise<void> { throw new Error('library must not copy files'); }
  async moveNoReplace(): Promise<void> { throw new Error('library must not move files'); }

  add(day: number, hour: number, minute: number, bytes = 'synthetic-audio-bytes'): SavedRecording {
    const name = describeRecording(new Date(2026, 10, day, hour, minute));
    const folder = `${this.rootUri}/${name.dateKey}`;
    const uri = `${folder}/${name.fileName}`;
    this.directories.add(folder);
    this.files.set(uri, bytes);
    return { ...name, uri };
  }
}

const hasCode = (code: string) => (error: unknown) =>
  error instanceof RecordingLibraryError && error.code === code;

test('lists dates and times newest first, retaining independent recordings', async () => {
  const files = new LibraryFiles();
  const oldest = files.add(1, 9, 10);
  const latest = files.add(3, 8, 0);
  const laterSameDay = files.add(1, 15, 20);
  const earlierToday = files.add(3, 7, 59);
  const library = createRecordingLibrary(files);
  assert.equal(library.available, true);
  assert.deepEqual(await library.list(), [latest, earlierToday, laterSameDay, oldest]);
});

// Regression: on a real device the library showed no recordings because every date folder
// came back as `.../2026-11-04/` and never matched the slash-less path built from the root.
test('lists recordings when directory URIs end with a slash, as expo-file-system reports them', async () => {
  const files = new LibraryFiles();
  files.nativeDirectoryUris = true;
  const a = files.add(1, 9, 10);
  const b = files.add(3, 8, 0);
  const library = createRecordingLibrary(files);
  assert.deepEqual(await library.list(), [b, a]);
  await library.validate(a);
});

test('keeps several takes from the same minute as separate recordings', async () => {
  const files = new LibraryFiles();
  const first = files.add(1, 9, 10);
  const name = describeRecording(new Date(2026, 10, 1, 9, 10), 2);
  const second = { ...name, uri: `${files.rootUri}/${name.dateKey}/${name.fileName}` };
  files.files.set(second.uri, 'second-take');
  const listed = await createRecordingLibrary(files).list();
  assert.deepEqual(listed, [second, first]);
});

test('excludes pending, empty, wrong-date, malformed and directory entries', async () => {
  const files = new LibraryFiles();
  const good = files.add(1, 9, 10);
  const folder = `${files.rootUri}/2026-11-01`;
  files.files.set(`${folder}/.2026-11-01_09-11.m4a.pending`, 'partial');
  files.files.set(`${folder}/2026-11-01_09-12.m4a`, '');
  files.files.set(`${folder}/2026-11-02_09-13.m4a`, 'wrong-date');
  files.files.set(`${folder}/2026-11-01_09-14-59.m4a`, 'seconds-not-allowed');
  files.files.set(`${folder}/2026-11-01_25-15.m4a`, 'invalid-time');
  files.directories.add(`${folder}/2026-11-01_09-16.m4a`);
  files.directories.add(`${files.rootUri}/2026-02-30`);
  assert.deepEqual(await createRecordingLibrary(files).list(), [good]);
});

test('an absent or truly empty recording root is an empty result', async () => {
  const files = new LibraryFiles();
  assert.deepEqual(await createRecordingLibrary(files).list(), []);
  files.directories.clear();
  assert.deepEqual(await createRecordingLibrary(files).list(), []);
});

test('stat and list failures are errors rather than an empty library', async () => {
  const files = new LibraryFiles();
  const library = createRecordingLibrary(files);
  files.failStat = true;
  await assert.rejects(library.list(), hasCode('IO'));
  files.failStat = false;
  files.failList = true;
  await assert.rejects(library.list(), hasCode('IO'));
  files.failList = false;
  files.directories.clear();
  files.files.set(files.rootUri, 'not-a-directory');
  await assert.rejects(library.list(), hasCode('IO'));
});

test('removes only the selected recording and leaves other files and date folders', async () => {
  const files = new LibraryFiles();
  const selected = files.add(1, 9, 10);
  const other = files.add(1, 9, 11);
  const nextDay = files.add(2, 9, 10);
  const library = createRecordingLibrary(files);
  await library.remove(selected);
  assert.deepEqual(files.removed, [selected.uri]);
  assert.equal(files.files.has(selected.uri), false);
  assert.equal(files.files.has(other.uri), true);
  assert.equal(files.files.has(nextDay.uri), true);
  assert.equal(files.directories.has(`${files.rootUri}/2026-11-01`), true);
  assert.deepEqual(await library.list(), [nextDay, other]);
});

test('rejects arbitrary URLs, traversal aliases, mismatched fields and other targets before deletion', async () => {
  const files = new LibraryFiles();
  const selected = files.add(1, 9, 10);
  const library = createRecordingLibrary(files);
  const invalid: SavedRecording[] = [
    { ...selected, uri: 'https://example.test/recording.m4a' },
    { ...selected, uri: selected.uri.replace('file:///', 'content:///') },
    { ...selected, uri: `file://untrusted-host${selected.uri.slice('file://'.length)}` },
    { ...selected, uri: `file:///documents/recordings-other/2026-11-01/${selected.fileName}` },
    { ...selected, uri: `${files.rootUri}/2026-11-01/../2026-11-01/${selected.fileName}` },
    { ...selected, uri: `${files.rootUri}/2026-11-01/%2e%2e/2026-11-01/${selected.fileName}` },
    { ...selected, uri: `${files.rootUri}/2026-11-01/%252e%252e/${selected.fileName}` },
    { ...selected, uri: selected.uri.replace('_09-', '%5f09-') },
    { ...selected, uri: `${selected.uri}?other=1` },
    { ...selected, uri: `${selected.uri}#other` },
    { ...selected, uri: selected.uri.replace('/2026-11-01/', '\\2026-11-01\\') },
    { ...selected, uri: `${files.rootUri}/2026-11-01` },
    { ...selected, uri: 'file:///documents/secret.m4a' },
    { ...selected, dateKey: '../2026-11-01' },
    { ...selected, dateKey: '%2e%2e' },
    { ...selected, fileName: '../secret.m4a' },
    { ...selected, fileName: '2026-11-02_09-10.m4a' },
    { ...selected, startTime: '09:11' },
    { ...selected, uri: `${selected.uri}\0` },
  ];
  for (const item of invalid) {
    await assert.rejects(library.validate(item), hasCode('INVALID_PATH'));
    await assert.rejects(library.remove(item), hasCode('INVALID_PATH'));
  }
  await assert.rejects(library.validate(null as unknown as SavedRecording), hasCode('INVALID_PATH'));
  await assert.rejects(library.remove({} as SavedRecording), hasCode('INVALID_PATH'));
  assert.deepEqual(files.removed, []);
  assert.equal(files.files.has(selected.uri), true);
});

test('does not trust listing URIs pointing outside the matching root/date/file', async () => {
  const files = new LibraryFiles();
  const good = files.add(1, 9, 10);
  files.extraEntries.push(
    { uri: `${files.rootUri}/2026-11-01/../2026-11-02`, name: '2026-11-02', isDirectory: true, size: 0 },
    { uri: `${files.rootUri}/2026-11-01/../2026-11-01/2026-11-01_09-11.m4a`, name: '2026-11-01_09-11.m4a', isDirectory: false, size: 15 },
  );
  assert.deepEqual(await createRecordingLibrary(files).list(), [good]);
  assert.deepEqual(files.removed, []);
});

test('missing files produce NOT_FOUND instead of successful deletion', async () => {
  const files = new LibraryFiles();
  const selected = files.add(1, 9, 10);
  files.files.delete(selected.uri);
  const library = createRecordingLibrary(files);
  await assert.rejects(library.validate(selected), hasCode('NOT_FOUND'));
  await assert.rejects(library.remove(selected), hasCode('NOT_FOUND'));
  assert.deepEqual(files.removed, []);
});

test('rechecks file existence at the destructive boundary after validation', async () => {
  const files = new LibraryFiles();
  const selected = files.add(1, 9, 10);
  let fileStats = 0;
  files.beforeStat = (uri) => {
    if (uri === selected.uri && ++fileStats === 2) files.files.delete(uri);
  };
  await assert.rejects(createRecordingLibrary(files).remove(selected), hasCode('NOT_FOUND'));
  assert.deepEqual(files.removed, []);
});

test('rejects a selected path that has become a folder or an empty file', async () => {
  const files = new LibraryFiles();
  const selected = files.add(1, 9, 10);
  const library = createRecordingLibrary(files);
  files.files.delete(selected.uri);
  files.directories.add(selected.uri);
  await assert.rejects(library.remove(selected), hasCode('INVALID_PATH'));
  files.directories.delete(selected.uri);
  files.files.set(selected.uri, '');
  await assert.rejects(library.remove(selected), hasCode('INVALID_PATH'));
  assert.deepEqual(files.removed, []);
});

test('delete failure is surfaced and the selected and unrelated files remain available', async () => {
  const files = new LibraryFiles();
  const selected = files.add(1, 9, 10);
  const other = files.add(1, 9, 11);
  files.failRemove = true;
  const library = createRecordingLibrary(files);
  await assert.rejects(library.remove(selected), hasCode('IO'));
  assert.equal(files.files.has(selected.uri), true);
  assert.equal(files.files.has(other.uri), true);
  assert.deepEqual(await library.list(), [other, selected]);
});

test('does not report success when the file port leaves a file behind', async () => {
  const files = new LibraryFiles();
  const selected = files.add(1, 9, 10);
  files.fakeRemoveSuccess = true;
  await assert.rejects(createRecordingLibrary(files).remove(selected), hasCode('IO'));
  assert.equal(files.files.has(selected.uri), true);
});
