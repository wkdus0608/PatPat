import { Ionicons } from '@expo/vector-icons';
import { useRef, useState, type ComponentProps, type ComponentRef, type ReactNode } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';

import { colors } from '../ui/theme';
import { RecordingPicker } from './RecordingPicker';
import type { EditableJournal, WritingState, WritingViewProps } from './types';

type IconName = ComponentProps<typeof Ionicons>['name'];

function dateLabel(value: string) {
  const [year, month, day] = value.split('-');
  return year && month && day ? year + '년 ' + Number(month) + '월 ' + Number(day) + '일' : value;
}

function isConfirmed(record: EditableJournal | null) {
  return record !== null && record.confirmedText !== null && record.confirmedText === record.editedText;
}

function ActionButton({
  label, onPress, icon, disabled = false, secondary = false, busy = false, testID,
}: {
  label: string;
  onPress(): void;
  icon?: IconName;
  disabled?: boolean;
  secondary?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled, busy }} disabled={disabled} onPress={onPress}
      aria-busy={busy}
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

function StepCard({ number, title, subtitle, children }: {
  number: number;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.stepHeading}>
        <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{number}</Text></View>
        <View style={styles.stepText}>
          <Text accessibilityRole="header" style={styles.stepTitle}>{title}</Text>
          <Text style={styles.stepSubtitle}>{subtitle}</Text>
        </View>
      </View>
      {children}
    </View>
  );
}

function Helper({ text, connected = true }: { text: string; connected?: boolean }) {
  return (
    <View style={styles.helper}>
      <Ionicons name={connected ? 'information-circle-outline' : 'time-outline'} size={14} color={colors.muted} />
      <Text style={styles.helperText}>{text}</Text>
    </View>
  );
}

function phaseLabel(phase: WritingState['phase']) {
  if (phase === 'validating') return '선택한 녹음을 확인하고 있어요.';
  if (phase === 'generating') return '관찰일지 초안을 준비하고 있어요.';
  if (phase === 'revising') return '수정 제안을 준비하고 있어요.';
  if (phase === 'confirming') return '확정한 본문을 저장하고 있어요.';
  if (phase === 'sharing') return '공유창을 열고 있어요.';
  return '';
}

function GuardDialog({ state, actions }: Pick<WritingViewProps, 'state' | 'actions'>) {
  const guard = state.guard;
  return (
    <Modal visible={guard !== null} transparent animationType="fade"
      onRequestClose={() => actions.resolveGuard(false)}
    >
      <View style={styles.modalBackdrop}>
        <View accessibilityViewIsModal style={styles.modalCard}>
          <View style={styles.guardIcon}><Ionicons name="help-circle-outline" size={30} color={colors.ink} /></View>
          <Text accessibilityRole="header" style={styles.modalTitle}>{guard?.title}</Text>
          <Text style={styles.modalMessage}>{guard?.message}</Text>
          <View style={styles.guardActions}>
            <View style={styles.actionColumn}>
              <ActionButton label={guard?.kind === 'leave' ? '계속 작성' : '취소'}
                secondary onPress={() => actions.resolveGuard(false)} testID="writing-guard-cancel" />
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

function Editor({ state, capabilities, actions }: WritingViewProps) {
  const busy = state.phase !== 'idle';
  const draft = state.draft;
  const record = draft?.records.find((item) => item.recordId === state.activeRecordId) || null;
  const confirmed = isConfirmed(record);
  const hasCandidate = record !== null && record.candidate !== null;
  const observations = new Map(draft?.context.observations.map((observation) => [observation.observation_id, observation]));
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  const hasText = record !== null && record.editedText.trim().length > 0;
  const canGenerate = !busy && capabilities.generation && state.selected.length > 0;
  const canRevise = !busy && capabilities.revision && record !== null && hasText && record.prompt.trim().length > 0;
  const canConfirm = !busy && capabilities.confirmation && hasText && !confirmed && !hasCandidate;
  const canShare = !busy && capabilities.sharing && confirmed && !hasCandidate;

  const generationHelp = !capabilities.generation
    ? '초안 작성 기능은 연결 준비 중이에요.'
    : state.selected.length === 0 ? '사용할 녹음을 먼저 가져와 주세요.'
      : draft ? '다시 작성하면 현재 초안과 편집 내용을 바꿀지 확인해요.' : '선택한 녹음의 관찰로 초안을 준비해요.';
  const revisionHelp = !capabilities.revision
    ? '수정 요청 기능은 연결 준비 중이에요.'
    : !record ? '초안을 먼저 작성해 주세요.'
      : !hasText ? '수정할 본문을 먼저 입력해 주세요.'
        : !record.prompt.trim() ? '어떻게 수정할지 요청 내용을 적어 주세요.' : '현재 선택한 아동의 본문에 대한 수정 제안을 받아요.';
  const confirmationHelp = hasCandidate
    ? '수정 제안을 적용하거나 취소한 뒤 확정·공유할 수 있어요.'
    : !capabilities.confirmation
    ? '확정·저장 기능은 연결 준비 중이에요.'
    : confirmed ? '현재 본문이 확정·저장되었어요.'
      : !record ? '초안을 먼저 작성해 주세요.'
        : !hasText ? '본문을 입력한 뒤 확정할 수 있어요.'
          : record.confirmedText !== null ? '본문을 수정했어요. 다시 확정해야 공유할 수 있어요.' : '현재 아동의 본문을 확인한 뒤 확정해 주세요.';
  const sharingHelp = hasCandidate
    ? '수정 제안을 적용하거나 취소한 뒤 확정·공유할 수 있어요.'
    : !capabilities.sharing
    ? '이 환경에서는 공유 기능이 준비 중이에요.'
    : confirmed ? '현재 아동의 저장된 본문만 공유창으로 열어요.' : '현재 본문을 확정·저장한 뒤 공유할 수 있어요.';

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      testID="writing-editor-scroll"
    >
      <View style={styles.introduction}>
        <Text accessibilityRole="header" style={styles.title}>관찰일지 작성</Text>
        <Text style={styles.subtitle}>남겨 둔 관찰을 모아, 차근차근 기록해요.</Text>
      </View>
      {(busy || state.notice) && (
        <View accessibilityRole={state.notice ? 'alert' : undefined} accessibilityLiveRegion="polite"
          style={styles.notice} testID="writing-notice"
        >
          {busy ? <ActivityIndicator size="small" color={colors.ink} />
            : <Ionicons name="information-circle-outline" size={19} color={colors.ink} />}
          <View style={styles.noticeContent}>
            {busy && <Text style={styles.noticeText}>{phaseLabel(state.phase)}</Text>}
            {!!state.notice && <Text style={styles.noticeText}>{state.notice}</Text>}
          </View>
        </View>
      )}

      <StepCard number={1} title="사용할 녹음" subtitle="기록에 담을 관찰을 골라 주세요.">
        {state.selected.length === 0 ? (
          <View style={styles.emptySelection}>
            <View style={styles.emptySelectionIcon}><Ionicons name="mic-outline" size={26} color={colors.ink} /></View>
            <Text style={styles.emptySelectionText}>아직 가져온 녹음이 없어요.</Text>
          </View>
        ) : (
          <View style={styles.selectionList}>
            <View style={styles.selectionCountRow}>
              <Text style={styles.selectionCountLabel}>가져온 녹음</Text>
              <Text style={styles.selectionCount} testID="writing-selected-count">{state.selected.length}개</Text>
            </View>
            {state.selected.map((item) => (
              <View key={item.uri} style={styles.selectedRow}>
                <View style={styles.selectedText}>
                  <Text style={styles.selectedDate}>{dateLabel(item.dateKey)} · {item.startTime}</Text>
                  <Text style={styles.selectedFileName}>{item.fileName}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel={item.fileName + ' 선택 해제'}
                  accessibilityState={{ disabled: busy }} disabled={busy}
                  onPress={() => actions.removeRecording(item.uri)}
                  style={({ pressed }) => [styles.removeButton, busy && styles.disabledOpacity, pressed && styles.pressed]}
                  testID={'writing-remove-' + item.fileName}
                ><Ionicons name="close-circle-outline" size={21} color={colors.muted} /></Pressable>
              </View>
            ))}
            <Text style={styles.smallNote}>선택을 해제해도 녹음 파일은 그대로 남아요.</Text>
          </View>
        )}
        <ActionButton label="녹음 보관함에서 가져오기" icon="folder-open-outline"
          secondary disabled={busy} onPress={actions.openPicker} testID="writing-open-picker" />
      </StepCard>

      <StepCard number={2} title="관찰일지 초안" subtitle="아동별로 살펴보고 본문을 직접 수정해요.">
        <ActionButton label={state.phase === 'validating' || state.phase === 'generating'
          ? '초안 준비 중…' : draft ? '초안 다시 작성' : '초안 작성'}
          icon="sparkles-outline" busy={state.phase === 'validating' || state.phase === 'generating'}
          disabled={!canGenerate} onPress={actions.generate} testID="writing-generate" />
        <Helper text={generationHelp} connected={capabilities.generation} />

        {draft && draft.records.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.childTabs} keyboardShouldPersistTaps="handled"
            testID="writing-child-tabs"
          >
            {draft.records.map((item) => {
              const selected = item.recordId === state.activeRecordId;
              return (
                <Pressable key={item.recordId} accessibilityRole="tab" accessibilityLabel={item.childId + ' 관찰일지'}
                  accessibilityState={{ selected, disabled: busy }} disabled={busy}
                  aria-selected={selected}
                  onPress={() => actions.selectRecord(item.recordId)}
                  style={({ pressed }) => [styles.childTab, selected && styles.selectedChildTab, busy && styles.disabledOpacity, pressed && styles.pressed]}
                  testID={'writing-child-' + item.childId}
                >
                  <Text style={[styles.childTabText, selected && styles.selectedChildTabText]}>{item.childId}</Text>
                  {isConfirmed(item) && <Ionicons name="checkmark-circle" size={15} color={colors.greenInk} />}
                  {item.missingEvidence && <Ionicons name="alert-circle-outline" size={15} color={colors.rose} />}
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {!!draft?.commonText && (
          <View style={styles.commonCard}>
            <Text style={styles.commonTitle}>공통 활동 (참고)</Text>
            <Text selectable style={styles.commonText}>{draft.commonText}</Text>
          </View>
        )}

        <View style={styles.editorHeading}>
          <Text style={styles.fieldLabel}>{record ? record.childId + ' 관찰일지 본문' : '관찰일지 본문'}</Text>
          {record && <View style={[styles.statusBadge, confirmed && styles.confirmedBadge]}>
            <Text style={[styles.statusBadgeText, confirmed && styles.confirmedBadgeText]}>{confirmed ? '완료' : '검토 중'}</Text>
          </View>}
        </View>
        {record?.missingEvidence && (
          <View style={styles.evidenceWarning}>
            <Ionicons name="alert-circle-outline" size={17} color={colors.rose} />
            <Text style={styles.evidenceWarningText}>확인 필요 · 개별 관찰 근거가 부족해요. 내용을 확인해 주세요.</Text>
          </View>
        )}
        <TextInput
          accessibilityLabel={record ? record.childId + ' 관찰일지 본문 수정' : '관찰일지 본문'}
          multiline value={record?.editedText || ''} onChangeText={actions.editText}
          editable={record !== null && !busy} textAlignVertical="top"
          placeholder={record ? '관찰일지 본문을 입력해 주세요.' : '초안이 준비되면 본문을 직접 수정할 수 있어요.'}
          placeholderTextColor={colors.muted}
          style={[styles.editor, (record === null || busy) && styles.inactiveInput]}
          testID="writing-body"
        />
        {!record && <Text style={styles.smallNote}>초안을 작성하면 아동별 기록이 여기에 표시돼요.</Text>}

        {record && (
          <View style={styles.evidenceSection}>
            <Pressable accessibilityRole="button" accessibilityLabel="초안의 근거 관찰"
              accessibilityState={{ expanded: evidenceExpanded }}
              aria-expanded={evidenceExpanded}
              onPress={() => setEvidenceExpanded((expanded) => !expanded)}
              style={styles.evidenceToggle} testID="writing-evidence-toggle"
            >
              <View style={styles.evidenceToggleLabel}>
                <Ionicons name="link-outline" size={16} color={colors.muted} />
                <Text style={styles.evidenceToggleText}>초안의 근거 관찰</Text>
              </View>
              <Ionicons name={evidenceExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.muted} />
            </Pressable>
            {evidenceExpanded && (
              <View style={styles.evidenceList}>
                {record.sentences.length === 0
                  ? <Text style={styles.smallNote}>연결된 개별 근거 관찰이 없어요.</Text>
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
              </View>
            )}
          </View>
        )}
      </StepCard>

      <StepCard number={3} title="수정 요청" subtitle="현재 선택한 아동의 글을 어떻게 바꿀까요?">
        <TextInput accessibilityLabel="관찰일지 수정 요청 내용"
          multiline value={record?.prompt || ''} onChangeText={actions.editPrompt}
          editable={record !== null && !busy} textAlignVertical="top"
          placeholder="관찰 사실은 유지하고 문장을 더 간결하게 바꿔줘."
          placeholderTextColor={colors.muted}
          style={[styles.promptInput, (!record || busy) && styles.inactiveInput]}
          testID="writing-prompt"
        />
        <ActionButton label={state.phase === 'revising' ? '제안 준비 중…' : '수정 요청'}
          icon="chatbubble-ellipses-outline" busy={state.phase === 'revising'}
          disabled={!canRevise} onPress={actions.revise} testID="writing-revise" />
        <Helper text={revisionHelp} connected={capabilities.revision} />

        {record?.candidate && (
          <View style={styles.candidateCard} testID="writing-candidate">
            <View style={styles.candidateHeading}>
              <Ionicons name="sparkles-outline" size={17} color={colors.greenInk} />
              <Text style={styles.candidateTitle}>수정 제안</Text>
            </View>
            <Text selectable style={styles.candidateText}>{record.candidate.text}</Text>
            <Text style={styles.candidateHint}>내용을 확인하고 적용해 주세요. 적용 전까지 기존 본문은 유지돼요.</Text>
            <View style={styles.twoActions}>
              <View style={styles.actionColumn}>
                <ActionButton label="제안 취소" secondary disabled={busy}
                  onPress={actions.dismissCandidate} testID="writing-candidate-cancel" />
              </View>
              <View style={styles.actionColumn}>
                <ActionButton label="본문에 적용" icon="checkmark" disabled={busy}
                  onPress={actions.applyCandidate} testID="writing-candidate-apply" />
              </View>
            </View>
          </View>
        )}
      </StepCard>

      <StepCard number={4} title="확정하고 공유하기" subtitle="선생님이 확인한 본문으로 마무리해요.">
        <ActionButton label={state.phase === 'confirming' ? '저장 중…'
          : confirmed ? '확정 완료' : record !== null && record.confirmedText !== null ? '다시 확정하기' : '확정하기'}
          icon={confirmed ? 'checkmark-circle-outline' : 'checkmark-outline'}
          busy={state.phase === 'confirming'} disabled={!canConfirm}
          onPress={actions.confirm} testID="writing-confirm" />
        <Helper text={confirmationHelp} connected={capabilities.confirmation} />
        <View style={styles.shareAction}>
          <ActionButton label={state.phase === 'sharing' ? '공유창 여는 중…' : '공유하기'}
            icon="share-outline" secondary busy={state.phase === 'sharing'} disabled={!canShare}
            onPress={actions.share} testID="writing-share" />
          <Helper text={sharingHelp} connected={capabilities.sharing} />
        </View>
      </StepCard>
      <Text style={styles.closingNote}>선생님의 관찰과 확인으로 완성되는 기록이에요.</Text>
    </ScrollView>
  );
}

export function WritingView(props: WritingViewProps) {
  const container = useRef<ComponentRef<typeof View>>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  return (
    <View ref={container} style={styles.fill}
      onLayout={() => container.current?.measureInWindow((_x, y) => setKeyboardOffset(y))}
    >
      {props.state.route === 'picker' ? <RecordingPicker state={props.state} actions={props.actions} /> : (
        <KeyboardAvoidingView style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
          keyboardVerticalOffset={keyboardOffset}
        ><Editor {...props} /></KeyboardAvoidingView>
      )}
      <GuardDialog state={props.state} actions={props.actions} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 7, paddingBottom: 28 },
  introduction: { marginBottom: 24 },
  title: { color: colors.ink, fontSize: 27, fontWeight: '800', letterSpacing: -0.9, lineHeight: 38 },
  subtitle: { color: colors.muted, fontSize: 13, lineHeight: 22, marginTop: 7 },
  card: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 25, paddingHorizontal: 19, paddingVertical: 22, marginBottom: 17 },
  stepHeading: { flexDirection: 'row', gap: 10, marginBottom: 20, alignItems: 'flex-start' },
  stepNumber: { width: 29, height: 29, borderRadius: 11, backgroundColor: colors.yellowLight, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumberText: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  stepText: { flex: 1, gap: 5 },
  stepTitle: { color: colors.ink, fontSize: 17, fontWeight: '700', lineHeight: 25, letterSpacing: -0.4 },
  stepSubtitle: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  button: { borderRadius: 15, backgroundColor: colors.yellow, minHeight: 49, paddingHorizontal: 13, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  secondaryButton: { backgroundColor: '#F5F3ED' },
  disabledButton: { backgroundColor: colors.disabled },
  buttonText: { color: colors.ink, fontSize: 13, fontWeight: '700', lineHeight: 21, flexShrink: 1, textAlign: 'center' },
  disabledText: { color: colors.muted },
  disabledOpacity: { opacity: 0.45 },
  pressed: { opacity: 0.65 },
  helper: { flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginTop: 9 },
  helperText: { flex: 1, color: colors.muted, fontSize: 11, lineHeight: 18 },
  notice: { backgroundColor: colors.yellowLight, borderRadius: 16, padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 17 },
  noticeContent: { flex: 1, gap: 5 },
  noticeText: { color: colors.ink, fontSize: 12, lineHeight: 21 },
  emptySelection: { borderRadius: 18, borderWidth: 1, borderStyle: 'dashed', borderColor: '#DDD3C5', paddingVertical: 23, paddingHorizontal: 12, alignItems: 'center', marginBottom: 15, gap: 11 },
  emptySelectionIcon: { backgroundColor: colors.yellowLight, width: 47, height: 47, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  emptySelectionText: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  selectionList: { marginBottom: 15 },
  selectionCountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 5 },
  selectionCountLabel: { color: colors.muted, fontSize: 11 },
  selectionCount: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  selectedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: 13 },
  selectedText: { flex: 1, gap: 4 },
  selectedDate: { color: colors.ink, fontSize: 12, fontWeight: '600', lineHeight: 20 },
  selectedFileName: { color: colors.muted, fontSize: 10, lineHeight: 17 },
  removeButton: { width: 39, height: 44, alignItems: 'center', justifyContent: 'center' },
  smallNote: { color: colors.muted, fontSize: 11, lineHeight: 19, marginTop: 9 },
  childTabs: { gap: 8, paddingTop: 20, paddingBottom: 5 },
  childTab: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 15, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, paddingVertical: 11, minHeight: 43 },
  selectedChildTab: { backgroundColor: colors.yellowLight, borderColor: '#E7CF8D' },
  childTabText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  selectedChildTabText: { color: colors.ink, fontWeight: '800' },
  commonCard: { backgroundColor: colors.blue, borderRadius: 16, padding: 14, marginTop: 18 },
  commonTitle: { color: colors.blueInk, fontSize: 11, fontWeight: '700', marginBottom: 7 },
  commonText: { color: colors.ink, fontSize: 12, lineHeight: 22 },
  editorHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 22, marginBottom: 10 },
  fieldLabel: { color: colors.ink, fontSize: 12, lineHeight: 20, fontWeight: '700', flexShrink: 1 },
  statusBadge: { backgroundColor: colors.yellowLight, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  statusBadgeText: { color: colors.ink, fontSize: 10, fontWeight: '600' },
  confirmedBadge: { backgroundColor: colors.green },
  confirmedBadgeText: { color: colors.greenInk },
  evidenceWarning: { backgroundColor: '#FFF0EC', borderRadius: 13, padding: 11, flexDirection: 'row', gap: 6, marginBottom: 10, alignItems: 'flex-start' },
  evidenceWarningText: { flex: 1, color: '#984542', fontSize: 11, lineHeight: 19 },
  editor: { backgroundColor: '#FFFDF8', borderRadius: 16, borderWidth: 1, borderColor: '#E5DCCD', paddingHorizontal: 14, paddingTop: 14, paddingBottom: 14, minHeight: 220, color: colors.ink, fontSize: 14, lineHeight: 25 },
  inactiveInput: { backgroundColor: '#F8F6F1', borderColor: colors.line, color: colors.muted },
  evidenceSection: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 18 },
  evidenceToggle: { minHeight: 47, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  evidenceToggleLabel: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  evidenceToggleText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  evidenceList: { gap: 10 },
  evidenceCard: { backgroundColor: '#FAF8F3', borderRadius: 15, padding: 13 },
  kindLabel: { color: colors.greenInk, fontSize: 10, fontWeight: '700', marginBottom: 7 },
  sentenceText: { color: colors.ink, fontSize: 12, lineHeight: 21 },
  observationRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginTop: 11 },
  observationDot: { backgroundColor: '#BAA88F', width: 4, height: 4, borderRadius: 2, marginTop: 8 },
  observationContent: { flex: 1, gap: 3 },
  observationActivity: { color: colors.muted, fontSize: 10, lineHeight: 17, fontWeight: '600' },
  observationText: { color: colors.muted, fontSize: 11, lineHeight: 20 },
  promptInput: { minHeight: 110, borderWidth: 1, borderColor: '#E5DCCD', backgroundColor: '#FFFDF8', borderRadius: 16, padding: 14, color: colors.ink, fontSize: 13, lineHeight: 23, marginBottom: 12 },
  candidateCard: { backgroundColor: colors.green, borderRadius: 17, padding: 15, marginTop: 18 },
  candidateHeading: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 11 },
  candidateTitle: { color: colors.greenInk, fontSize: 12, fontWeight: '700' },
  candidateText: { color: colors.ink, fontSize: 13, lineHeight: 24 },
  candidateHint: { color: colors.greenInk, fontSize: 10, lineHeight: 18, marginTop: 12 },
  twoActions: { flexDirection: 'row', gap: 8, marginTop: 15 },
  actionColumn: { flex: 1 },
  shareAction: { marginTop: 19 },
  closingNote: { color: colors.muted, fontSize: 11, textAlign: 'center', lineHeight: 20, marginTop: 3 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(49, 37, 28, 0.42)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 430, borderRadius: 27, backgroundColor: colors.background, padding: 25 },
  guardIcon: { width: 66, height: 66, backgroundColor: colors.yellowLight, borderRadius: 23, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 19 },
  modalTitle: { color: colors.ink, fontSize: 20, fontWeight: '700', lineHeight: 30, textAlign: 'center' },
  modalMessage: { color: colors.muted, fontSize: 13, lineHeight: 23, marginTop: 12, textAlign: 'center' },
  guardActions: { flexDirection: 'row', gap: 9, marginTop: 24 },
});
