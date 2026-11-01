import type { JournalDetail, JournalListItem, JournalSource, LoadState } from './types';

type JournalStatus = '작성중' | '검토중' | '완료';
type ValidatedJournal = Omit<JournalListItem, 'status'> & { status: JournalStatus };

const displayFields = ['title', 'childLabel', 'dateLabel', 'periodLabel'] as const;
const unavailableMessage = '관찰일지 연결 준비 중이에요. 작성·저장 기능과 연결되면 확인할 수 있어요.';

class JournalInputError extends Error {}

function objectInput(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JournalInputError('관찰일지 항목 형식을 확인해 주세요.');
  }
  return value as Record<string, unknown>;
}

function nonblankString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JournalInputError(message);
  }
  return value;
}

/** Validate FE display inputs without defining or guessing a server response. */
function readJournal(value: unknown): ValidatedJournal {
  const input = objectInput(value);
  const recordId = nonblankString(input.recordId, '관찰일지 기록 ID를 확인해 주세요.');
  const childId = nonblankString(input.childId, '관찰일지 아동 ID를 확인해 주세요.');
  if (input.recordType !== '관찰일지') {
    throw new JournalInputError('관찰일지 기록 종류를 확인해 주세요.');
  }
  const status = input.status;
  if (status !== '작성중' && status !== '검토중' && status !== '완료') {
    throw new JournalInputError('관찰일지 상태를 확인해 주세요.');
  }
  const labels: Pick<JournalListItem, typeof displayFields[number]> = {};
  for (const field of displayFields) {
    const label = input[field];
    if (label === undefined) continue;
    if (typeof label !== 'string') {
      throw new JournalInputError(`관찰일지 ${field} 표시 정보를 확인해 주세요.`);
    }
    labels[field] = label;
  }
  return { recordId, childId, recordType: '관찰일지', status, ...labels };
}

function requireCompleted(journal: ValidatedJournal): JournalListItem {
  if (journal.status !== '완료') {
    throw new JournalInputError('완료된 관찰일지인지 확인해 주세요.');
  }
  return { ...journal, status: '완료' };
}

function errorState<T>(error: unknown): LoadState<T> {
  return {
    status: 'error',
    message: error instanceof JournalInputError ? error.message
      : '관찰일지를 불러오지 못했어요. 다시 시도해 주세요.',
  };
}

export async function loadJournalList(
  source?: JournalSource,
): Promise<LoadState<readonly JournalListItem[]>> {
  if (!source) return { status: 'unavailable', message: unavailableMessage };
  try {
    const input = await source.list();
    if (!Array.isArray(input)) {
      throw new JournalInputError('관찰일지 목록 형식을 확인해 주세요.');
    }
    const seen = new Set<string>();
    const completed: JournalListItem[] = [];
    for (const value of input) {
      // Validate unfinished inputs too: filtering must not hide malformed data.
      const journal = readJournal(value);
      if (seen.has(journal.recordId)) {
        throw new JournalInputError('같은 관찰일지 기록 ID가 여러 번 포함되어 있어요.');
      }
      seen.add(journal.recordId);
      if (journal.status === '완료') completed.push(requireCompleted(journal));
    }
    return { status: 'ready', data: completed };
  } catch (error) {
    return errorState(error);
  }
}

export async function loadJournalDetail(
  source: JournalSource | undefined,
  selected: JournalListItem,
): Promise<LoadState<JournalDetail>> {
  if (!source) return { status: 'unavailable', message: unavailableMessage };
  try {
    const selection = requireCompleted(readJournal(selected));
    const input = objectInput(await source.get(selection.recordId));
    const journal = requireCompleted(readJournal(input));
    if (journal.recordId !== selection.recordId || journal.childId !== selection.childId) {
      throw new JournalInputError('선택한 관찰일지와 아동 정보가 일치하지 않아요. 다시 불러와 주세요.');
    }
    // Final teacher edits are authoritative. Never reconstruct them from a draft.
    const finalText = nonblankString(input.finalText, '관찰일지의 최종 본문을 불러올 수 없어요.');
    return { status: 'ready', data: { ...journal, finalText } };
  } catch (error) {
    return errorState(error);
  }
}
