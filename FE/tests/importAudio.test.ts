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

import { importSummary } from '../src/recording/importCommon';

test('여러 파일 업로드 결과를 요약한다', () => {
  assert.deepEqual(importSummary({ uploaded: 3, failed: [] }), { text: '3개 녹음 파일을 서버에 저장했어요. 보관함에서 확인할 수 있어요.', error: false });
  const partial = importSummary({ uploaded: 2, failed: [{ name: 'a.m4a', message: '파일이 너무 커요.' }, { name: 'b.mp3', message: 'x' }] });
  assert.equal(partial.error, true);
  assert.match(partial.text, /2개 저장, 2개 실패/);
  assert.match(partial.text, /"a\.m4a" 외 1개/);
});
