import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecordingController, type RecordingEngine } from '../src/recording/controller';
import { describeRecording } from '../src/recording/files';
import { RecordingStorageError, type RecordingStorage } from '../src/recording/storage';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const calls = { prepare: 0, start: 0, stop: 0, save: 0, cancel: 0 };
  let active = false;
  let current = new Date(2026, 10, 1, 9, 10);
  let saveFailure: Error | null = null;
  let summaryFailure = false;
  let stopFailure = false;
  let startFailure = false;
  let prepareWait: Promise<void> | null = null;
  let saveWait: Promise<void> | null = null;
  const savedDates: Date[] = [];
  const savedUris: string[] = [];
  const engine: RecordingEngine = {
    async prepare() { calls.prepare += 1; if (prepareWait) await prepareWait; },
    async start() {
      calls.start += 1;
      if (startFailure) throw new Error('Native start failed');
      active = true;
    },
    async stop() {
      calls.stop += 1;
      if (stopFailure) throw new Error('Native stop failed');
      active = false;
      return { uri: 'file:///cache/test.m4a', durationMillis: 5000 };
    },
    async cancelPreparation() { calls.cancel += 1; active = false; },
    getStatus() { return { isRecording: active, durationMillis: 5000 }; },
  };
  const storage: RecordingStorage = {
    async assertAvailable() {},
    async save(uri, date) {
      calls.save += 1;
      if (saveWait) await saveWait;
      if (saveFailure) throw saveFailure;
      savedDates.push(date);
      savedUris.push(uri);
      return { ...describeRecording(date), uri: 'file:///recordings/saved.m4a' };
    },
    async getSummary() {
      if (summaryFailure) throw new Error('Read unavailable');
      return {
        todayCount: savedDates.length,
        latest: savedDates.length
          ? { ...describeRecording(savedDates.at(-1)!), uri: 'file:///recordings/saved.m4a' } : null,
      };
    },
  };
  const controller = createRecordingController(engine, storage, () => current);
  return {
    controller, calls, storage, savedDates, savedUris,
    setDate(date: Date) { current = date; },
    setSaveFailure(error: Error | null) { saveFailure = error; },
    setSummaryFailure() { summaryFailure = true; },
    setStopFailure(value: boolean) { stopFailure = value; },
    setStartFailure() { startFailure = true; },
    setPrepareWait(wait: Promise<void>) { prepareWait = wait; },
    setSaveWait(wait: Promise<void>) { saveWait = wait; },
    nativeInterrupt() { active = false; },
  };
}

test('rapid start taps create only one recording; stop taps publish only one file', async () => {
  const f = setup();
  await Promise.all([f.controller.start(), f.controller.start(), f.controller.start()]);
  assert.equal(f.calls.start, 1);
  const wait = deferred();
  f.setSaveWait(wait.promise);
  const saving = f.controller.stop();
  await f.controller.stop();
  assert.equal(f.controller.getSnapshot().phase, 'saving');
  assert.equal(f.controller.getSnapshot().canStart, false);
  wait.resolve();
  await saving;
  assert.equal(f.calls.stop, 1);
  assert.equal(f.calls.save, 1);
  assert.equal(f.controller.getSnapshot().phase, 'saved');
  assert.equal(f.controller.getSnapshot().todayCount, 1);
});

test('minute collision is rejected before the microphone starts', async () => {
  const f = setup();
  f.storage.assertAvailable = async () => { throw new RecordingStorageError('COLLISION', '파일명 충돌'); };
  await f.controller.start();
  assert.equal(f.calls.start, 0);
  assert.equal(f.controller.getSnapshot().phase, 'error');
  assert.equal(f.controller.getSnapshot().canStart, true);
});

test('failed file save retains the same recording and blocks a new start until retry', async () => {
  const f = setup();
  f.setSaveFailure(new RecordingStorageError('IO', '디스크 가득 참'));
  await f.controller.start();
  await f.controller.stop();
  assert.equal(f.controller.getSnapshot().phase, 'error');
  assert.equal(f.controller.getSnapshot().canRetry, true);
  await f.controller.start();
  assert.equal(f.calls.start, 1);
  assert.equal(f.savedUris.length, 0);
  f.setSaveFailure(null);
  await Promise.all([f.controller.retry(), f.controller.retry()]);
  assert.equal(f.calls.stop, 1);
  assert.equal(f.calls.save, 2);
  assert.equal(f.savedUris.length, 1);
  assert.equal(f.controller.getSnapshot().phase, 'saved');
});

test('failed native stop stays visibly recording and polling retries the stop', async () => {
  const f = setup();
  await f.controller.start();
  f.setStopFailure(true);
  await f.controller.stop();
  assert.equal(f.controller.getSnapshot().phase, 'recording');
  assert.equal(f.controller.getSnapshot().canStart, false);
  assert.equal(f.calls.save, 0);
  f.setStopFailure(false);
  f.controller.poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.savedUris.length, 1);
});

test('empty file is not counted or marked saved and permits recording again', async () => {
  const f = setup();
  f.setSaveFailure(new RecordingStorageError('EMPTY', '녹음 없음'));
  await f.controller.start();
  await f.controller.stop();
  assert.equal(f.controller.getSnapshot().phase, 'error');
  assert.equal(f.controller.getSnapshot().canStart, true);
  assert.equal(f.controller.getSnapshot().canRetry, false);
  assert.equal(f.savedDates.length, 0);
});

test('background while preparation is pending never starts a hidden recording', async () => {
  const f = setup();
  const wait = deferred();
  f.setPrepareWait(wait.promise);
  const starting = f.controller.start();
  await Promise.resolve();
  await f.controller.interrupt();
  wait.resolve();
  await starting;
  assert.equal(f.calls.start, 0);
  assert.equal(f.calls.save, 0);
  assert.equal(f.controller.getSnapshot().phase, 'idle');
});

test('background while recording saves the existing clip and reports interruption', async () => {
  const f = setup();
  await f.controller.start();
  await f.controller.interrupt();
  assert.equal(f.savedDates.length, 1);
  assert.equal(f.controller.getSnapshot().phase, 'saved');
  assert.match(f.controller.getSnapshot().message!, /중단/);
});

test('unexpected native interruption is detected by status polling', async () => {
  const f = setup();
  await f.controller.start();
  f.nativeInterrupt();
  f.controller.poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.calls.stop, 1);
  assert.equal(f.savedDates.length, 1);
});

test('a recording crossing midnight is saved under its start date and time', async () => {
  const f = setup();
  const startedAt = new Date(2026, 10, 1, 23, 59);
  f.setDate(startedAt);
  await f.controller.start();
  f.setDate(new Date(2026, 10, 2, 0, 2));
  await f.controller.stop();
  assert.equal(f.savedDates[0], startedAt);
});

test('summary read failure after saving does not turn a saved recording into an error', async () => {
  const f = setup();
  f.setSummaryFailure();
  await f.controller.start();
  await f.controller.stop();
  const state = f.controller.getSnapshot();
  assert.equal(state.phase, 'saved');
  assert.equal(state.todayCount, null);
  assert.ok(state.summaryError);
  assert.equal(state.canRetry, false);
  assert.equal(f.calls.save, 1);
});

test('native start failure is never shown as recording or saved', async () => {
  const f = setup();
  f.setStartFailure();
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().phase, 'error');
  assert.equal(f.controller.getSnapshot().canStart, true);
  assert.equal(f.calls.save, 0);
});
