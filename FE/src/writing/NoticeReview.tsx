import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';
import { ApiError, errorMessage } from '../api/client';
import type { Job, Notice, NoticeRevision, NoticeSummary, V2Api } from '../api/v2';
import { colors, radius } from '../ui/theme';
import { copyRecord } from '../ui/clipboard';
import { WorkButton, WorkField, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';
import { reviewStyles } from './NoticeReviewPresentation';

const statusLabels = { 작성중: '작성 중', 검토중: '검토 중', 완료: '완료' } as const;

export function jobMessage(code: string | null) {
  if (code === 'AI_NOT_CONFIGURED' || code === 'AI_AUTH') return '글 작성에 필요한 AI 연결을 확인해 주세요.';
  if (code === 'AI_RATE_LIMITED') return 'AI 요청이 많아요. 잠시 후 다시 시도해 주세요.';
  if (code === 'SERVER_RESTART') return '서버가 다시 시작되면서 작업이 중단됐어요.';
  return '글을 만드는 중 문제가 생겼어요. 다시 시도해 주세요.';
}

export async function waitForJob(api: V2Api, job: Job) {
  const deadline = Date.now() + 180_000;
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() >= deadline) {
      throw new ApiError(0, 'WAIT_TIMEOUT', '아직 작업 중이에요. 잠시 후 다시 불러와 주세요.');
    }
    await new Promise<void>(resolve => setTimeout(resolve, 1200));
    job = await api.job(job.job_id);
  }
  if (job.status === 'failed') throw new ApiError(0, job.error_code ?? 'JOB_FAILED', jobMessage(job.error_code));
  return job;
}

export function NoticeReview({ api, summary, onDirty, onJournalUpdated, onStatusChange }: {
  api: V2Api; summary: NoticeSummary; onDirty(id: string, dirty: boolean): void; onJournalUpdated(): void;
  onStatusChange(notice: NoticeSummary): void;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [draft, setDraft] = useState<{ text: string; version: number } | null>(null);
  const [instruction, setInstruction] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<NoticeRevision | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copiedVersion, setCopiedVersion] = useState<number | null>(null);
  const [journalChoiceVersion, setJournalChoiceVersion] = useState<number | null>(null);
  const [journalMessage, setJournalMessage] = useState<string | null>(null);
  const [journalRetry, setJournalRetry] = useState<Job | null>(null);
  const action = useWorkAction();
  const noticeId = summary.notice_id;
  const version = summary.version;
  const dirty = (draft !== null && draft.text !== notice?.text) || !!instruction?.trim() || journalChoiceVersion !== null;
  useEffect(() => {
    onDirty(noticeId, dirty);
    return () => onDirty(noticeId, false);
  }, [noticeId, dirty, onDirty]);
  useEffect(() => {
    let current = true;
    setLoadError(null);
    void api.notice(noticeId).then(value => { if (current) setNotice(value); })
      .catch(error => { if (current) setLoadError(errorMessage(error)); });
    return () => { current = false; };
  }, [api, noticeId, version, attempt]);

  // 알림장 확정은 끝났고 관찰일지 업데이트 결과만 모를 때는 오류가 아니라 안내로 알리고 다시 확인하게 한다.
  async function followJournalJob(job: Job) {
    setJournalRetry(null);
    setJournalMessage('관찰일지를 업데이트하고 있어요.');
    try {
      await waitForJob(api, job);
      setJournalMessage('관찰일지를 업데이트했어요.');
    } catch {
      setJournalRetry(job);
      setJournalMessage('알림장은 확정했어요. 관찰일지가 업데이트됐는지는 아직 확인하지 못했어요. 관찰일지 탭에서도 볼 수 있어요.');
    }
    onJournalUpdated();
  }

  async function confirm(version: number, updateJournal?: boolean) {
    setJournalMessage(null);
    setJournalRetry(null);
    const result = await api.confirmNotice(noticeId, version, updateJournal);
    setNotice(result.notice);
    onStatusChange(result.notice);
    if (updateJournal && result.journal_job) await followJournalJob(result.journal_job);
  }

  async function save(current: Notice, andConfirm: boolean) {
    let stored = current;
    if (draft !== null && draft.text !== stored.text) {
      if (!draft.text.trim()) { action.setError('알림장 내용을 입력해 주세요.'); return; }
      stored = await api.saveNotice(noticeId, draft.text, draft.version, current.child_id, !current.from_recording);
      setNotice(stored);
    }
    setDraft(null);
    if (!andConfirm) return;
    if (stored.needs_journal_update_choice) setJournalChoiceVersion(stored.version);
    else await confirm(stored.version);
  }

  function chooseJournalUpdate(update: boolean) {
    if (journalChoiceVersion === null) return;
    setJournalChoiceVersion(null);
    void action.run(() => confirm(journalChoiceVersion, update));
  }

  async function revise(current: Notice) {
    const request = await api.requestRevision(noticeId, instruction?.trim() ?? '', current.version, current.child_id, !current.from_recording);
    if (request.job_id && (request.status === 'queued' || request.status === 'running')) {
      await waitForJob(api, await api.job(request.job_id));
    }
    const value = await api.revision(noticeId, request.revision_id);
    if (value.status !== 'completed' || !value.candidate_text) {
      throw new ApiError(0, 'REVISION_FAILED', '수정안을 만들지 못했어요. 다시 시도해 주세요.');
    }
    setCandidate(value);
    setInstruction(null);
  }

  const blocked = action.busy || !!notice?.busy;
  const status = notice?.status ?? summary.status;
  const confirmed = status === '완료';
  return (
    <View style={reviewStyles.entry}>
      <View style={workStyles.between}>
        <Text accessibilityRole="header" style={reviewStyles.name}>{summary.child_name}</Text>
        <View style={reviewStyles.status}>
          <View style={[reviewStyles.statusMarker, confirmed && reviewStyles.completeMarker]} />
          <Text accessibilityLiveRegion="polite" style={reviewStyles.meta}>{statusLabels[status]}</Text>
        </View>
      </View>
      {(notice?.needs_check ?? summary.needs_check) && <View style={reviewStyles.annotation}>
        <Ionicons name="alert-circle-outline" size={16} color={colors.amberInk} accessible={false} />
        <Text accessibilityLiveRegion="polite" style={reviewStyles.annotationText}>개별 관찰 내용이 비어 있어요</Text>
      </View>}
      {loadError && <WorkMessage error>{loadError}</WorkMessage>}
      {action.error && <WorkMessage error>{action.error}</WorkMessage>}
      {journalMessage && <WorkMessage>{journalMessage}</WorkMessage>}
      {journalRetry && <WorkButton label="관찰일지 업데이트 다시 확인" secondary busy={action.busy} disabled={blocked}
        onPress={() => { void action.run(async () => { await followJournalJob(await api.job(journalRetry.job_id)); }); }} />}
      {(loadError || notice?.busy || action.error) && <WorkButton label="최신 글 불러오기" secondary disabled={action.busy}
        onPress={() => { action.setError(null); setAttempt(value => value + 1); }} />}
      {!notice && !loadError && <ActivityIndicator color={colors.ink} accessibilityLabel="알림장 불러오는 중" />}
      {notice && <>
        {draft === null
          ? <Text selectable style={workStyles.body}>{notice.text}</Text>
          : <WorkField label={summary.child_name + ' 알림장 수정'} value={draft.text}
            onChangeText={text => setDraft({ ...draft, text })}
            editable={!blocked} multiline maxLength={6000} />}
        {instruction !== null && <WorkField label="AI 수정 요청" value={instruction} onChangeText={setInstruction}
          editable={!blocked} multiline maxLength={500} placeholder="예: 문장을 조금 더 짧게 써 주세요." />}
        {candidate && <>
          <Text style={reviewStyles.name}>AI 수정 결과</Text>
          <Text selectable style={workStyles.body}>{candidate.candidate_text}</Text>
          <View style={reviewStyles.secondaryActions}>
            <WorkButton label="수정안 반영" busy={action.busy} disabled={blocked}
              onPress={() => { void action.run(async () => {
                setNotice(await api.adoptRevision(noticeId, candidate.revision_id, notice.version));
                setCandidate(null);
              }); }} />
            <WorkButton label="수정안 닫기" secondary disabled={blocked} onPress={() => setCandidate(null)} />
          </View>
        </>}
        {notice.busy && <WorkMessage>이 아이의 알림장을 다시 쓰고 있어요.</WorkMessage>}
        {confirmed && copiedVersion === notice.version && <WorkMessage>알림장을 복사했어요.</WorkMessage>}
        {(confirmed || !candidate) && <View style={workStyles.between}>
          {(draft !== null || instruction !== null || !confirmed) && <View style={reviewStyles.secondaryActions}>
            {draft !== null ? <>
              <WorkButton label="수정 저장" secondary disabled={blocked}
                onPress={() => { void action.run(() => save(notice, false)); }} />
              <WorkButton label="취소" secondary disabled={blocked} onPress={() => setDraft(null)} />
            </> : instruction !== null ? <>
              <WorkButton label="수정안 만들기" busy={action.busy} disabled={blocked || !instruction.trim()}
                onPress={() => { void action.run(() => revise(notice)); }} />
              <WorkButton label="취소" secondary disabled={blocked} onPress={() => setInstruction(null)} />
            </> : !candidate && !confirmed && <>
              <WorkButton label="직접 수정" secondary disabled={blocked}
                onPress={() => setDraft({ text: notice.text, version: notice.version })} />
              <WorkButton label="AI 수정" secondary disabled={blocked} onPress={() => setInstruction('')} />
            </>}
          </View>}
          {confirmed ? <>
            <WorkButton label="확정 취소" secondary disabled={blocked}
              onPress={() => { void action.run(async () => {
                const updated = await api.unconfirmNotice(noticeId, notice.version);
                setNotice(updated);
                onStatusChange(updated);
                setJournalMessage(null);
              }); }} />
            <WorkButton label="복사" secondary busy={action.busy} disabled={blocked} onPress={() => { void action.run(async () => {
              await copyRecord(notice.text);
              setCopiedVersion(notice.version);
            }); }} />
          </>
            : instruction === null && !candidate && <WorkButton label={draft === null ? '확정' : '저장하고 확정'}
              busy={action.busy} disabled={blocked} onPress={() => { void action.run(() => save(notice, true)); }} />}
        </View>}
      </>}
      {journalChoiceVersion !== null && <Modal transparent animationType="fade" onRequestClose={() => setJournalChoiceVersion(null)}>
        <View style={styles.dialogBackdrop}>
          <View accessibilityViewIsModal style={[workStyles.panel, styles.dialog]}>
            <Text accessibilityRole="header" style={reviewStyles.name}>관찰일지도 새롭게 업데이트할까요?</Text>
            <WorkMessage>업데이트하면 이 아이의 해당 날짜 관찰일지를 다시 작성해요. 직접 수정한 관찰일지 본문도 바뀝니다.</WorkMessage>
            <View style={styles.dialogActions}>
              <WorkButton label="기존 일지 유지" secondary onPress={() => chooseJournalUpdate(false)} />
              <WorkButton label="업데이트" onPress={() => chooseJournalUpdate(true)} />
            </View>
          </View>
        </View>
      </Modal>}
    </View>
  );
}

const styles = StyleSheet.create({
  dialogBackdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: 'center', alignItems: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 412, padding: 20, borderRadius: radius.panel, gap: 12 },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
});
