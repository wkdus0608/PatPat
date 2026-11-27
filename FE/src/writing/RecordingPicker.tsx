import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import {
  ActivityIndicator, Pressable, SectionList, StyleSheet, Text, TextInput, View,
} from 'react-native';

import type { SavedRecording } from '../recording/storage';
import { colors, layout, radius, typeScale } from '../ui/theme';
import { workStyles } from '../ui/WorkFields';
import type { WritingViewProps } from './types';

const emptyRecordings: readonly SavedRecording[] = [];

function dateLabel(value: string) {
  const [year, month, day] = value.split('-');
  return year && month && day ? year + '년 ' + Number(month) + '월 ' + Number(day) + '일' : value;
}

export function RecordingPicker({ state, actions, capabilities }: WritingViewProps) {
  const busy = state.phase !== 'idle';
  const blocked = busy || state.guard !== null;
  const load = state.recordings;
  const recordings = load.status === 'ready' ? load.data : emptyRecordings;
  const checked = useMemo(() => new Set(state.checked), [state.checked]);
  const sections = useMemo(() => {
    const groups = new Map<string, SavedRecording[]>();
    for (const recording of recordings) {
      const group = groups.get(recording.dateKey) || [];
      group.push(recording);
      groups.set(recording.dateKey, group);
    }
    return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left))
      .map(([title, data]) => ({
        title, data: [...data].sort((left, right) => right.fileName.localeCompare(left.fileName)),
      }));
  }, [recordings]);
  const loading = load.status === 'idle' || load.status === 'loading';
  const canNext = state.recordType !== null && !blocked;

  let emptyTitle = '선택할 녹음이 없어요';
  let emptyMessage = '녹음을 남기면 날짜별로 확인하고 선택할 수 있어요.';
  if (loading) {
    emptyTitle = '녹음을 불러오고 있어요';
    emptyMessage = '이 기기에 저장된 파일을 확인하고 있어요.';
  } else if (load.status === 'unavailable') {
    emptyTitle = '녹음한 기기에서 확인해 주세요';
    emptyMessage = load.message;
  } else if (load.status === 'error') {
    emptyTitle = '녹음을 불러오지 못했어요';
    emptyMessage = load.message;
  }

  return (
    <View style={styles.fill} testID="writing-recording-picker">
      <View style={styles.navigation}>
        <Pressable accessibilityRole="button" accessibilityLabel="이전 탭으로 돌아가기"
          onPress={actions.back} style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
          testID="writing-picker-back">
          <Ionicons name="chevron-back" size={20} color={colors.ink} /><Text style={styles.backLabel}>뒤로</Text>
        </Pressable>
        <Text style={styles.progress}>1 / 3</Text>
      </View>
      <SectionList
        style={styles.fill} contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        sections={sections} keyExtractor={(item) => item.uri}
        initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View>
            <View style={styles.typeSection} testID="writing-record-type">
              <View style={styles.headingRow}>
                <Text accessibilityRole="header" style={styles.title}>어떤 기록을 작성할까요?</Text>
                <Text style={styles.requirement}>필수</Text>
              </View>
              <View accessibilityRole="radiogroup" accessibilityLabel="기록 유형" style={styles.typeOptions}>
                {(['관찰일지', '알림장'] as const).map(type => {
                  const selected = state.recordType === type;
                  return <Pressable key={type} accessibilityRole="radio" accessibilityLabel={type}
                    accessibilityState={{ checked: selected, disabled: blocked }} aria-checked={selected}
                    disabled={blocked} onPress={() => actions.selectRecordType(type)}
                    style={({ pressed }) => [styles.typeOption, selected && styles.selectedType,
                      blocked && styles.disabledOpacity, pressed && styles.pressed]}
                    testID={type === '관찰일지' ? 'writing-type-journal' : 'writing-type-notice'}>
                    <Text style={styles.typeLabel}>{type}</Text>
                  </Pressable>;
                })}
              </View>
            </View>
            <View style={styles.headingRow}>
              <View style={styles.fieldHeading}>
                <Text accessibilityRole="header" style={styles.fieldTitle}>녹음 선택</Text>
                <Text style={styles.requirement}>선택</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="녹음 목록 새로고침"
                accessibilityState={{ disabled: blocked || loading }} disabled={blocked || loading}
                onPress={actions.refreshRecordings}
                style={({ pressed }) => [styles.refreshButton, (blocked || loading) && styles.disabledOpacity, pressed && styles.pressed]}
                testID="writing-picker-refresh"
              ><Ionicons name="refresh-outline" size={20} color={colors.muted} /></Pressable>
            </View>
            <Text style={styles.subtitle}>사용할 녹음이 있다면 선택해 주세요.</Text>
            {state.notice && (
              <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice}>
                <Ionicons name="information-circle-outline" size={18} color={colors.ink} />
                <Text style={styles.noticeText}>{state.notice}</Text>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              {loading ? <ActivityIndicator color={colors.ink} size="large" />
                : <Ionicons name={load.status === 'unavailable' ? 'phone-portrait-outline' : load.status === 'error' ? 'alert-circle-outline' : 'mic-outline'} size={35} color={colors.ink} />}
            </View>
            <Text style={styles.emptyTitle}>{emptyTitle}</Text>
            <Text style={styles.emptyMessage}>{emptyMessage}</Text>
            {load.status === 'error' && (
              <Pressable accessibilityRole="button" accessibilityLabel="녹음 다시 불러오기"
                disabled={blocked} accessibilityState={{ disabled: blocked }} onPress={actions.refreshRecordings}
                style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
                testID="writing-picker-retry"
              ><Text style={styles.buttonText}>다시 불러오기</Text></Pressable>
            )}
          </View>
        }
        ListFooterComponent={
          <View style={styles.keywordsCard} testID="writing-keywords-section">
            <View style={styles.fieldHeading}>
              <Text accessibilityRole="header" style={styles.fieldTitle}>오늘의 키워드</Text>
              <Text style={styles.requirement}>선택</Text>
            </View>
            <Text style={styles.subtitle}>녹음이 없어도 오늘의 관찰을 키워드로 남길 수 있어요.</Text>
            <TextInput accessibilityLabel="오늘의 키워드" placeholder="놀이, 아동의 말과 행동 등을 적어주세요."
              placeholderTextColor={colors.muted} multiline textAlignVertical="top" value={state.keywords}
              accessibilityState={{ disabled: blocked }} aria-disabled={blocked} editable={!blocked}
              onChangeText={actions.editKeywords} style={[styles.keywordsInput, blocked && styles.disabledOpacity]}
              testID="writing-keywords" />
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeading}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>{dateLabel(section.title)}</Text>
            <Text style={styles.sectionCount}>{section.data.length}개</Text>
          </View>
        )}
        renderItem={({ item }) => {
          const selected = checked.has(item.uri);
          return (
            <Pressable accessibilityRole="checkbox"
              accessibilityLabel={dateLabel(item.dateKey) + ' ' + item.startTime + ' 녹음'}
              accessibilityState={{ checked: selected, disabled: blocked }}
              aria-checked={selected}
              disabled={blocked} onPress={() => actions.toggleRecording(item.uri)}
              style={({ pressed }) => [styles.recordingRow, selected && styles.selectedRow, blocked && styles.disabledOpacity, pressed && styles.pressed]}
              testID={'writing-picker-file-' + item.fileName}
            >
              <View style={styles.microphoneIcon}><Ionicons name="mic-outline" size={22} color={colors.ink} /></View>
              <View style={styles.recordingText}>
                <Text style={styles.recordingTitle}>{item.startTime} 녹음</Text>
                <Text style={styles.fileName}>{item.fileName}</Text>
              </View>
              <Ionicons name={selected ? 'checkbox-outline' : 'square-outline'} size={20} color={selected ? colors.amberInk : colors.muted} />
            </Pressable>
          );
        }}
        testID="writing-picker-list"
      />
      <View style={styles.footer}>
        <View style={styles.countRow}>
          <Text style={styles.countLabel}>선택한 녹음</Text>
          <View style={styles.countActions}>
            {state.checked.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel="선택 모두 해제"
              accessibilityState={{ disabled: blocked }} disabled={blocked}
              onPress={() => [...state.checked].forEach(actions.toggleRecording)}
              style={({ pressed }) => [styles.clearButton, blocked && styles.disabledOpacity, pressed && styles.pressed]}
              testID="writing-picker-clear">
              <Text style={styles.clearLabel}>선택 모두 해제</Text>
            </Pressable>}
            <Text style={styles.count} testID="writing-picker-count">{state.checked.length}개</Text>
          </View>
        </View>
        <Pressable accessibilityRole="button"
          accessibilityLabel="다음"
          accessibilityState={{ disabled: !canNext, busy }} disabled={!canNext}
          aria-busy={busy}
          onPress={actions.next}
          style={({ pressed }) => [styles.importButton, !canNext && styles.disabledButton, pressed && canNext && styles.pressed]}
          testID="writing-next"
        >
          {busy && <ActivityIndicator color={colors.muted} />}
          <Text style={[styles.buttonText, !canNext && styles.disabledText]}>{busy ? '초안 준비 중…' : '다음'}</Text>
        </Pressable>
        <Text accessibilityLiveRegion="polite" style={styles.footerHint}>
          {busy ? state.phase === 'validating' ? '선택한 녹음을 확인하고 있어요.' : (state.recordType ?? '기록') + ' 초안을 준비하고 있어요.'
            : state.recordType === null ? '기록 유형을 선택해 주세요.'
              : !capabilities.generation || state.recordType === '알림장' || !!state.keywords.trim() ? '초안 작성 기능은 연결 준비 중이에요.'
                : state.checked.length === 0 ? '녹음과 키워드는 선택 사항이에요.' : '다음을 누르면 선택한 녹음으로 초안을 작성해요.'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { ...workStyles.content, gap: 0, flexGrow: 1 },
  navigation: { ...workStyles.between, paddingHorizontal: layout.gutter, minHeight: layout.touch },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 44, paddingRight: 12 },
  backLabel: workStyles.label,
  progress: workStyles.hint,
  headingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  title: { ...workStyles.heading, flexShrink: 1 },
  typeSection: { marginBottom: 24, gap: 12 },
  typeOptions: workStyles.row,
  typeOption: { ...workStyles.choice, flex: 1, minWidth: 100 },
  selectedType: workStyles.choiceSelected,
  typeLabel: workStyles.label,
  fieldHeading: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  fieldTitle: { ...workStyles.title, flexShrink: 1 },
  requirement: workStyles.hint,
  refreshButton: { width: layout.touch, height: layout.touch, borderRadius: radius.control, justifyContent: 'center', alignItems: 'center' },
  subtitle: { ...workStyles.hint, marginTop: 4, marginBottom: 16 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12,
    backgroundColor: colors.yellowLight, borderRadius: radius.control, marginBottom: 16 },
  noticeText: { ...typeScale.meta, flex: 1, color: colors.amberInk },
  emptyCard: { ...workStyles.panel, alignItems: 'flex-start', gap: 8 },
  emptyIcon: { width: 48, height: 48, borderRadius: radius.control, backgroundColor: colors.raised,
    justifyContent: 'center', alignItems: 'center' },
  emptyTitle: workStyles.title,
  emptyMessage: workStyles.hint,
  keywordsCard: { ...workStyles.panel, marginTop: 24 },
  keywordsInput: { ...workStyles.input, minHeight: 152 },
  retryButton: { ...workStyles.button, alignSelf: 'flex-start', marginTop: 8 },
  sectionHeading: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingTop: 16, paddingBottom: 12 },
  sectionTitle: workStyles.label,
  sectionCount: workStyles.hint,
  recordingRow: { ...workStyles.panel, flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 8 },
  selectedRow: workStyles.choiceSelected,
  microphoneIcon: { width: 36, height: 36, borderRadius: radius.control, backgroundColor: colors.raised,
    alignItems: 'center', justifyContent: 'center' },
  recordingText: { flex: 1, minWidth: 0, gap: 4 },
  recordingTitle: workStyles.label,
  fileName: { ...typeScale.caption, color: colors.muted },
  footer: { paddingHorizontal: layout.gutter, paddingVertical: 12, backgroundColor: colors.paper, borderTopWidth: 1, borderTopColor: colors.line },
  countRow: { ...workStyles.between, marginBottom: 12 },
  countLabel: workStyles.hint,
  countActions: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  clearButton: { minHeight: layout.touch, justifyContent: 'center', paddingHorizontal: 4 },
  clearLabel: { ...workStyles.hint, textDecorationLine: 'underline' },
  count: { ...workStyles.title, fontVariant: ['tabular-nums'] },
  importButton: { ...workStyles.button, flexDirection: 'row', gap: 8 },
  buttonText: { ...workStyles.buttonText, flexShrink: 1 },
  disabledButton: { backgroundColor: colors.disabled },
  disabledText: { color: colors.muted },
  footerHint: { ...workStyles.hint, textAlign: 'center', marginTop: 8 },
  disabledOpacity: { opacity: 0.45 },
  pressed: { opacity: 0.65 },
});
