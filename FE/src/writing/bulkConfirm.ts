import type { Notice, NoticeSummary } from '../api/v2';

export interface BulkConfirmApi {
  notice(noticeId: string): Promise<Notice>;
  confirmNotice(noticeId: string, expectedVersion: number): Promise<unknown>;
}
export type BulkResult = {
  confirmed: string[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
};

/**
 * 검토중인 알림장을 한 번에 확정한다. 아이마다 순서대로 처리하고, 관찰일지 업데이트 여부를 골라야 하는 알림장과
 * 다시 쓰는 중인 알림장은 건너뛴다(그 아이에서 따로 확정한다). 한 건이 실패해도 나머지는 계속한다.
 */
export async function confirmReviewing(api: BulkConfirmApi, notices: NoticeSummary[]): Promise<BulkResult> {
  const result: BulkResult = { confirmed: [], skipped: [], failed: [] };
  for (const summary of notices) {
    if (summary.status !== '검토중') continue;
    if (summary.busy) {
      result.skipped.push({ name: summary.child_name, reason: '다시 쓰는 중이에요.' });
      continue;
    }
    try {
      const notice = await api.notice(summary.notice_id);
      if (notice.needs_journal_update_choice) {
        result.skipped.push({ name: summary.child_name, reason: '관찰일지 업데이트 여부를 골라야 해요.' });
        continue;
      }
      await api.confirmNotice(notice.notice_id, notice.version);
      result.confirmed.push(summary.child_name);
    } catch {
      result.failed.push({ name: summary.child_name, reason: '확정하지 못했어요.' });
    }
  }
  return result;
}

export function bulkMessage(result: BulkResult): string {
  const parts = [`${result.confirmed.length}명의 알림장을 확정했어요.`];
  if (result.skipped.length) parts.push(`${result.skipped.map(item => `${item.name}(${item.reason})`).join(', ')}은(는) 건너뛰었어요. 그 아이에서 직접 확정해 주세요.`);
  if (result.failed.length) parts.push(`${result.failed.map(item => item.name).join(', ')}은(는) 확정하지 못했어요. 다시 시도해 주세요.`);
  return parts.join(' ');
}
