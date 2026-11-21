import type { Journal, JournalOutput } from '../api/v2';

/** 한 번이라도 출력했으면 ‘재출력하기’, 아니면 ‘출력하기’. 내용이 바뀌어 다시 뽑아야 하는지는 별도 안내로 알린다. */
export function outputButtonLabel(journal: Pick<Journal, 'output_revision'>): string {
  return journal.output_revision ? '재출력하기' : '출력하기';
}

export function outputStatusMessage(journal: Pick<Journal, 'output_revision' | 'output_stale'>): string | null {
  if (!journal.output_revision) return null;
  return journal.output_stale
    ? '출력한 뒤에 내용이나 양식이 바뀌었어요. 재출력하기를 눌러 새로 받아 주세요.'
    : '이 일지는 이미 출력했어요. 내용이 바뀌지 않았다면 그대로 다시 받을 수 있어요.';
}

/** Word 버튼을 쓸 수 없을 때 이유를 알려 준다(예전 서버처럼 양식이 있어야만 출력되는 경우). */
export function wordUnavailableMessage(output: Pick<JournalOutput, 'can_export_word'>): string | null {
  return output.can_export_word ? null : '설정에서 Word 양식을 먼저 올려 주세요. 올린 양식의 항목 옆 빈칸에 내용이 채워져요.';
}

export const WORD_DEFAULT_HINT = '양식을 올리지 않으면 기본 양식으로 출력돼요. 원 양식으로 받으려면 설정에서 Word 양식을 올려 주세요.';
