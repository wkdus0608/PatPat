import { Ionicons } from '@expo/vector-icons';
import { useRef, useState, type ComponentProps, type ComponentRef } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';

import { colors, layout, radius, typeScale } from '../ui/theme';
import { workStyles } from '../ui/WorkFields';
import { RecordingPicker } from './RecordingPicker';
import type { EditableJournal, WritingState, WritingViewProps } from './types';

type IconName = ComponentProps<typeof Ionicons>['name'];

function isConfirmed(record: EditableJournal | null) {
  return record !== null && record.confirmedText !== null && record.confirmedText === record.editedText;
}

function ActionButton({
  label, onPress, icon, disabled = false, secondary = false, busy = false, testID,
}: {
  label: string; onPress(): void; icon?: IconName; disabled?: boolean;
  secondary?: boolean; busy?: boolean; testID?: string;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled, busy }} disabled={disabled} onPress={onPress} aria-busy={busy}
      style={({ pressed }) => [styles.button, secondary && styles.secondaryButton,
        disabled && styles.disabledButton, pressed && !disabled && styles.pressed]}
      testID={testID}
    >
      {busy ? <ActivityIndicator color={colors.muted} size="small" />
        : icon ? <Ionicons name={icon} size={18} color={disabled ? colors.muted : colors.ink} /> : null}
      <Text style={[styles.buttonText, disabled && styles.disabledText]}>{label}</Text>
    </Pressable>
  );
}

function Helper({ text }: { text: string }) {
  return <Text style={styles.helperText}>{text}</Text>;
}

function phaseLabel(phase: WritingState['phase'], recordType: string) {
  if (phase === 'validating') return '선택한 녹음을 확인하고 있어요.';
  if (phase === 'generating') return recordType + ' 초안을 준비하고 있어요.';
  if (phase === 'revising') return '수정 제안을 준비하고 있어요.';
  if (phase === 'confirming') return '확정한 본문을 저장하고 있어요.';
  if (phase === 'sharing') return '공유창을 열고 있어요.';
  return '';
}

function GuardDialog({ state, actions }: Pick<WritingViewProps, 'state' | 'actions'>) {
  const guard = state.guard;
  return (
    <Modal visible={guard !== null} transparent animationType="fade" onRequestClose={() => actions.resolveGuard(false)}>
      <View style={styles.modalBackdrop}>
        <View accessibilityViewIsModal style={styles.modalCard}>
          <View style={styles.guardIcon}><Ionicons name="help-circle-outline" size={30} color={colors.ink} /></View>
          <Text accessibilityRole="header" style={styles.modalTitle}>{guard?.title}</Text>
          <Text style={styles.modalMessage}>{guard?.message}</Text>
          <View style={styles.twoActions}>
            <View style={styles.actionColumn}>
              <ActionButton label={guard?.kind === 'leave' ? '계속 작성' : '취소'} secondary
                onPress={() => actions.resolveGuard(false)} testID="writing-guard-cancel" />
            </View>
            <View style={styles.actionColumn}>
              <ActionButton label={guard?.confirmLabel || '변경'}
                onPress={() => actions.resolveGuard(true)} testID="writing-guard-confirm" />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Evidence({ record, state }: { record: EditableJournal; state: WritingState }) {
  const [expanded, setExpanded] = useState(false);
  const observations = new Map(state.draft?.context.observations.map((row) => [row.observation_id, row]));
  return (
    <View style={styles.evidenceSection}>
      <Pressable accessibilityRole="button" accessibilityLabel="초안의 근거 관찰"
        accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => setExpanded(!expanded)}
        style={styles.evidenceToggle} testID="writing-evidence-toggle">
        <View style={styles.evidenceToggleLabel}>
          <Ionicons name="link-outline" size={16} color={colors.muted} />
          <Text style={styles.evidenceToggleText}>초안의 근거 관찰</Text>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.muted} />
      </Pressable>
      {expanded && <View style={styles.evidenceList}>
        {record.sentences.length === 0 ? <Text style={styles.smallNote}>연결된 개별 근거 관찰이 없어요.</Text>
          : record.sentences.map((sentence, index) => (
            <View key={index} style={styles.evidenceCard}>
              <Text style={styles.kindLabel}>{sentence.contentKind}</Text>
              <Text selectable style={styles.sentenceText}>{sentence.text}</Text>
              {sentence.observationIds.map((id) => {
                const observation = observations.get(id);
                return <View key={id} style={styles.observationRow}>
                  <View style={styles.observationDot} />
                  <View style={styles.observationContent}>
                    {!!observation?.activity && <Text style={styles.observationActivity}>{observation.activity}</Text>}
                    <Text selectable style={styles.observationText}>
                      {observation?.text || '연결된 근거 관찰을 확인할 수 없어요.'}
                    </Text>
                  </View>
                </View>;
              })}
            </View>
          ))}
        <Text style={styles.smallNote}>직접 수정한 본문도 근거 관찰과 함께 확인해 주세요.</Text>
      </View>}
    </View>
  );
}

function DraftStep({ state, capabilities, actions }: WritingViewProps) {
  const route = state.route;
  const busy = state.phase !== 'idle';
  const record = state.draft?.records.find((row) => row.recordId === state.activeRecordId) || null;
  const confirmed = isConfirmed(record);
  const candidate = record?.candidate;
  const hasText = !!record?.editedText.trim();
  const [editorHeight, setEditorHeight] = useState(250);
  const review = route === 'review';
  const editing = route === 'edit';
  const revising = route === 'revision';
  const complete = route === 'complete';
  const recordType = state.recordType ?? '기록';
  const title = editing ? '직접 수정' : revising ? 'AI에게 재수정' : complete ? '완성된 ' + recordType : recordType + ' 초안';
  const subtitle = editing ? '관찰 사실을 확인하며 본문을 수정해 주세요.'
    : revising ? '어떻게 수정해 드릴까요?'
      : complete ? '선생님이 확인하고 저장한 기록이에요.' : '초안을 읽고 다음 동작을 선택해 주세요.';
  const canConfirm = !busy && !!record && hasText && !candidate && (confirmed || capabilities.confirmation);
  const canRevise = !busy && capabilities.revision && hasText && !!record?.prompt.trim() && !candidate;
  const canShare = !busy && capabilities.sharing && confirmed && !candidate;

  return (
    <View style={styles.fill} testID={'writing-' + route + '-screen'}>
      <View style={styles.navigation}>
        <Pressable accessibilityRole="button" accessibilityLabel="이전 화면으로 돌아가기"
          accessibilityState={{ disabled: state.phase === 'confirming' || state.phase === 'sharing' }}
          disabled={state.phase === 'confirming' || state.phase === 'sharing'} onPress={actions.back}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]} testID="writing-back">
          <Ionicons name="chevron-back" size={20} color={colors.ink} /><Text style={styles.backLabel}>뒤로</Text>
        </Pressable>
        <Text style={styles.progress}>{complete ? '3 / 3' : '2 / 3'}</Text>
      </View>
      <ScrollView style={styles.fill} contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" testID={'writing-' + route + '-scroll'}>
        <View style={styles.introduction}>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        {(busy || state.notice) && <View accessibilityRole={state.notice ? 'alert' : undefined}
          accessibilityLiveRegion="polite" style={styles.notice} testID="writing-notice">
          {busy ? <ActivityIndicator size="small" color={colors.ink} />
            : <Ionicons name="information-circle-outline" size={19} color={colors.ink} />}
          <View style={styles.noticeContent}>
            {busy && <Text style={styles.noticeText}>{phaseLabel(state.phase, recordType)}</Text>}
            {!!state.notice && <Text style={styles.noticeText}>{state.notice}</Text>}
          </View>
        </View>}
        {review && !!state.draft && <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.childTabs} keyboardShouldPersistTaps="handled" testID="writing-child-tabs">
          {state.draft.records.map((item) => {
            const selected = item.recordId === state.activeRecordId;
            return <Pressable key={item.recordId} accessibilityRole="tab" accessibilityLabel={item.childId + ' ' + recordType}
              accessibilityState={{ selected, disabled: busy }} disabled={busy} aria-selected={selected}
              onPress={() => actions.selectRecord(item.recordId)}
              style={({ pressed }) => [styles.childTab, selected && styles.selectedChildTab, pressed && styles.pressed]}
              testID={'writing-child-' + item.childId}>
              <Text style={[styles.childTabText, selected && styles.selectedChildTabText]}>{item.childId}</Text>
              {isConfirmed(item) && <Ionicons name="checkmark-circle" size={15} color={colors.greenInk} />}
              {item.missingEvidence && <Ionicons name="alert-circle-outline" size={15} color={colors.rose} />}
            </Pressable>;
          })}
        </ScrollView>}
        {!record ? <Text style={styles.smallNote}>표시할 {recordType} 본문이 없어요. 작성 준비 화면에서 다시 확인해 주세요.</Text> : (
          <View style={styles.card}>
            <View style={styles.editorHeading}>
              <Text style={styles.fieldLabel}>{record.childId} {recordType}</Text>
              <View style={[styles.statusBadge, confirmed && styles.confirmedBadge]}>
                <Text style={[styles.statusBadgeText, confirmed && styles.confirmedBadgeText]}>{confirmed ? '완료' : '검토 중'}</Text>
              </View>
            </View>
            {record.missingEvidence && !complete && <View style={styles.evidenceWarning}>
              <Ionicons name="alert-circle-outline" size={17} color={colors.rose} />
              <Text style={styles.evidenceWarningText}>확인 필요 · 개별 관찰 근거가 부족해요.</Text>
            </View>}
            {revising ? (
              <TextInput accessibilityLabel={recordType + ' 수정 요청 내용'} multiline autoFocus value={record.prompt}
                onChangeText={actions.editPrompt} editable={!busy} textAlignVertical="top"
                placeholder="관찰 사실은 유지하고 문장을 더 간결하게 바꿔줘."
                placeholderTextColor={colors.muted} style={[styles.promptInput, busy && styles.inactiveInput]}
                testID="writing-prompt" />
            ) : editing ? (
              <TextInput accessibilityLabel={record.childId + ' ' + recordType + ' 본문 수정'} multiline autoFocus
                value={record.editedText} onChangeText={actions.editText} editable={!busy} textAlignVertical="top"
                scrollEnabled={false} onContentSizeChange={(event) => setEditorHeight(Math.max(250, event.nativeEvent.contentSize.height))}
                placeholder={recordType + ' 본문을 입력해 주세요.'} placeholderTextColor={colors.muted}
                style={[styles.editor, { height: editorHeight }, busy && styles.inactiveInput]} testID="writing-body" />
            ) : <>
              {review && !!state.draft?.commonText && <View style={styles.commonCard}>
                <Text style={styles.commonTitle}>공통 활동 (참고)</Text>
                <Text selectable style={styles.commonText}>{state.draft.commonText}</Text>
              </View>}
              {review && candidate && <View style={styles.candidateCard} testID="writing-candidate">
                <View style={styles.candidateHeading}>
                  <Ionicons name="sparkles-outline" size={17} color={colors.greenInk} />
                  <Text style={styles.candidateTitle}>수정 제안</Text>
                </View>
                <Text selectable style={styles.bodyText}>{candidate.text}</Text>
                <Text style={styles.candidateHint}>적용 전까지 기존 본문은 유지돼요.</Text>
              </View>}
              {review && candidate && <Text style={styles.fieldLabel}>기존 본문</Text>}
              <Text selectable style={styles.bodyText} testID={complete ? 'writing-confirmed-body' : 'writing-body'}>
                {complete ? record.confirmedText : record.editedText || '연결된 개별 관찰이 없어 본문이 비어 있어요.'}
              </Text>
              {review && <Evidence key={record.recordId} record={record} state={state} />}
            </>}
          </View>
        )}
      </ScrollView>
      <View style={styles.footer} testID="writing-step-actions">
        {review && <>
          {candidate && <View style={styles.candidateActions}>
            <View style={styles.actionColumn}><ActionButton label="제안 취소" secondary disabled={busy}
              onPress={actions.dismissCandidate} testID="writing-candidate-cancel" /></View>
            <View style={styles.actionColumn}><ActionButton label="본문에 적용" icon="checkmark" disabled={busy}
              onPress={actions.applyCandidate} testID="writing-candidate-apply" /></View>
          </View>}
          <View style={styles.twoActionsCompact}>
            <View style={styles.actionColumn}><ActionButton label="직접 수정" icon="create-outline" secondary
              disabled={busy || !record || !!candidate} onPress={actions.openEditor} testID="writing-open-editor" /></View>
            <View style={styles.actionColumn}><ActionButton label="AI에게 재수정" icon="sparkles-outline" secondary
              disabled={busy || !record || !hasText || !!candidate} onPress={actions.openRevision} testID="writing-open-revision" /></View>
          </View>
        </>}
        {(review || editing) && <>
          <ActionButton label={state.phase === 'confirming' ? '저장 중…' : '완료'} icon="checkmark"
            busy={state.phase === 'confirming'} disabled={!canConfirm} onPress={actions.confirm} testID="writing-confirm" />
          <Helper text={candidate ? '수정 제안을 적용하거나 취소해 주세요.'
            : !capabilities.confirmation && !confirmed ? '확정·저장 기능은 연결 준비 중이에요.'
              : '완료하면 현재 아동의 ' + recordType + ' 본문이 확정·저장됩니다.'} />
        </>}
        {revising && <>
          <ActionButton label={state.phase === 'revising' ? '수정 중…' : '수정하기'} icon="sparkles-outline"
            busy={state.phase === 'revising'} disabled={!canRevise} onPress={actions.revise} testID="writing-revise" />
          <Helper text={!capabilities.revision ? 'AI 수정 기능은 연결 준비 중이에요.'
            : '현재 아동의 관찰 사실을 유지하며 수정 제안을 받아요.'} />
        </>}
        {complete && <>
          <ActionButton label={state.phase === 'sharing' ? '공유창 여는 중…' : '공유하기'} icon="share-outline"
            busy={state.phase === 'sharing'} disabled={!canShare} onPress={actions.share} testID="writing-share" />
          <Helper text={capabilities.sharing ? '현재 아동의 저장된 확정문만 공유해요.' : '공유는 지원되는 휴대전화에서 사용할 수 있어요.'} />
        </>}
      </View>
    </View>
  );
}

export function WritingView(props: WritingViewProps) {
  const container = useRef<ComponentRef<typeof View>>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  return (
    <View ref={container} style={styles.fill}
      onLayout={() => container.current?.measureInWindow((_x, y) => setKeyboardOffset(y))}>
      <KeyboardAvoidingView style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
          keyboardVerticalOffset={keyboardOffset}>
        {props.state.route === 'picker' ? <RecordingPicker {...props} />
          : <DraftStep key={props.state.route + ':' + props.state.activeRecordId} {...props} />}
      </KeyboardAvoidingView>
      <GuardDialog state={props.state} actions={props.actions} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  navigation: { ...workStyles.between, paddingHorizontal: layout.gutter, minHeight: layout.touch },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: layout.touch, paddingRight: 12 },
  backLabel: workStyles.label,
  progress: { ...workStyles.hint, fontVariant: ['tabular-nums'] },
  content: { ...workStyles.content, gap: 0 },
  introduction: { marginBottom: 16 },
  title: workStyles.heading,
  subtitle: { ...workStyles.hint, marginTop: 4 },
  card: workStyles.panel,
  button: { ...workStyles.button, flexDirection: 'row', gap: 8 },
  secondaryButton: workStyles.secondary,
  disabledButton: { backgroundColor: colors.disabled },
  buttonText: { ...workStyles.buttonText, flexShrink: 1 },
  disabledText: { color: colors.muted },
  pressed: workStyles.pressed,
  footer: { paddingHorizontal: layout.gutter, paddingVertical: 12, borderTopWidth: 1,
    borderTopColor: colors.line, backgroundColor: colors.paper },
  helperText: { ...workStyles.hint, marginTop: 8, textAlign: 'center' },
  notice: { backgroundColor: colors.yellowLight, borderRadius: radius.control, padding: 12,
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 16 },
  noticeContent: { flex: 1, gap: 4 },
  noticeText: { ...typeScale.meta, color: colors.amberInk },
  smallNote: { ...workStyles.hint, marginTop: 8 },
  childTabs: { gap: 8, paddingBottom: 16 },
  childTab: { ...workStyles.choice, gap: 4 },
  selectedChildTab: workStyles.choiceSelected,
  childTabText: workStyles.hint,
  selectedChildTabText: workStyles.label,
  commonCard: { ...workStyles.panel, backgroundColor: colors.raised, marginBottom: 16, gap: 8 },
  commonTitle: workStyles.label,
  commonText: workStyles.body,
  editorHeading: { ...workStyles.between, marginBottom: 4 },
  fieldLabel: { ...workStyles.label, flexShrink: 1 },
  statusBadge: { paddingHorizontal: 4, paddingVertical: 4 },
  statusBadgeText: workStyles.hint,
  confirmedBadge: { backgroundColor: colors.green, borderRadius: radius.control, paddingHorizontal: 8 },
  confirmedBadgeText: { color: colors.greenInk },
  evidenceWarning: { backgroundColor: colors.yellowLight, borderRadius: radius.control, padding: 8,
    flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  evidenceWarningText: { ...typeScale.meta, flex: 1, color: colors.amberInk },
  bodyText: workStyles.body,
  editor: workStyles.input,
  inactiveInput: { backgroundColor: colors.raised, borderColor: colors.line, color: colors.muted },
  evidenceSection: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 8 },
  evidenceToggle: { ...workStyles.between, minHeight: layout.touch, paddingVertical: 8 },
  evidenceToggleLabel: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  evidenceToggleText: workStyles.label,
  evidenceList: { gap: 8 },
  evidenceCard: { backgroundColor: colors.raised, borderRadius: radius.control, padding: 12 },
  kindLabel: { ...workStyles.hint, marginBottom: 4 },
  sentenceText: workStyles.body,
  observationRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 8 },
  observationDot: { backgroundColor: colors.muted, width: 4, height: 4, borderRadius: 2, marginTop: 8 },
  observationContent: { flex: 1, gap: 4 },
  observationActivity: workStyles.label,
  observationText: workStyles.hint,
  promptInput: { ...workStyles.input, minHeight: 192 },
  candidateCard: { ...workStyles.panel, backgroundColor: colors.raised, marginBottom: 16 },
  candidateHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  candidateTitle: workStyles.title,
  candidateHint: workStyles.hint,
  twoActions: { ...workStyles.row, marginTop: 24 },
  twoActionsCompact: { ...workStyles.row, marginBottom: 8 },
  candidateActions: { ...workStyles.row, marginBottom: 8 },
  actionColumn: { flex: 1, minWidth: 112 },
  modalBackdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalCard: { ...workStyles.panel, width: '100%', maxWidth: 432, padding: 20 },
  guardIcon: { width: 48, height: 48, backgroundColor: colors.yellowLight, borderRadius: radius.control,
    alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  modalTitle: { ...workStyles.title, textAlign: 'center' },
  modalMessage: { ...workStyles.hint, textAlign: 'center' },
});
