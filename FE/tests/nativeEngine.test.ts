import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecordingController } from '../src/recording/controller';
import { createNativeEngine, type NativeRecorder } from '../src/recording/nativeEngine';
import { RecordingStorageError, type RecordingStorage } from '../src/recording/storage';

function setup() {
  const state = { granted: true, active: false, duration: 0, uri: 'file:///cache/test.m4a' as string | null };
  const calls = { permission: 0, prepare: 0, record: 0, stop: 0, modes: [] as boolean[], waits: [] as number[] };
  let duringWait: ((milliseconds: number) => void) | null = null;
  const recorder: NativeRecorder = {
    get uri() { return state.uri; },
    async prepareToRecordAsync() { calls.prepare += 1; },
    record() { calls.record += 1; state.active = true; },
    async stop() {
      calls.stop += 1;
      state.active = false;
      // The native SDK resets its elapsed duration when recording finishes.
      state.duration = 0;
    },
    getStatus() { return { isRecording: state.active, durationMillis: state.duration }; },
  };
  const adapter = createNativeEngine(recorder, {
    async getPermission() { calls.permission += 1; return state.granted; },
    async setMode(recording) { calls.modes.push(recording); },
    async wait(milliseconds) { calls.waits.push(milliseconds); duringWait?.(milliseconds); },
  });
  return {
    adapter, recorder, state, calls,
    onWait(callback: (milliseconds: number) => void) { duringWait = callback; },
  };
}

test('denied microphone permission performs only a permission read', async () => {
  const f = setup();
  f.state.granted = false;
  await assert.rejects(f.adapter.engine.prepare(), /Microphone/);
  assert.equal(f.calls.permission, 1);
  assert.equal(f.calls.prepare, 0);
  assert.deepEqual(f.calls.modes, []);
  assert.equal(f.calls.record, 0);
});

test('record() without native recording never succeeds after the 500 ms settle window', async () => {
  const f = setup();
  f.recorder.record = () => { f.calls.record += 1; };
  await f.adapter.engine.prepare();
  await assert.rejects(f.adapter.engine.start(), /did not start/);
  assert.equal(f.calls.record, 1);
  assert.equal(f.calls.waits.reduce((total, delay) => total + delay, 0), 500);
  assert.equal(f.adapter.engine.getStatus().isRecording, false);
});

test('a delayed native start can settle within 500 ms', async () => {
  const f = setup();
  f.recorder.record = () => { f.calls.record += 1; };
  f.onWait(() => {
    if (f.calls.waits.reduce((total, delay) => total + delay, 0) === 500) f.state.active = true;
  });
  await f.adapter.engine.prepare();
  await f.adapter.engine.start();
  assert.equal(f.adapter.engine.getStatus().isRecording, true);
  assert.equal(f.calls.record, 1);
});

test('Android resolved stop plus a native error event never publishes a saved file', async () => {
  const f = setup();
  let saves = 0;
  const storage: RecordingStorage = {
    async assertAvailable() {},
    async save() { saves += 1; throw new Error('Invalid audio must never reach storage'); },
    async getSummary() { return { todayCount: 0, latest: null }; },
  };
  // SDK Android can resolve stop() but emit hasError separately on the event queue.
  f.onWait((milliseconds) => {
    if (milliseconds === 0) f.adapter.onStatus({ hasError: true, isFinished: true });
  });
  const controller = createRecordingController(f.adapter.engine, storage);
  await controller.start();
  f.state.duration = 1200;
  await controller.stop();
  assert.equal(saves, 0);
  assert.equal(controller.getSnapshot().phase, 'error');
  assert.equal(controller.getSnapshot().canStart, true);
  assert.equal(controller.getSnapshot().canRetry, false);
  assert.deepEqual(f.calls.modes, [true, false]);
});

test('later successful completion and stop retry cannot clear the native error latch', async () => {
  const f = setup();
  await f.adapter.engine.prepare();
  await f.adapter.engine.start();
  f.state.duration = 1200;
  f.adapter.onStatus({ hasError: true, isFinished: true });
  f.adapter.onStatus({ hasError: false, isFinished: true });
  await assert.rejects(f.adapter.engine.stop(), (error: unknown) => (
    error instanceof RecordingStorageError && error.code === 'EMPTY'
  ));
  f.adapter.onStatus({ hasError: false, isFinished: true });
  await assert.rejects(f.adapter.engine.stop(), RecordingStorageError);

  // Only preparation of a new recording makes the next file eligible again.
  await f.adapter.engine.prepare();
  await f.adapter.engine.start();
  f.state.duration = 800;
  assert.deepEqual(await f.adapter.engine.stop(), { uri: f.state.uri, durationMillis: 800 });
});

test('the last observed duration survives a native interruption and duration reset', async () => {
  const f = setup();
  await f.adapter.engine.prepare();
  await f.adapter.engine.start();
  f.state.duration = 4300;
  assert.equal(f.adapter.engine.getStatus().durationMillis, 4300);
  f.state.active = false;
  f.state.duration = 0;
  f.adapter.onStatus({ hasError: false, isFinished: true });
  assert.deepEqual(await f.adapter.engine.stop(), { uri: f.state.uri, durationMillis: 4300 });
  assert.equal(f.adapter.engine.getStatus().durationMillis, 4300);
});

test('already-stopped native rejection is tolerated only with a stopped recorder and a URI', async () => {
  const f = setup();
  await f.adapter.engine.prepare();
  await f.adapter.engine.start();
  f.state.duration = 900;
  f.adapter.engine.getStatus();
  f.state.active = false;
  f.state.duration = 0;
  const stopped = new Error('Recorder already stopped');
  f.recorder.stop = async () => { throw stopped; };
  assert.deepEqual(await f.adapter.engine.stop(), { uri: f.state.uri, durationMillis: 900 });

  f.state.uri = null;
  await assert.rejects(f.adapter.engine.stop(), (error: unknown) => error === stopped);
  f.state.uri = 'file:///cache/test.m4a';
  f.state.active = true;
  await assert.rejects(f.adapter.engine.stop(), (error: unknown) => error === stopped);
});

test('canceling preparation always resets audio mode even when native stop rejects', async () => {
  const f = setup();
  await f.adapter.engine.prepare();
  const failure = new Error('No active recorder');
  f.recorder.stop = async () => { throw failure; };
  await assert.rejects(f.adapter.engine.cancelPreparation(), (error: unknown) => error === failure);
  assert.deepEqual(f.calls.modes, [true, false]);
});

test('cancellation does not clear a native error from the current recording', async () => {
  const f = setup();
  await f.adapter.engine.prepare();
  f.adapter.onStatus({ hasError: true, isFinished: true });
  await f.adapter.engine.cancelPreparation();
  await assert.rejects(f.adapter.engine.stop(), RecordingStorageError);
});
