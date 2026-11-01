import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadJournalDetail, loadJournalList } from '../src/library/journals';
import type { JournalListItem, JournalSource, LoadState } from '../src/library/types';

function item(recordId = 'R01', childId = 'C01'): JournalListItem {
  return { recordId, childId, recordType: '관찰일지', status: '완료' };
}

function source(list: unknown, detail: unknown = undefined): JournalSource {
  return { async list() { return list; }, async get() { return detail; } };
}

function readyData<T>(state: LoadState<T>): T {
  assert.equal(state.status, 'ready');
  if (state.status !== 'ready') throw new Error('Expected a ready load state');
  return state.data;
}

function errorMessage<T>(state: LoadState<T>): string {
  assert.equal(state.status, 'error');
  if (state.status !== 'error') throw new Error('Expected an error load state');
  assert.ok(state.message.length > 0);
  return state.message;
}

test('unconnected list and detail are unavailable rather than empty or errors', async () => {
  const list = await loadJournalList();
  const detail = await loadJournalDetail(undefined, item());
  assert.equal(list.status, 'unavailable');
  assert.equal(detail.status, 'unavailable');
  if (list.status === 'unavailable') assert.match(list.message, /연결 준비 중/);
});

test('only a successful empty source result produces a ready empty list', async () => {
  assert.deepEqual(readyData(await loadJournalList(source([]))), []);
  errorMessage(await loadJournalList(source(null)));
  errorMessage(await loadJournalList(source({ records: [] })));
  errorMessage(await loadJournalList(source(undefined)));
});

test('source failures stay errors without exposing private exception text', async () => {
  const failing: JournalSource = {
    async list() { throw new Error('private source failure'); },
    async get() { throw new Error('private source failure'); },
  };
  assert.doesNotMatch(errorMessage(await loadJournalList(failing)), /private source/);
  assert.doesNotMatch(errorMessage(await loadJournalDetail(failing, item())), /private source/);
});

test('the list filters unfinished records without reordering or mutating source data', async () => {
  const latest = { ...item('R02', 'C02'), title: 'C02 관찰일지', dateLabel: '2026-11-01' };
  const oldest = { ...item('R01', 'C01'), dateLabel: '2026-10-01' };
  const input = Object.freeze([
    Object.freeze(oldest),
    Object.freeze({ ...item('R03'), status: '작성중' }),
    Object.freeze(latest),
    Object.freeze({ ...item('R04'), status: '검토중' }),
  ]);
  const output = readyData(await loadJournalList(source(input)));
  assert.deepEqual(output, [oldest, latest]);
  assert.equal(input[1].status, '작성중');
  assert.notEqual(output[0], oldest);
});

test('a source containing only valid unfinished records has no completed list entries', async () => {
  assert.deepEqual(readyData(await loadJournalList(source([
    { ...item('R01'), status: '작성중' }, { ...item('R02'), status: '검토중' },
  ]))), []);
});

test('unknown or absent statuses are errors instead of silently filtered records', async () => {
  for (const status of ['done', '확정', '', null, undefined, 1]) {
    assert.match(errorMessage(await loadJournalList(source([{ ...item(), status }]))), /상태/);
  }
});

test('blank and non-string record or child IDs are rejected even for unfinished records', async () => {
  for (const field of ['recordId', 'childId']) {
    for (const value of ['', ' \t\n', undefined, null, 1]) {
      errorMessage(await loadJournalList(source([{ ...item(), [field]: value }])));
      errorMessage(await loadJournalList(source([{ ...item(), status: '작성중', [field]: value }])));
    }
  }
});

test('duplicate record IDs are rejected across children and unfinished records', async () => {
  for (const status of ['완료', '작성중', '검토중']) {
    assert.match(errorMessage(await loadJournalList(source([
      item('R01', 'C01'), { ...item('R01', 'C02'), status },
    ]))), /여러 번/);
  }
});

test('non-journal and non-object list entries are errors', async () => {
  for (const value of [null, [], '관찰일지', { ...item(), recordType: '알림장' }]) {
    errorMessage(await loadJournalList(source([value])));
  }
});

test('optional display labels accept only strings or absence, without inventing dates', async () => {
  const missing = readyData(await loadJournalList(source([item()])))[0];
  assert.equal(missing.title, undefined);
  assert.equal(missing.childLabel, undefined);
  assert.equal(missing.dateLabel, undefined);
  assert.equal(missing.periodLabel, undefined);
  for (const field of ['title', 'childLabel', 'dateLabel', 'periodLabel']) {
    for (const value of [null, 123, {}, ['가상 표시값']]) {
      errorMessage(await loadJournalList(source([{ ...item(), [field]: value }])));
    }
  }
  const supplied = { ...item(), title: 'C01 관찰일지', childLabel: 'C01', dateLabel: '', periodLabel: '2026년 10월' };
  assert.deepEqual(readyData(await loadJournalList(source([supplied]))), [supplied]);
});

test('detail fetches exactly the selected ID and preserves final teacher text byte for byte', async () => {
  const selected = item('R02', 'C02');
  const finalText = '  C02는 네모 블록 세 개를 쌓았다.\r\n\n  다음 놀이에도 블록을 제공할 예정이다.\n\t';
  const calls: string[] = [];
  const supplied: JournalSource = {
    async list() { return []; },
    async get(recordId) {
      calls.push(recordId);
      return {
        ...selected, finalText,
        common_text: '이 초안은 확정문 대신 사용하지 않는다.',
        individual_sentences: [{ text: '확정 전 가상 초안' }],
      };
    },
  };
  const detail = readyData(await loadJournalDetail(supplied, selected));
  assert.deepEqual(calls, ['R02']);
  assert.equal(detail.finalText, finalText);
  assert.equal(detail.dateLabel, undefined);
  assert.equal(detail.periodLabel, undefined);
});

test('a selected record can never display another record or another child', async () => {
  for (const other of [item('R02', 'C01'), item('R01', 'C02')]) {
    assert.match(errorMessage(await loadJournalDetail(
      source([], { ...other, finalText: 'C02의 가상 관찰이다.' }), item('R01', 'C01'),
    )), /일치하지/);
  }
});

test('missing or blank final text is an error even when draft text exists', async () => {
  for (const finalText of [undefined, null, '', ' \r\n\t', 123]) {
    assert.match(errorMessage(await loadJournalDetail(source([], {
      ...item(), finalText,
      common_text: '반 전체가 블록 놀이를 했다.',
      individual_sentences: [{ text: 'C01이 빨간 블록을 쌓았다.' }],
      edited_text: '명시적인 FE 최종 본문 공급 필드 없이 API 형식을 추측하지 않는다.',
    }), item())), /최종 본문/);
  }
});

test('unfinished or invalid detail states never become completed records', async () => {
  for (const status of ['작성중', '검토중', 'done', undefined]) {
    errorMessage(await loadJournalDetail(source([], {
      ...item(), status, finalText: 'C01이 블록 두 개를 쌓았다.',
    }), item()));
  }
});

test('malformed detail fields are rejected rather than replacing them with selected labels', async () => {
  for (const value of [
    null, [], { ...item(), finalText: 'C01의 가상 관찰', childId: '' },
    { ...item(), finalText: 'C01의 가상 관찰', recordType: '알림장' },
    { ...item(), finalText: 'C01의 가상 관찰', periodLabel: 202610 },
  ]) {
    errorMessage(await loadJournalDetail(source([], value), item()));
  }
});

test('invalid runtime selection is rejected before reading any other record', async () => {
  let reads = 0;
  const supplied: JournalSource = {
    async list() { return []; },
    async get() { reads += 1; return { ...item(), finalText: 'C01의 가상 관찰' }; },
  };
  errorMessage(await loadJournalDetail(supplied, { ...item(), childId: '' }));
  assert.equal(reads, 0);
});
