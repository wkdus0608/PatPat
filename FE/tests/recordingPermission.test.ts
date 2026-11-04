import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureMicrophonePermission } from '../src/recording/permissions';
import { RecordingStorageError } from '../src/recording/storage';

test('already granted microphone permission never asks again', async () => {
  let requests = 0;
  assert.equal(await ensureMicrophonePermission({
    async read() { return { granted: true, canAskAgain: true }; },
    async request() { requests++; return { granted: true, canAskAgain: true }; },
  }), true);
  assert.equal(requests, 0);
});

test('first record requests microphone permission and can proceed when allowed', async () => {
  let requests = 0;
  assert.equal(await ensureMicrophonePermission({
    async read() { return { granted: false, canAskAgain: true }; },
    async request() { requests++; return { granted: true, canAskAgain: true }; },
  }), true);
  assert.equal(requests, 1);
});

test('permanent denial gives settings guidance without repeatedly prompting', async () => {
  let requests = 0;
  await assert.rejects(ensureMicrophonePermission({
    async read() { return { granted: false, canAskAgain: false }; },
    async request() { requests++; throw new Error('must not prompt'); },
  }), (error: unknown) => error instanceof RecordingStorageError && error.code === 'PERMISSION' && error.message.includes('설정'));
  assert.equal(requests, 0);
});

test('rejecting the permission prompt gives a specific message, not a native start error', async () => {
  await assert.rejects(ensureMicrophonePermission({
    async read() { return { granted: false, canAskAgain: true }; },
    async request() { return { granted: false, canAskAgain: false }; },
  }), (error: unknown) => error instanceof RecordingStorageError && error.message.includes('마이크'));
});
