import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createStartRequestInbox, isStartRequestUrl, parseRequestTimestamp, REQUEST_MAX_AGE_MS, START_URL,
} from '../src/recording/startRequest';

test('only the record-start link counts as a start request', () => {
  assert.equal(isStartRequestUrl(START_URL), true);
  assert.equal(isStartRequestUrl('patpat://record/start/'), true);
  assert.equal(isStartRequestUrl(' PATPAT://record/start?from=shortcut '), true);
  for (const other of [null, undefined, '', 'patpat://record', 'patpat://record/stop', 'patpat://record/start/extra',
    'https://example.test/record/start', 'otherapp://record/start']) {
    assert.equal(isStartRequestUrl(other), false, String(other));
  }
});

test('request timestamps are epoch seconds from the iPhone intent', () => {
  assert.equal(parseRequestTimestamp('1730000000.5\n'), 1730000000500);
  for (const bad of ['', 'abc', '0', '-5', 'NaN', 'Infinity']) assert.equal(parseRequestTimestamp(bad), null, bad);
});

test('a fresh request is taken exactly once', () => {
  let clock = 1_000_000;
  const inbox = createStartRequestInbox(() => clock);
  assert.equal(inbox.take(), false);
  inbox.push();
  clock += 5_000;
  assert.equal(inbox.take(), true);
  assert.equal(inbox.take(), false);
});

test('a request that waited for sign-in is still honored, but a stale one is dropped', () => {
  let clock = 1_000_000;
  const inbox = createStartRequestInbox(() => clock);
  inbox.push();
  clock += REQUEST_MAX_AGE_MS;
  assert.equal(inbox.take(), true);
  inbox.push();
  clock += REQUEST_MAX_AGE_MS + 1;
  assert.equal(inbox.take(), false);
});

test('an old file timestamp never starts the microphone', () => {
  let clock = 5_000_000;
  const inbox = createStartRequestInbox(() => clock);
  inbox.push(clock - REQUEST_MAX_AGE_MS - 1_000);
  assert.equal(inbox.take(), false);
  inbox.push(clock - 2_000);
  assert.equal(inbox.take(), true);
});

test('subscribers are told when a request arrives and stop after unsubscribing', () => {
  const inbox = createStartRequestInbox();
  let calls = 0;
  const stop = inbox.subscribe(() => { calls += 1; });
  inbox.push();
  assert.equal(calls, 1);
  stop();
  inbox.push();
  assert.equal(calls, 1);
});

test('requests that arrive before anyone listens coalesce into one start', () => {
  const inbox = createStartRequestInbox();
  inbox.push();
  inbox.push();
  assert.equal(inbox.take(), true);
  assert.equal(inbox.take(), false);
});
