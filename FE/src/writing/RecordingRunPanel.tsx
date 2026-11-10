import { useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';
import type { RecordingCandidate, RecordingRun } from '../api/v2';
import { colors } from '../ui/theme';
import { WorkButton, WorkMessage, workStyles } from '../ui/WorkFields';
import { jobMessage } from './NoticeReview';

export function recordingRunWorking(run: RecordingRun | null) {
  return run?.stage === 'transcribing' || run?.stage === 'analyzing' || run?.stage === 'drafting';
}

function failureText(code: string) {
  if (code === 'STT_NOT_CONFIGURED') return '전사 서비스 연결 필요';
  if (code === 'NO_SPEECH') return '음성을 확인하지 못했어요';
  if (code === 'STT_IN_PROGRESS') return '다른 화면에서 전사 중이에요';
  if (code === 'NOT_FOUND') return '녹음을 찾을 수 없어요';
  return '전사에 실패했어요';
}

export function RecordingRunPanel({ run, busy, recordings, onRetry, onApply, onDismiss }: {
  run: RecordingRun; busy: boolean; recordings: Map<string, string>;
  onRetry(action: 'retry' | 'exclude'): void; onApply(childId: string): void; onDismiss(): void;
}) {
  const [replacing, setReplacing] = useState<RecordingCandidate | null>(null);
  if (recordingRunWorking(run)) return <View style={workStyles.panel}>
    <ActivityIndicator color={colors.ink} />
    <WorkMessage>{run.stage === 'transcribing' ? '선택한 녹음을 전사하고 있어요.'
      : run.stage === 'analyzing' ? '녹음과 입력 내용을 함께 확인하고 있어요.' : '아이별 초안을 만들고 있어요.'}</WorkMessage>
  </View>;
  if (run.stage === 'transcription_failed') return <View style={workStyles.panel}>
    <Text style={workStyles.title}>전사를 마치지 못한 녹음</Text>
    {run.failed_recordings.map((item, index) => <WorkMessage key={item.recording_id}>
      {recordings.get(item.recording_id) ?? '녹음 ' + (index + 1)} · {failureText(item.code)}
    </WorkMessage>)}
    <WorkButton label="실패한 파일 다시 시도" disabled={busy} onPress={() => onRetry('retry')} />
    <WorkButton label="실패한 파일 빼고 계속" secondary disabled={busy} onPress={() => onRetry('exclude')} />
    <WorkButton label="작성으로 돌아가기" secondary disabled={busy} onPress={onDismiss} />
  </View>;
  if (run.stage === 'failed') return <View style={workStyles.panel}>
    <WorkMessage error>{run.error_code === 'NOTHING_TO_WRITE'
      ? '알림장에 쓸 관찰 내용을 확인하지 못했어요.' : jobMessage(run.error_code)}</WorkMessage>
    <WorkButton label="작성으로 돌아가기" secondary disabled={busy} onPress={onDismiss} />
  </View>;
  if (run.stage !== 'ready') return null;
  return <>
    <Text style={workStyles.title}>녹음으로 다시 만든 초안</Text>
    {run.missing_children.length > 0 && <WorkMessage>관찰 내용을 찾지 못한 아이 · {run.missing_children.join(', ')}</WorkMessage>}
    {run.candidates.map(candidate => <View key={candidate.child_id} style={workStyles.panel}>
      <Text style={workStyles.title}>{candidate.child_name}</Text>
      <Text selectable style={workStyles.body}>{candidate.text}</Text>
      <View style={styles.actions}>
        <WorkButton label="반영" disabled={busy} onPress={() => {
          if (candidate.replaces_notice) setReplacing(candidate);
          else onApply(candidate.child_id);
        }} />
      </View>
    </View>)}
    <WorkButton label="남은 초안 닫기" secondary disabled={busy} onPress={onDismiss} />
    {replacing && <Modal transparent animationType="fade" onRequestClose={() => setReplacing(null)}>
      <View style={styles.backdrop}>
        <View accessibilityViewIsModal style={[workStyles.panel, styles.dialog]}>
          <Text accessibilityRole="header" style={workStyles.title}>{replacing.child_name} 알림장을 교체할까요?</Text>
          <WorkMessage>반영하면 이전 알림장이 작성 화면에서 삭제되고 새 초안으로 바뀝니다.</WorkMessage>
          <View style={styles.actions}>
            <WorkButton label="취소" secondary onPress={() => setReplacing(null)} />
            <WorkButton label="교체하고 반영" onPress={() => {
              const childId = replacing.child_id;
              setReplacing(null);
              onApply(childId);
            }} />
          </View>
        </View>
      </View>
    </Modal>}
  </>;
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
  backdrop: { flex: 1, backgroundColor: '#49372C66', justifyContent: 'center', alignItems: 'center', padding: 22 },
  dialog: { width: '100%', maxWidth: 410, padding: 20 },
});
