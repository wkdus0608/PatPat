import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/api/client';
import { createSyncedLibrary, type RecordingRemote, type ServerRecording, type SyncStore, type UploadEntry } from '../src/library/sync';
import type { RecordingLibrary } from '../src/library/types';
import { describeRecording } from '../src/recording/files';
import type { SavedRecording } from '../src/recording/storage';

/** Synthetic recordings only: no real audio, names or server. */
function setup(count = 1) {
  const files: SavedRecording[] = [];
  let entries: UploadEntry[] = [];
  let cache: ServerRecording[] = [];
  const rows = new Map<string, ServerRecording>();
  const behavior = { offline: false, reject: new Set<string>(), uploads: [] as string[], gate: null as Promise<void> | null };
  const store: SyncStore = {
    async entries() { return structuredClone(entries); },
    async put(entry) { entries = [...entries.filter(e => e.key !== entry.key), structuredClone(entry)]; },
    async cache(items) { if (items) cache = structuredClone(items); return structuredClone(cache); },
  };
  function record(minute: number, sequence = 1) {
    const started = new Date(2026, 10, 4, 9, minute);
    const saved: SavedRecording = { ...describeRecording(started, sequence), uri: `file:///account/2026-11-04/${describeRecording(started, sequence).fileName}` };
    files.push(saved);
    entries.push({ saved, key: `key-${saved.fileName}`, recordedAt: started.toISOString(), duration: 3 });
    return saved;
  }
  const local: RecordingLibrary = { available: true, async list() { return [...files]; },
    async validate(item) { if (!files.some(f => f.uri === item.uri)) throw new Error('missing'); },
    async remove() {} };
  const legacy: RecordingLibrary = { available: true, async list() { return []; }, async validate() {}, async remove() {} };
  const remote: RecordingRemote = {
    async upload(entry) {
      behavior.uploads.push(entry.saved.fileName);
      if (behavior.gate) await behavior.gate;
      if (behavior.offline) throw new Error('offline');
      if (behavior.reject.has(entry.saved.fileName)) throw new ApiError(415, 'UNSUPPORTED_AUDIO_TYPE', 'rejected');
      const row: ServerRecording = { recording_id: 'R-' + entry.key, title: entry.saved.fileName, recorded_at: entry.recordedAt,
        duration_seconds: entry.duration, size_bytes: 1024, content_type: 'audio/mp4', status: '대기', created_at: entry.recordedAt };
      rows.set(row.recording_id, row);
      return row;
    },
    async list() { return [...rows.values()]; },
    async remove() {}, async playback() { return 'file:///x.m4a'; }, async cleanup() {},
  };
  for (let minute = 0; minute < count; minute++) record(10 + minute);
  return { library: createSyncedLibrary(local, legacy, store, remote), store, rows, behavior, record };
}

test('autoSync uploads a fresh recording right away while online, without a manual refresh', async () => {
  const s = setup();
  const result = await s.library.autoSync();
  assert.deepEqual(result, { uploaded: 1, remaining: 0, failed: false });
  assert.equal(s.rows.size, 1);
  assert.equal((await s.library.list())[0].location, 'both');
});

test('offline autoSync keeps the recording and reports a retryable failure; the next pass uploads it once', async () => {
  const s = setup();
  s.behavior.offline = true;
  assert.deepEqual(await s.library.autoSync(), { uploaded: 0, remaining: 1, failed: true });
  assert.equal(s.rows.size, 0);
  assert.equal((await s.library.list())[0].location, 'device');
  s.behavior.offline = false;
  assert.deepEqual(await s.library.autoSync(), { uploaded: 1, remaining: 0, failed: false });
  assert.deepEqual(await s.library.autoSync(), { uploaded: 0, remaining: 0, failed: false });
  assert.equal(s.rows.size, 1);
  assert.equal(s.behavior.uploads.length, 2);
});

test('a recording saved while a pass is running is uploaded by the follow-up pass', async () => {
  const s = setup();
  let release!: () => void;
  s.behavior.gate = new Promise<void>(resolve => { release = resolve; });
  const first = s.library.autoSync();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.behavior.uploads.length, 1, 'first pass is blocked mid-upload');
  // A new take is saved now and asks for another pass instead of being dropped.
  s.record(11);
  const second = s.library.autoSync();
  s.behavior.gate = null; release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.failed, false);
  assert.deepEqual(b, { uploaded: 1, remaining: 0, failed: false });
  assert.equal(s.rows.size, 2);
});

test('same-minute takes both upload as separate recordings', async () => {
  const s = setup(0);
  s.record(10, 1); s.record(10, 2);
  assert.deepEqual(await s.library.autoSync(), { uploaded: 2, remaining: 0, failed: false });
  assert.deepEqual([...s.rows.values()].map(r => r.title).sort(), ['2026-11-04_09-10.m4a', '2026-11-04_09-10_2.m4a']);
  assert.deepEqual((await s.library.list()).map(r => r.fileName), ['2026-11-04_09-10_2.m4a', '2026-11-04_09-10.m4a']);
});

test('a file the server permanently refuses does not block later recordings', async () => {
  const s = setup(0);
  const bad = s.record(10); s.record(11);
  s.behavior.reject.add(bad.fileName);
  const result = await s.library.autoSync();
  assert.deepEqual(result, { uploaded: 1, remaining: 0, failed: false });
  assert.deepEqual([...s.rows.values()].map(r => r.title), ['2026-11-04_09-11.m4a']);
  // The refused file stays on the device and is not retried in a loop this session.
  await s.library.autoSync();
  assert.equal(s.behavior.uploads.filter(name => name === bad.fileName).length, 1);
});
