import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSyncedLibrary, type SyncStore, type UploadEntry, type ServerRecording, type RecordingRemote } from '../src/library/sync';
import { createLibraryController } from '../src/library/controller';
import type { RecordingLibrary } from '../src/library/types';
import type { SavedRecording } from '../src/recording/storage';

function setup() {
  const saved: SavedRecording = { uri: 'file:///account/2026-11-04/2026-11-04_09-10.m4a', fileName: '2026-11-04_09-10.m4a', dateKey: '2026-11-04', startTime: '09:10' };
  const files = [saved];
  const old = { ...saved, uri: 'file:///legacy/old.m4a' };
  const legacy: RecordingLibrary = { available: true, async list() { return [old]; }, async validate() {}, async remove() {} };
  let entries: UploadEntry[] = [{ saved, recordedAt: '2026-11-04T09:10:11+09:00', duration: 2.5, key: 'persisted-key' }];
  let cache: ServerRecording[] = [];
  let offline = true;
  let loseResponse = false;
  let writes = 0;
  const rows = new Map<string, ServerRecording>();
  const keys: string[] = [];
  const store: SyncStore = {
    async entries() { return structuredClone(entries); },
    async put(entry) { entries = [structuredClone(entry)]; },
    async cache(items) { if (items) cache = structuredClone(items); return structuredClone(cache); },
  };
  const local: RecordingLibrary = { available: true, async list() { return [...files]; },
    async validate(item) { if (!files.some(f => f.uri === item.uri)) throw new Error('missing'); },
    async remove(item) { const i = files.findIndex(f => f.uri === item.uri); if (i < 0) throw new Error('missing'); files.splice(i, 1); } };
  const remote: RecordingRemote = {
    async upload(entry) {
      keys.push(entry.key);
      if (offline) throw new Error('offline');
      if (!rows.has(entry.key)) { writes++; rows.set(entry.key, { recording_id: 'R' + writes, title: saved.fileName,
        recorded_at: entry.recordedAt, duration_seconds: entry.duration, size_bytes: 2048, content_type: 'audio/mp4', status: '대기', created_at: entry.recordedAt }); }
      if (loseResponse) { loseResponse = false; throw new Error('response lost'); }
      return rows.get(entry.key)!;
    },
    async list() { if (offline) throw new Error('offline'); return [...rows.values()]; },
    async remove(id) { if (offline) throw new Error('offline'); for (const [key, row] of rows) if (row.recording_id === id) rows.delete(key); },
    async playback() { return 'file:///temporary/server.m4a'; },
    async cleanup() {},
  };
  const library = createSyncedLibrary(local, legacy, store, remote);
  return { library, store, remote, files, keys, rows, saved, writes: () => writes,
    connect() { offline = false; }, disconnect() { offline = true; }, loseResponse() { loseResponse = true; } };
}

test('offline list and app resume do not upload; refresh retries and deduplicates', async () => {
  const s = setup();
  const controller = createLibraryController(s.library, () => { throw new Error('unused'); });
  await controller.showRecordings(); await controller.resume();
  assert.equal(s.keys.length, 0);
  await controller.refresh();
  assert.match(controller.getSnapshot().notice!, /보존/);
  assert.equal(s.files.length, 1);
  await s.library.validate(s.saved);
  s.connect(); await controller.refresh();
  assert.equal(s.writes(), 1);
  assert.equal((await s.library.list()).length, 2);
  assert.equal((await s.library.list()).find(row => row.serverId)?.location, 'both');
  await controller.refresh(); assert.equal(s.writes(), 1);
  controller.dispose();
});

test('lost upload response reuses the persisted key without a duplicate', async () => {
  const s = setup(); s.connect(); s.loseResponse();
  await s.library.synchronize!();
  assert.equal((await s.store.entries())[0].serverId, undefined);
  assert.equal(s.writes(), 1);
  await s.library.synchronize!();
  assert.deepEqual(s.keys, ['persisted-key', 'persisted-key']);
  assert.equal(s.writes(), 1);
  assert.equal((await s.store.entries())[0].serverId, 'R1');
});

test('device-only deletion retains a server row and authenticated temporary playback', async () => {
  const s = setup(); s.connect(); await s.library.synchronize!();
  await s.library.remove((await s.library.list()).find(row => row.serverId)!, 'device');
  const server = (await s.library.list()).find(row => row.serverId)!;
  assert.equal(server.location, 'server'); await s.library.validate(server);
  assert.equal(await s.library.playbackUri!(server), 'file:///temporary/server.m4a');
  assert.equal(s.rows.size, 1);
});

test('server-only deletion retains local audio and refresh never resurrects it', async () => {
  const s = setup(); s.connect(); await s.library.synchronize!();
  await s.library.remove((await s.library.list()).find(row => row.serverId)!, 'server');
  await s.library.synchronize!();
  assert.equal(s.files.length, 1); assert.equal(s.rows.size, 0); assert.equal(s.writes(), 1);
});

test('offline combined deletion never removes the local original', async () => {
  const s = setup(); s.connect(); await s.library.synchronize!(); s.disconnect();
  await assert.rejects(s.library.remove((await s.library.list()).find(row => row.serverId)!, 'both'));
  assert.equal(s.files.length, 1); assert.equal(s.rows.size, 1);
});

test('remote deletion is reconciled instead of uploading the local copy again', async () => {
  const s = setup(); s.connect(); await s.library.synchronize!(); s.rows.clear();
  await s.library.synchronize!();
  assert.equal((await s.store.entries())[0].serverDeleted, true);
  await s.library.synchronize!(); assert.equal(s.writes(), 1);
});

test('repeated refresh taps cannot issue parallel uploads or allow deletion during sync', async () => {
  const s = setup(); s.connect();
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const upload = s.remote.upload;
  s.remote.upload = async (entry, signal) => { await wait; return upload(entry, signal); };
  const controller = createLibraryController(s.library, () => { throw new Error('unused'); });
  await controller.showRecordings(); const first = controller.refresh();
  assert.equal(controller.getSnapshot().syncing, true);
  await controller.refresh(); assert.equal(await controller.leave(), false);
  finish(); await first;
  assert.equal(s.writes(), 1); assert.equal(controller.getSnapshot().syncing, false);
  controller.dispose();
});
