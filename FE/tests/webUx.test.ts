import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Notice, NoticeSummary } from '../src/api/v2';
import { createWebTokenStore, type WebStorage } from '../src/auth/webTokenStore';
import { moveStep } from '../src/auth/onboardingSteps';
import { hasRoom, pageSize } from '../src/library/archiveLayout';
import { parseDateInput } from '../src/ui/dateInput';
import { bulkMessage, confirmReviewing, type BulkConfirmApi } from '../src/writing/bulkConfirm';
import { monthRange, weekRange } from '../src/writing/journalRange';
import { outputButtonLabel, outputStatusMessage, wordUnavailableMessage } from '../src/writing/journalOutputView';

// --- 생년월일 직접 입력 -------------------------------------------------------------------------------------------
test('a birth date can be typed in the common formats', () => {
  for (const text of ['2022-06-03', '2022.6.3', '2022/06/03', '20220603', ' 2022 06 03 ']) {
    assert.deepEqual(parseDateInput(text), { ok: true, date: '2022-06-03' }, text);
  }
});

test('impossible, malformed and out-of-range dates are rejected with a reason', () => {
  for (const text of ['', '2022-02-30', '2022-13-01', '22-06-03', '2022-06', '2022년 6월 3일', 'abc', '1800-01-01']) {
    const result = parseDateInput(text);
    assert.equal(result.ok, false, text);
  }
  const future = parseDateInput('2999-01-01', { max: '2026-11-21' });
  assert.deepEqual(future, { ok: false, error: '2026-11-21 이전 날짜를 입력해 주세요.' });
  assert.deepEqual(parseDateInput('2020-01-01', { min: '2021-01-01' }), { ok: false, error: '2021-01-01 이후 날짜를 입력해 주세요.' });
  assert.deepEqual(parseDateInput('2026-11-21', { max: '2026-11-21' }), { ok: true, date: '2026-11-21' });
});

// --- 새로고침해도 로그인 유지 -------------------------------------------------------------------------------------
function fakeStorage(): WebStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}

test('a token written before a reload is read back from the tab storage', async () => {
  const storage = fakeStorage();
  await createWebTokenStore(storage, 'patpat.session').write('token-1');
  const afterReload = createWebTokenStore(storage, 'patpat.session'); // 새로고침 = 새 저장소 객체
  assert.equal(await afterReload.read(), 'token-1');
  await afterReload.clear();
  assert.equal(await createWebTokenStore(storage, 'patpat.session').read(), null);
});

test('without a usable storage the token stays in memory only and never throws', async () => {
  const none = createWebTokenStore(null, 'k');
  await none.write('t');
  assert.equal(await none.read(), 't');
  const broken: WebStorage = {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); },
  };
  const store = createWebTokenStore(broken, 'k');
  await store.write('t2');
  assert.equal(await store.read(), 't2');
  await store.clear();
  assert.equal(await store.read(), null);
});

// --- 첫 설정 이전 단계 -------------------------------------------------------------------------------------------
test('the setup can go back one step at a time but never before the first or past the end', () => {
  assert.equal(moveStep(3, -1), 2);
  assert.equal(moveStep(2, -1), 1);
  assert.equal(moveStep(1, -1), 1);
  assert.equal(moveStep(4, 1), 5);
  assert.equal(moveStep(5, 1), 5);
});

// --- 보관함 스크롤 ----------------------------------------------------------------------------------------------
test('the archive page has the list height so its inner list can scroll', () => {
  assert.equal(hasRoom({ width: 0, height: 600 }), false);
  assert.equal(hasRoom({ width: 360, height: 0 }), false);
  assert.deepEqual(pageSize({ width: 360, height: 640 }), { width: 360, height: 640 });
});

// --- 전체 확정 -------------------------------------------------------------------------------------------------
function summary(id: string, name: string, status: NoticeSummary['status'] = '검토중', busy = false): NoticeSummary {
  return { notice_id: id, child_id: id + '-c', child_name: name, version: 1, status, needs_check: false, busy };
}
function detail(id: string, needsChoice = false): Notice {
  return { ...summary(id, id), text: '글', warnings: [], needs_journal_update_choice: needsChoice };
}

test('confirm-all confirms every reviewing notice and skips only the busy ones even when a legacy journal was linked', async () => {
  const confirmed: string[] = [];
  const api: BulkConfirmApi = {
    async notice(id) { return detail(id, id === 'n3'); },
    async confirmNotice(id) { confirmed.push(id); },
  };
  const result = await confirmReviewing(api, [
    summary('n1', '다온'), summary('n2', '이든', '완료'), summary('n3', '서윤'), summary('n4', '하린', '검토중', true), summary('n5', '지안'),
  ]);
  assert.deepEqual(confirmed, ['n1', 'n3', 'n5']);
  assert.deepEqual(result.confirmed, ['다온', '서윤', '지안']);
  assert.deepEqual(result.skipped.map(item => item.name), ['하린']);
  assert.match(bulkMessage(result), /3명의 알림장을 확정했어요\..*하린.*건너뛰었어요/);
});

test('one failed confirm does not stop the others', async () => {
  const api: BulkConfirmApi = {
    async notice(id) { return detail(id); },
    async confirmNotice(id) { if (id === 'n1') throw new Error('conflict'); },
  };
  const result = await confirmReviewing(api, [summary('n1', '다온'), summary('n2', '이든')]);
  assert.deepEqual(result.confirmed, ['이든']);
  assert.deepEqual(result.failed.map(item => item.name), ['다온']);
  assert.match(bulkMessage(result), /다온은\(는\) 확정하지 못했어요/);
});

// --- 관찰일지 기간 빠른 선택 ------------------------------------------------------------------------------------
test('this week runs Monday to Sunday and this month first to last day', () => {
  assert.deepEqual(weekRange('2026-11-21'), { from: '2026-11-16', to: '2026-11-22' }); // 토요일
  assert.deepEqual(weekRange('2026-11-22'), { from: '2026-11-16', to: '2026-11-22' }); // 일요일
  assert.deepEqual(weekRange('2026-11-16'), { from: '2026-11-16', to: '2026-11-22' }); // 월요일
  assert.deepEqual(monthRange('2026-11-21'), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(monthRange('2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
});

// --- 관찰일지 출력 상태 안내 ------------------------------------------------------------------------------------
test('the output button says re-output once an output exists and the status explains why', () => {
  assert.equal(outputButtonLabel({ output_revision: null }), '출력하기');
  assert.equal(outputButtonLabel({ output_revision: 'r1' }), '재출력하기');
  assert.equal(outputStatusMessage({ output_revision: null, output_stale: false }), null);
  assert.match(outputStatusMessage({ output_revision: 'r1', output_stale: true }) ?? '', /바뀌었어요/);
  assert.match(outputStatusMessage({ output_revision: 'r1', output_stale: false }) ?? '', /이미 출력했어요/);
});

test('a disabled Word button always has a reason', () => {
  assert.equal(wordUnavailableMessage({ can_export_word: true }), null);
  assert.match(wordUnavailableMessage({ can_export_word: false }) ?? '', /Word 양식을 먼저 올려 주세요/);
});

import { elapsedText } from '../src/writing/elapsed';

test('the waiting text counts seconds and then minutes', () => {
  assert.equal(elapsedText(0), '0초째');
  assert.equal(elapsedText(7.9), '7초째');
  assert.equal(elapsedText(65), '1분 5초째');
  assert.equal(elapsedText(-3), '0초째');
});
