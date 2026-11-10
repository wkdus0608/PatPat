import assert from 'node:assert/strict';
import test from 'node:test';
import { checkImport, importMimeType, MAX_IMPORT_BYTES } from '../src/recording/importCommon';

test('지원 형식은 MIME 또는 확장자로 판별한다', () => {
  assert.equal(importMimeType('a.m4a', ''), 'audio/mp4');
  assert.equal(importMimeType('a.MP3', 'application/octet-stream'), 'audio/mpeg');
  assert.equal(importMimeType('a.wav', 'audio/x-wav'), 'audio/x-wav');
  assert.equal(importMimeType('a.pdf', 'application/pdf'), null);
});

test('빈 파일·큰 파일·지원하지 않는 형식은 거부한다', () => {
  assert.equal(checkImport('a.m4a', 10, 'audio/mp4'), 'audio/mp4');
  assert.throws(() => checkImport('a.m4a', 0));
  assert.throws(() => checkImport('a.m4a', MAX_IMPORT_BYTES + 1));
  assert.throws(() => checkImport('a.txt', 10, 'text/plain'));
});
