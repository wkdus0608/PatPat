import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLibraryController } from '../src/library/controller';
import { describeRecording } from '../src/recording/files';
import type { SavedRecording } from '../src/recording/storage';
import type { JournalSource, LibraryPlayer, PlaybackStatus, RecordingLibrary } from '../src/library/types';

const recording = (minute: number): SavedRecording => {
  const name = describeRecording(new Date(2026, 10, 1, 9, minute));
  return { ...name, uri: `file:///documents/recordings/${name.dateKey}/${name.fileName}` };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(journalSource?: JournalSource) {
  const files = [recording(20), recording(10)];
  const players: (LibraryPlayer & { status: PlaybackStatus; released: boolean; pauses: number; plays: number })[] = [];
  let listError = false;
  let deleteError = false;
  let releaseError = false;
  let validateError = false;
  let validateWait: Promise<void> | null = null;
  let releaseWait: Promise<void> | null = null;
  let removeWait: Promise<void> | null = null;
  let clock = 0;
  let removed = 0;
  const repository: RecordingLibrary = {
    available: true,
    async list() { if (listError) throw new Error('Disk unavailable'); return [...files]; },
    async validate() {
      if (validateWait) await validateWait;
      if (validateError) throw new Error('Missing file');
    },
    async remove(file) {
      if (removeWait) await removeWait;
      if (deleteError) throw new Error('Delete failed');
      const index = files.findIndex((item) => item.uri === file.uri);
      if (index === -1) throw new Error('Already removed');
      files.splice(index, 1); removed += 1;
    },
  };
  const controller = createLibraryController(repository, () => {
    const player = {
      status: { loaded: true, playing: false, currentTime: 0, duration: 20, finished: false } as PlaybackStatus,
      released: false, pauses: 0, plays: 0,
      async play() { player.plays += 1; player.status.playing = true; player.status.finished = false; },
      async pause() { player.pauses += 1; player.status.playing = false; },
      async seekTo(seconds: number) { player.status.currentTime = seconds; player.status.finished = false; },
      async release() {
        if (releaseWait) await releaseWait;
        if (releaseError) throw new Error('Cannot stop native player');
        player.released = true; player.status.playing = false;
      },
      getStatus() { return player.status; },
    };
    players.push(player);
    return player;
  }, journalSource, () => clock);
  return {
    controller, repository, files, players, removed: () => removed,
    listError() { listError = true; }, setDeleteError(value: boolean) { deleteError = value; },
    setReleaseError(value: boolean) { releaseError = value; },
    setValidateError(value: boolean) { validateError = value; },
    waitValidate(wait: Promise<void>) { validateWait = wait; },
    waitRelease(wait: Promise<void>) { releaseWait = wait; },
    waitRemove(wait: Promise<void>) { removeWait = wait; },
    setClock(value: number) { clock = value; },
  };
}

test('category choice opens the recording list, then detail, and back returns in order', async () => {
  const f = setup();
  assert.equal(f.controller.getSnapshot().route, 'home');
  await f.controller.showRecordings();
  assert.equal(f.controller.getSnapshot().recordings.status, 'ready');
  await f.controller.openRecording(f.files[0]);
  assert.equal(f.controller.getSnapshot().route, 'recording');
  assert.equal(f.controller.getSnapshot().player.phase, 'ready');
  assert.equal(f.players[0].plays, 0, 'opening a file must not autoplay');
  await f.controller.back();
  assert.equal(f.controller.getSnapshot().route, 'recordings');
  assert.equal(f.players[0].released, true);
  await f.controller.back();
  assert.equal(f.controller.getSnapshot().route, 'home');
});

test('web/device unavailable is distinct from an empty recording list', async () => {
  const f = setup();
  f.repository.available = false;
  await f.controller.showRecordings();
  assert.equal(f.controller.getSnapshot().recordings.status, 'unavailable');
});

test('read errors are visible instead of being replaced by an empty list', async () => {
  const f = setup(); f.listError();
  await f.controller.showRecordings();
  assert.equal(f.controller.getSnapshot().recordings.status, 'error');
});

test('a late older list response cannot replace the refreshed list', async () => {
  const f = setup();
  const old = deferred<SavedRecording[]>();
  let calls = 0;
  f.repository.list = async () => ++calls === 1 ? old.promise : [f.files[0]];
  const opening = f.controller.showRecordings();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.controller.refresh();
  old.resolve([f.files[1]]);
  await opening;
  const result = f.controller.getSnapshot().recordings;
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.data[0].uri, f.files[0].uri);
});

test('play, pause and restart use one player and finishing permits replay from the start', async () => {
  const f = setup(); await f.controller.openRecording(f.files[0]);
  await f.controller.togglePlay();
  assert.equal(f.controller.getSnapshot().player.phase, 'playing');
  await f.controller.togglePlay();
  assert.equal(f.controller.getSnapshot().player.phase, 'paused');
  f.players[0].status.currentTime = 9;
  await f.controller.restart();
  assert.equal(f.players[0].status.currentTime, 0);
  f.players[0].status = { ...f.players[0].status, playing: false, finished: true, currentTime: 20 };
  f.controller.poll();
  assert.equal(f.controller.getSnapshot().player.phase, 'finished');
  await f.controller.togglePlay();
  assert.equal(f.players[0].status.currentTime, 0);
  assert.equal(f.players.length, 1);
});

test('changing files releases the previous player and never autoplays the next one', async () => {
  const f = setup(); await f.controller.openRecording(f.files[0]);
  await f.controller.togglePlay();
  await f.controller.openRecording(f.files[1]);
  assert.equal(f.players[0].released, true);
  assert.equal(f.players[1].plays, 0);
  assert.equal(f.controller.getSnapshot().selectedRecording?.uri, f.files[1].uri);
});

test('pause remains available when the file becomes unreadable during playback', async () => {
  const f = setup(); await f.controller.openRecording(f.files[0]);
  await f.controller.togglePlay(); f.setValidateError(true);
  await f.controller.togglePlay();
  assert.equal(f.players[0].status.playing, false);
  assert.equal(f.controller.getSnapshot().player.phase, 'paused');
});

test('leaving waits for native release, and a failed release prevents tab transition', async () => {
  const f = setup(); await f.controller.openRecording(f.files[0]);
  f.setReleaseError(true);
  assert.equal(await f.controller.leave(), false);
  assert.equal(f.players[0].released, false);
  f.setReleaseError(false);
  const wait = deferred<void>(); f.waitRelease(wait.promise);
  let left = false;
  const leaving = f.controller.leave().then((value) => { left = value; });
  await Promise.resolve();
  assert.equal(left, false);
  wait.resolve(); await leaving;
  assert.equal(left, true);
  assert.equal(f.players[0].released, true);
});

test('a late validation result never creates a player after leaving', async () => {
  const f = setup(); const wait = deferred<void>(); f.waitValidate(wait.promise);
  const opening = f.controller.openRecording(f.files[0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await f.controller.leave(), true);
  wait.resolve(); await opening;
  assert.equal(f.players.length, 0);
});

test('background releases playback and resume loads without autoplay', async () => {
  const f = setup(); await f.controller.openRecording(f.files[0]);
  await f.controller.togglePlay(); await f.controller.suspend();
  assert.equal(f.players[0].released, true);
  await f.controller.resume();
  assert.equal(f.players[1].plays, 0);
  assert.equal(f.controller.getSnapshot().player.phase, 'ready');
});

test('background during pending validation prevents hidden player creation', async () => {
  const f = setup(); const wait = deferred<void>(); f.waitValidate(wait.promise);
  const opening = f.controller.openRecording(f.files[0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.controller.suspend(); wait.resolve(); await opening;
  assert.equal(f.players.length, 0);
});

test('missing files and decoding failures are playback errors, never reported as playing', async () => {
  const f = setup(); f.setValidateError(true);
  await f.controller.openRecording(f.files[0]);
  assert.equal(f.controller.getSnapshot().player.phase, 'error');
  f.setValidateError(false); await f.controller.retryPlayback();
  f.players[0].status.error = 'decoder failure'; f.controller.poll();
  assert.equal(f.controller.getSnapshot().player.phase, 'error');
});

test('unloaded media has unknown length and a stalled load becomes a retryable error', async () => {
  const f = setup(); await f.controller.openRecording(f.files[0]);
  f.players[0].status.loaded = false;
  f.setClock(16000); f.controller.poll();
  assert.equal(f.controller.getSnapshot().player.phase, 'error');
  await f.controller.retryPlayback();
  assert.equal(f.controller.getSnapshot().player.phase, 'ready');
});

test('delete request only pauses; cancellation preserves every file', async () => {
  const f = setup(); await f.controller.openRecording(f.files[0]); await f.controller.togglePlay();
  await f.controller.requestDelete();
  assert.equal(f.controller.getSnapshot().deletePrompt, true);
  assert.equal(f.players[0].status.playing, false);
  assert.equal(f.removed(), 0);
  f.controller.cancelDelete();
  assert.equal(f.controller.getSnapshot().route, 'recording');
  assert.equal(f.files.length, 2);
  assert.equal(f.players[0].plays, 1, 'cancel must not resume');
});

test('confirmed deletion is single-shot, blocks leaving, and updates only after success', async () => {
  const f = setup(); const selected = f.files[0];
  await f.controller.openRecording(selected); await f.controller.requestDelete();
  const wait = deferred<void>(); f.waitRemove(wait.promise);
  const deleting = f.controller.confirmDelete();
  await f.controller.confirmDelete();
  assert.equal(await f.controller.leave(), false);
  assert.equal(f.controller.getSnapshot().deleting, true);
  assert.equal(f.files.length, 2);
  wait.resolve(); await deleting;
  assert.equal(f.removed(), 1);
  assert.equal(f.files.length, 1);
  assert.equal(f.controller.getSnapshot().route, 'recordings');
  assert.notEqual(f.files[0].uri, selected.uri);
});

test('failed deletion keeps detail and both files; a retry can succeed', async () => {
  const f = setup(); await f.controller.openRecording(f.files[0]); await f.controller.requestDelete();
  f.setDeleteError(true); await f.controller.confirmDelete();
  assert.equal(f.files.length, 2);
  assert.equal(f.controller.getSnapshot().route, 'recording');
  assert.equal(f.controller.getSnapshot().deletePrompt, true);
  assert.ok(f.controller.getSnapshot().notice);
  f.setDeleteError(false); await f.controller.confirmDelete();
  assert.equal(f.files.length, 1);
});

test('unconnected journal source is unavailable, while an actual empty result is ready', async () => {
  const f = setup(); await f.controller.showJournals();
  assert.equal(f.controller.getSnapshot().journals.status, 'unavailable');
  const connected = setup({ async list() { return []; }, async get() { return null; } });
  await connected.controller.showJournals();
  assert.equal(connected.controller.getSnapshot().journals.status, 'ready');
});

test('journal detail opens final teacher text, then back returns to its list', async () => {
  const item = { recordId: 'R01', childId: 'C01', recordType: '관찰일지' as const, status: '완료' as const };
  const f = setup({ async list() { return [item]; }, async get() { return { ...item, finalText: '관찰: C01이 블록을 쌓음.\n' }; } });
  await f.controller.showJournals(); await f.controller.openJournal(item);
  const detail = f.controller.getSnapshot().journalDetail;
  assert.equal(detail.status, 'ready');
  if (detail.status === 'ready') assert.equal(detail.data.finalText, '관찰: C01이 블록을 쌓음.\n');
  await f.controller.back();
  assert.equal(f.controller.getSnapshot().route, 'journals');
});
