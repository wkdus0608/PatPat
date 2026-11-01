import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createManagedPlayer, type NativePlaybackHandle, type NativePlaybackStatus } from '../src/library/managedPlayer';

function fixture() {
  const status: NativePlaybackStatus = {
    isLoaded: false, playing: false, currentTime: 0, duration: 0, playbackState: 'idle', error: null,
  };
  let listener: (value: NativePlaybackStatus) => void = () => {};
  let removeError = false;
  let pauseError = false;
  let modeWait = Promise.resolve();
  const calls = { play: 0, pause: 0, remove: 0, unsubscribe: 0 };
  const native: NativePlaybackHandle = {
    currentStatus: status,
    play() { calls.play += 1; status.playing = true; },
    pause() { calls.pause += 1; if (pauseError) throw new Error('Native pause failed'); status.playing = false; },
    remove() { calls.remove += 1; if (removeError) throw new Error('Native remove failed'); },
    async seekTo(seconds) { status.currentTime = seconds; },
    addListener(_event, callback) { listener = callback; return { remove() { calls.unsubscribe += 1; } }; },
  };
  return {
    player: createManagedPlayer(native, () => modeWait), status, calls,
    setModeWait(promise: Promise<void>) { modeWait = promise; },
    failRemove(value: boolean) { removeError = value; },
    failPause() { pauseError = true; },
    emit(patch: Partial<NativePlaybackStatus>) { Object.assign(status, patch); listener(status); },
  };
}

function wait() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test('a pause cancels play waiting for audio-mode setup', async () => {
  const f = fixture(); const mode = wait(); f.setModeWait(mode.promise);
  const playing = f.player.play();
  await f.player.pause(); mode.resolve(); await playing;
  assert.equal(f.calls.play, 0);
});

test('release cancels delayed play and closes native audio once', async () => {
  const f = fixture(); const mode = wait(); f.setModeWait(mode.promise);
  const playing = f.player.play();
  let closed = false;
  const closing = f.player.release().then(() => { closed = true; });
  const duplicate = f.player.release();
  await Promise.resolve();
  assert.equal(closed, false, 'release must wait for a pending mode change before a new recording can start');
  mode.resolve(); await Promise.all([playing, closing, duplicate]);
  assert.equal(f.calls.play, 0);
  assert.equal(f.calls.remove, 1);
  assert.equal(f.calls.unsubscribe, 1);
  await assert.rejects(f.player.play());
});

test('failed native release is not treated as success and can be retried', async () => {
  const f = fixture(); f.failRemove(true);
  await assert.rejects(f.player.release());
  assert.equal(f.calls.unsubscribe, 0);
  f.failRemove(false); await f.player.release();
  assert.equal(f.calls.remove, 2);
  assert.equal(f.calls.unsubscribe, 1);
});

test('pause failure still attempts native removal instead of trapping playback on screen', async () => {
  const f = fixture(); f.failPause();
  await f.player.release();
  assert.equal(f.calls.remove, 1);
  assert.equal(f.calls.unsubscribe, 1);
  await assert.rejects(f.player.play());
});

test('decoder failure is latched and a later successful event cannot resume audio', async () => {
  const f = fixture(); await f.player.play();
  f.emit({ error: 'Decoder failed', playbackState: 'error' });
  assert.equal(f.status.playing, false);
  f.emit({ error: null, playbackState: 'ready' });
  assert.ok(f.player.getStatus().error);
  await assert.rejects(f.player.play());
});

test('media-services reset cancels a pending start instead of automatically resuming', async () => {
  const f = fixture(); const mode = wait(); f.setModeWait(mode.promise);
  const playing = f.player.play();
  f.emit({ mediaServicesDidReset: true });
  mode.resolve(); await playing;
  assert.equal(f.calls.play, 0);
  assert.ok(f.player.getStatus().error);
});

test('duration remains unknown until loaded and finite; elapsed time is clamped', () => {
  const f = fixture(); f.status.duration = 20;
  assert.equal(f.player.getStatus().duration, null);
  f.status.isLoaded = true;
  assert.equal(f.player.getStatus().duration, 20);
  f.status.duration = Infinity; f.status.currentTime = NaN;
  assert.equal(f.player.getStatus().duration, null);
  assert.equal(f.player.getStatus().currentTime, 0);
});

test('completion persists across status polling, and seek/play resets completion', async () => {
  const f = fixture(); f.emit({ didJustFinish: true });
  f.emit({ didJustFinish: false });
  assert.equal(f.player.getStatus().finished, true);
  await f.player.seekTo(0);
  assert.equal(f.player.getStatus().finished, false);
  f.emit({ didJustFinish: true });
  f.emit({ didJustFinish: false });
  await f.player.play();
  assert.equal(f.player.getStatus().finished, false);
});
