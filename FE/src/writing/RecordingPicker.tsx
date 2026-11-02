import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import {
  ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View,
} from 'react-native';

import type { SavedRecording } from '../recording/storage';
import { colors } from '../ui/theme';
import type { WritingViewProps } from './types';

const emptyRecordings: readonly SavedRecording[] = [];

function dateLabel(value: string) {
  const [year, month, day] = value.split('-');
  return year && month && day ? year + '년 ' + Number(month) + '월 ' + Number(day) + '일' : value;
}

export function RecordingPicker({ state, actions }: Pick<WritingViewProps, 'state' | 'actions'>) {
  const busy = state.phase !== 'idle';
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
  const canImport = load.status === 'ready' && state.checked.length > 0 && !busy;

  let emptyTitle = '가져올 녹음이 없어요';
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
      <SectionList
        style={styles.fill} contentContainerStyle={styles.content}
        sections={sections} keyExtractor={(item) => item.uri}
        initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View>
            <View style={styles.navigation}>
              <Pressable accessibilityRole="button" accessibilityLabel="녹음 선택을 취소하고 돌아가기"
                accessibilityState={{ disabled: busy }} disabled={busy} onPress={actions.cancelPicker}
                style={({ pressed }) => [styles.backButton, busy && styles.disabledOpacity, pressed && styles.pressed]}
                testID="writing-picker-back"
              >
                <Ionicons name="chevron-back" size={20} color={colors.ink} />
                <Text style={styles.backLabel}>뒤로</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="녹음 선택 취소"
                accessibilityState={{ disabled: busy }} disabled={busy} onPress={actions.cancelPicker}
                style={({ pressed }) => [styles.cancelButton, busy && styles.disabledOpacity, pressed && styles.pressed]}
                testID="writing-picker-cancel"
              ><Text style={styles.cancelLabel}>취소</Text></Pressable>
            </View>
            <View style={styles.headingRow}>
              <Text accessibilityRole="header" style={styles.title}>녹음 가져오기</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="가져올 녹음 목록 새로고침"
                accessibilityState={{ disabled: busy || loading }} disabled={busy || loading}
                onPress={actions.refreshRecordings}
                style={({ pressed }) => [styles.refreshButton, (busy || loading) && styles.disabledOpacity, pressed && styles.pressed]}
                testID="writing-picker-refresh"
              ><Ionicons name="refresh-outline" size={20} color={colors.muted} /></Pressable>
            </View>
            <Text style={styles.subtitle}>관찰일지에 사용할 녹음을 여러 개 골라 주세요.</Text>
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
                disabled={busy} accessibilityState={{ disabled: busy }} onPress={actions.refreshRecordings}
                style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
                testID="writing-picker-retry"
              ><Text style={styles.buttonText}>다시 불러오기</Text></Pressable>
            )}
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
              accessibilityState={{ checked: selected, disabled: busy }}
              aria-checked={selected}
              disabled={busy} onPress={() => actions.toggleRecording(item.uri)}
              style={({ pressed }) => [styles.recordingRow, selected && styles.selectedRow, busy && styles.disabledOpacity, pressed && styles.pressed]}
              testID={'writing-picker-file-' + item.fileName}
            >
              <View style={styles.microphoneIcon}><Ionicons name="mic-outline" size={22} color={colors.ink} /></View>
              <View style={styles.recordingText}>
                <Text style={styles.recordingTitle}>{item.startTime} 녹음</Text>
                <Text style={styles.fileName}>{item.fileName}</Text>
              </View>
              <Ionicons name={selected ? 'checkbox' : 'square-outline'} size={25} color={selected ? colors.ink : '#A99B8D'} />
            </Pressable>
          );
        }}
        testID="writing-picker-list"
      />
      <View style={styles.footer}>
        <View style={styles.countRow}>
          <Text style={styles.countLabel}>선택한 녹음</Text>
          <Text style={styles.count} testID="writing-picker-count">{state.checked.length}개</Text>
        </View>
        <Pressable accessibilityRole="button"
          accessibilityLabel="선택한 녹음 가져오기"
          accessibilityState={{ disabled: !canImport, busy }} disabled={!canImport}
          aria-busy={busy}
          onPress={actions.importRecordings}
          style={({ pressed }) => [styles.importButton, !canImport && styles.disabledButton, pressed && canImport && styles.pressed]}
          testID="writing-picker-import"
        >
          {busy ? <ActivityIndicator color={colors.muted} /> : <Ionicons name="checkmark" size={20} color={canImport ? colors.ink : colors.muted} />}
          <Text style={[styles.buttonText, !canImport && styles.disabledText]}>선택한 녹음 가져오기</Text>
        </Pressable>
        {state.checked.length === 0 && <Text style={styles.footerHint}>가져올 녹음을 하나 이상 선택해 주세요.</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 2, paddingBottom: 20, flexGrow: 1 },
  navigation: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 44, paddingRight: 12 },
  backLabel: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  cancelButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  cancelLabel: { color: colors.muted, fontSize: 13 },
  headingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  title: { color: colors.ink, fontSize: 25, fontWeight: '800', letterSpacing: -0.8, lineHeight: 36, flexShrink: 1 },
  refreshButton: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' },
  subtitle: { color: colors.muted, fontSize: 13, lineHeight: 22, marginTop: 5, marginBottom: 19 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 14, backgroundColor: colors.yellowLight, borderRadius: 16, marginBottom: 15 },
  noticeText: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 20 },
  emptyCard: { backgroundColor: colors.white, borderRadius: 25, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 24, paddingVertical: 31, alignItems: 'center' },
  emptyIcon: { width: 79, height: 79, borderRadius: 27, backgroundColor: colors.yellowLight, justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  emptyTitle: { color: colors.ink, fontSize: 18, fontWeight: '700', lineHeight: 28, textAlign: 'center' },
  emptyMessage: { color: colors.muted, fontSize: 13, lineHeight: 22, textAlign: 'center', marginTop: 9 },
  retryButton: { alignSelf: 'stretch', marginTop: 22, borderRadius: 15, backgroundColor: colors.yellow, minHeight: 48, padding: 13, alignItems: 'center', justifyContent: 'center' },
  sectionHeading: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingTop: 16, paddingBottom: 12 },
  sectionTitle: { color: colors.ink, fontSize: 13, fontWeight: '700', lineHeight: 22 },
  sectionCount: { color: colors.muted, fontSize: 11 },
  recordingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 19, paddingHorizontal: 14, paddingVertical: 17, marginBottom: 10 },
  selectedRow: { backgroundColor: '#FFF9E8', borderColor: '#D9B960' },
  microphoneIcon: { width: 36, height: 41, borderRadius: 13, backgroundColor: colors.yellowLight, alignItems: 'center', justifyContent: 'center' },
  recordingText: { flex: 1, gap: 5 },
  recordingTitle: { color: colors.ink, fontSize: 14, fontWeight: '700', lineHeight: 22 },
  fileName: { color: colors.muted, fontSize: 11, lineHeight: 18 },
  footer: { paddingHorizontal: 24, paddingTop: 14, paddingBottom: 16, backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.line },
  countRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 10 },
  countLabel: { color: colors.muted, fontSize: 12 },
  count: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  importButton: { backgroundColor: colors.yellow, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 15, minHeight: 52, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  buttonText: { color: colors.ink, fontSize: 14, lineHeight: 21, fontWeight: '700', flexShrink: 1 },
  disabledButton: { backgroundColor: colors.disabled },
  disabledText: { color: colors.muted },
  footerHint: { color: colors.muted, fontSize: 11, textAlign: 'center', lineHeight: 18, marginTop: 8 },
  disabledOpacity: { opacity: 0.45 },
  pressed: { opacity: 0.65 },
});
