import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from './theme';

export interface RecorderViewProps {
  phase: 'idle' | 'preparing' | 'recording' | 'saving' | 'saved' | 'error';
  durationMillis: number;
  todayCount: number | null;
  latestFileName: string | null;
  message: string | null;
  canRetry: boolean;
  canStart: boolean;
  summaryError: string | null;
  dateLabel: string;
  onStart: () => void;
  onStop: () => void;
  onRetry: () => void;
  onRefresh: () => void;
}

type IconName = ComponentProps<typeof Ionicons>['name'];
type Tab = 'record' | 'write' | 'library';

const tabs: { key: Tab; label: string; icon: IconName; activeIcon: IconName }[] = [
  { key: 'record', label: '녹음', icon: 'mic-outline', activeIcon: 'mic' },
  { key: 'write', label: '관찰일지 작성', icon: 'create-outline', activeIcon: 'create' },
  { key: 'library', label: '보관함', icon: 'folder-open-outline', activeIcon: 'folder-open' },
];

function Flower({ small = false }: { small?: boolean }) {
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={[styles.flower, small && styles.smallFlower]}>
      <View style={[styles.petal, styles.petalTop]} />
      <View style={[styles.petal, styles.petalRight]} />
      <View style={[styles.petal, styles.petalBottom]} />
      <View style={[styles.petal, styles.petalLeft]} />
      <View style={styles.flowerCenter} />
    </View>
  );
}

function formatDuration(durationMillis: number) {
  const total = Math.max(0, Math.floor(durationMillis / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? [String(hours).padStart(2, '0'), minutes, seconds].join(':')
    : [minutes, seconds].join(':');
}

function statusText(phase: RecorderViewProps['phase'], canRetry: boolean) {
  if (phase === 'preparing') return '녹음을 준비하고 있어요';
  if (phase === 'recording') return '지금 녹음하고 있어요';
  if (phase === 'saving') return '녹음을 저장하고 있어요';
  if (phase === 'saved') return '소중한 순간을 담았어요';
  if (phase === 'error') return canRetry ? '녹음을 보관하고 있어요' : '다시 시작할 수 있어요';
  return '녹음할 준비가 되었어요';
}

function RecordingScreen(props: RecorderViewProps) {
  const recording = props.phase === 'recording';
  const busy = props.phase === 'preparing' || props.phase === 'saving';
  const retry = props.canRetry && !busy;
  const disabled = busy || (!recording && !retry && !props.canStart);
  const actionLabel = recording ? '중지하고 저장'
    : props.phase === 'saving' ? '저장 중…'
      : props.phase === 'preparing' ? '준비 중…'
        : retry ? '저장 다시 시도' : '녹음 시작';
  const action = recording ? props.onStop : retry ? props.onRetry : props.onStart;
  const iconName: IconName = recording ? 'stop' : retry ? 'refresh' : 'mic';
  const summaryLoading = props.todayCount === null && !props.summaryError;
  const latestDescription = props.summaryError ? '저장된 녹음을 확인하지 못했어요.'
    : summaryLoading ? '저장된 녹음을 확인하고 있어요.' : '아직 저장된 녹음이 없어요.';

  return (
    <>
      <View style={styles.introduction}>
        <View style={styles.eyebrowRow}>
          <View style={styles.eyebrowDot} />
          <Text style={styles.eyebrow}>오늘의 작은 발견</Text>
        </View>
        <Text accessibilityRole="header" style={styles.screenTitle}>
          {'아이의 오늘을\n차곡차곡 담아요.'}
        </Text>
        <Text style={styles.screenDescription}>기억해 둘 관찰 내용을 편하게 말해 주세요.</Text>
      </View>

      <View style={styles.recorderCard}>
        <View style={styles.cardTopRow}>
          <Text style={styles.cardTitle}>관찰 녹음</Text>
          <View style={styles.localBadge}>
            <Ionicons name="phone-portrait-outline" size={12} color={colors.muted} />
            <Text style={styles.localBadgeText}>기기에 저장</Text>
          </View>
        </View>
        <View accessible={false} importantForAccessibility="no-hide-descendants" style={[styles.microphoneBackdrop, recording && styles.microphoneBackdropRecording]}>
          <View style={[styles.microphoneCircle, recording && styles.microphoneCircleRecording]}>
            <Ionicons name={recording ? 'mic' : 'mic-outline'} size={43} color={recording ? colors.rose : colors.ink} />
          </View>
          <View style={[styles.microphoneAccent, recording && styles.microphoneAccentRecording]}>
            <Ionicons name={recording ? 'ellipse' : 'sparkles'} size={13} color={recording ? colors.white : colors.ink} />
          </View>
        </View>
        <Text
          accessibilityLabel={'녹음 시간 ' + formatDuration(props.durationMillis)}
          adjustsFontSizeToFit minimumFontScale={0.65} numberOfLines={1}
          style={styles.timer} testID="recording-duration"
        >
          {formatDuration(props.durationMillis)}
        </Text>
        <View style={styles.statusLine}>
          {recording && <View style={styles.recordingDot} />}
          <Text style={[styles.recorderStatus, recording && styles.recorderStatusRecording]}>
            {statusText(props.phase, props.canRetry)}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button" accessibilityLabel={actionLabel}
          accessibilityHint={recording ? '녹음을 마치고 이 기기에 저장합니다.' : undefined}
          accessibilityState={{ disabled, busy }}
          disabled={disabled} onPress={action}
          style={({ pressed }) => [
            styles.recordButton, recording && styles.stopButton,
            disabled && styles.disabledButton, pressed && !disabled && styles.pressedButton,
          ]}
          testID={retry ? 'retry-save' : 'record-action'}
        >
          {busy ? <ActivityIndicator color={colors.muted} />
            : <Ionicons name={iconName} size={20} color={recording ? colors.white : colors.ink} />}
          <Text style={[styles.recordButtonText, recording && styles.stopButtonText, disabled && styles.disabledButtonText]}>
            {actionLabel}
          </Text>
        </Pressable>
        <Text style={styles.recorderHint}>
          {props.canRetry ? '아직 저장하지 못한 녹음이 있어요. 먼저 저장을 마쳐 주세요.'
            : recording ? '말을 마치면 중지하고 저장해 주세요.'
              : '필요한 순간마다, 짧게 남겨도 괜찮아요.'}
        </Text>
      </View>

      {props.message && (
        <View
          accessibilityLiveRegion="polite" accessibilityRole={props.phase === 'error' ? 'alert' : undefined}
          style={[styles.notice, props.phase === 'error' ? styles.errorNotice : styles.successNotice]}
          testID="recording-message"
        >
          <Ionicons name={props.phase === 'error' ? 'information-circle-outline' : 'checkmark-circle-outline'} color={props.phase === 'error' ? colors.rose : colors.greenInk} size={20} />
          <Text style={[styles.noticeText, props.phase === 'error' && styles.errorNoticeText]}>{props.message}</Text>
        </View>
      )}

      <View style={styles.summaryCard}>
        <View style={styles.summaryTopRow}>
          <View style={styles.summaryHeading}>
            <View style={styles.summaryIcon}><Ionicons name="sunny-outline" size={19} color={colors.ink} /></View>
            <Text style={styles.summaryTitle}>오늘 모은 녹음</Text>
          </View>
          <Pressable
            accessibilityRole="button" accessibilityLabel="저장된 녹음 정보 새로고침"
            onPress={props.onRefresh} hitSlop={8}
            style={({ pressed }) => [styles.refreshButton, pressed && styles.subtlePressed]}
            testID="refresh-summary"
          >
            <Ionicons name="refresh-outline" size={18} color={colors.muted} />
          </Pressable>
        </View>
        <View style={styles.countRow}>
          <Text style={styles.count} testID="today-count">{props.todayCount ?? '—'}</Text>
          {props.todayCount !== null && <Text style={styles.countUnit}>개</Text>}
          <Text style={styles.countCaption}>
            {props.summaryError ? '개수를 확인하지 못했어요' : summaryLoading ? '확인하고 있어요' : '오늘의 순간이 차곡차곡'}
          </Text>
        </View>
        {props.summaryError && <Text accessibilityRole="alert" style={styles.summaryError}>{props.summaryError}</Text>}
      </View>

      <View style={styles.latestCard}>
        <View style={styles.latestIcon}><Ionicons name="document-text-outline" size={22} color={colors.greenInk} /></View>
        <View style={styles.latestContent}>
          <Text style={styles.latestTitle}>최근 저장한 녹음</Text>
          <Text selectable style={[styles.latestFileName, !props.latestFileName && styles.emptyFileName]} testID="latest-recording">
            {props.latestFileName ?? latestDescription}
          </Text>
        </View>
        {!!props.latestFileName && !props.summaryError && <Ionicons name="checkmark-circle" size={19} color={colors.greenInk} />}
      </View>
      <View style={styles.bottomNote}>
        <Flower small /><Text style={styles.bottomNoteText}>작은 관찰을 소중한 기록으로.</Text>
      </View>
    </>
  );
}

function PlaceholderScreen({ tab }: { tab: Exclude<Tab, 'record'> }) {
  const writing = tab === 'write';
  return (
    <>
      <View style={styles.introduction}>
        <View style={styles.eyebrowRow}>
          <View style={[styles.eyebrowDot, { backgroundColor: writing ? '#9DC5A8' : '#9BBDE0' }]} />
          <Text style={styles.eyebrow}>{writing ? '관찰일지 작성' : '우리 반 보관함'}</Text>
        </View>
        <Text accessibilityRole="header" style={styles.screenTitle}>
          {writing ? '차곡차곡 쌓인 관찰을\n하나의 기록으로.' : '지난 순간을\n다시 만나는 곳.'}
        </Text>
        <Text style={styles.screenDescription}>
          {writing ? '선생님의 관찰이 기록으로 이어지는 공간이에요.' : '이전 녹음과 관찰일지를 함께 살펴보는 공간이에요.'}
        </Text>
      </View>
      <View style={styles.placeholderCard}>
        <View style={[styles.placeholderIllustration, { backgroundColor: writing ? colors.green : colors.blue }]}>
          <Ionicons name={writing ? 'create-outline' : 'folder-open-outline'} size={54} color={writing ? colors.greenInk : colors.blueInk} />
        </View>
        <View style={styles.preparingBadge}><Text style={styles.preparingBadgeText}>준비 중</Text></View>
        <Text style={styles.placeholderTitle}>
          {writing ? '관찰일지 작성 공간을\n준비하고 있어요.' : '녹음과 기록을 모아 볼 공간을\n준비하고 있어요.'}
        </Text>
        <Text style={styles.placeholderDescription}>
          {writing ? '지금은 녹음 탭에서\n기억해 둘 순간을 남겨 주세요.' : '녹음한 파일은 이 기기에 저장돼요.\n목록에서 확인하는 기능은 준비 중이에요.'}
        </Text>
      </View>
      <View style={styles.bottomNote}>
        <Flower small /><Text style={styles.bottomNoteText}>선생님의 관찰을 소중하게.</Text>
      </View>
    </>
  );
}

export function PatPatAppView(props: RecorderViewProps) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('record');
  const [tabNotice, setTabNotice] = useState<string | null>(null);
  const blockNavigation = props.phase === 'recording' || props.phase === 'preparing'
    || props.phase === 'saving' || props.canRetry;

  useEffect(() => { if (!blockNavigation) setTabNotice(null); }, [blockNavigation]);

  function selectTab(nextTab: Tab) {
    if (nextTab === tab) return;
    if (blockNavigation) {
      setTabNotice(props.canRetry
        ? '저장하지 못한 녹음이 있어요. 먼저 저장을 다시 시도해 주세요.'
        : '현재 녹음을 마치고 저장한 뒤 이동해 주세요.');
      return;
    }
    setTabNotice(null);
    setTab(nextTab);
  }

  return (
    <View style={styles.appBackground}>
      <View style={[styles.appFrame, { paddingTop: insets.top }]}>
        <View style={styles.appHeader}>
          <View accessibilityLabel="PatPat 쓰담쓰담" style={styles.brand}>
            <Flower /><Text style={styles.brandName}>PatPat</Text>
          </View>
          <View style={styles.dateBadge}>
            <Ionicons name="calendar-outline" size={13} color={colors.muted} />
            <Text style={styles.dateText}>{props.dateLabel}</Text>
          </View>
        </View>
        <ScrollView key={tab} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} style={styles.scrollView}>
          {tab === 'record' ? <RecordingScreen {...props} /> : <PlaceholderScreen tab={tab} />}
        </ScrollView>
        {tabNotice && (
          <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.tabNotice}>
            <Ionicons name="information-circle-outline" size={17} color={colors.ink} />
            <Text style={styles.tabNoticeText}>{tabNotice}</Text>
          </View>
        )}
        <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {tabs.map((item) => {
            const selected = tab === item.key;
            return (
              <Pressable
                accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected }}
                key={item.key} onPress={() => selectTab(item.key)}
                style={({ pressed }) => [styles.tab, pressed && styles.subtlePressed]}
                testID={'tab-' + item.key}
              >
                <View style={[styles.tabIcon, selected && styles.selectedTabIcon]}>
                  <Ionicons name={selected ? item.activeIcon : item.icon} size={22} color={selected ? colors.ink : colors.muted} />
                </View>
                <Text style={[styles.tabLabel, selected && styles.selectedTabLabel]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  appBackground: { flex: 1, backgroundColor: colors.background },
  appFrame: { flex: 1, width: '100%', maxWidth: 540, alignSelf: 'center' },
  appHeader: { minHeight: 74, paddingHorizontal: 24, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9, flexShrink: 1 },
  brandName: { fontSize: 27, fontWeight: '900', color: colors.ink, letterSpacing: -1.2 },
  dateBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  dateText: { fontSize: 11, color: colors.muted, fontWeight: '500', flexShrink: 1 },
  flower: { width: 29, height: 29, position: 'relative' },
  smallFlower: { transform: [{ scale: 0.58 }], marginRight: -5, marginLeft: -5 },
  petal: { position: 'absolute', width: 15, height: 15, borderRadius: 8, backgroundColor: '#F8CF63' },
  petalTop: { top: 0, left: 7 }, petalRight: { top: 7, left: 14 },
  petalBottom: { top: 14, left: 7 }, petalLeft: { top: 7, left: 0 },
  flowerCenter: { position: 'absolute', width: 10, height: 10, borderRadius: 5, backgroundColor: colors.background, left: 9.5, top: 9.5 },
  scrollView: { flex: 1 }, scrollContent: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 20 },
  introduction: { paddingTop: 9, marginBottom: 25 },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 11 },
  eyebrowDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#E4B64F' },
  eyebrow: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  screenTitle: { color: colors.ink, fontSize: 29, lineHeight: 39, letterSpacing: -1.2, fontWeight: '800' },
  screenDescription: { color: colors.muted, fontSize: 13, lineHeight: 22, marginTop: 10, letterSpacing: -0.25 },
  recorderCard: { backgroundColor: colors.white, borderRadius: 28, paddingHorizontal: 22, paddingTop: 22, paddingBottom: 18, borderWidth: 1, borderColor: '#F3EDE2', shadowColor: '#6C4F20', shadowOpacity: 0.035, shadowOffset: { width: 0, height: 6 }, shadowRadius: 15, elevation: 1 },
  cardTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  cardTitle: { color: colors.ink, fontWeight: '700', fontSize: 14 },
  localBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#F8F7F3', borderRadius: 20, paddingHorizontal: 8, paddingVertical: 5 },
  localBadgeText: { fontSize: 10, color: colors.muted },
  microphoneBackdrop: { width: 112, height: 112, borderRadius: 56, backgroundColor: '#FFF9E8', alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginTop: 23, marginBottom: 12 },
  microphoneBackdropRecording: { backgroundColor: '#FFF2F0' },
  microphoneCircle: { width: 86, height: 86, borderRadius: 43, backgroundColor: colors.yellowLight, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#F8E4AF' },
  microphoneCircleRecording: { backgroundColor: colors.pink, borderColor: '#F6D2D3' },
  microphoneAccent: { position: 'absolute', width: 29, height: 29, borderRadius: 15, right: 0, top: 9, backgroundColor: colors.yellow, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: colors.white },
  microphoneAccentRecording: { backgroundColor: colors.rose },
  timer: { color: colors.ink, fontSize: 48, lineHeight: 61, fontWeight: '600', letterSpacing: 1.5, textAlign: 'center', fontVariant: ['tabular-nums'], fontFamily: Platform.OS === 'ios' ? 'Menlo' : Platform.OS === 'android' ? 'monospace' : undefined },
  statusLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginBottom: 24, minHeight: 21 },
  recorderStatus: { color: colors.muted, fontSize: 12, textAlign: 'center', lineHeight: 20 },
  recorderStatusRecording: { color: colors.rose },
  recordingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.rose },
  recordButton: { minHeight: 54, backgroundColor: colors.yellow, borderRadius: 17, paddingHorizontal: 15, paddingVertical: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  stopButton: { backgroundColor: colors.rose }, disabledButton: { backgroundColor: colors.disabled },
  pressedButton: { opacity: 0.8, transform: [{ scale: 0.985 }] },
  recordButtonText: { fontSize: 15, fontWeight: '800', color: colors.ink, flexShrink: 1 },
  stopButtonText: { color: colors.white }, disabledButtonText: { color: colors.muted },
  recorderHint: { color: colors.muted, fontSize: 10, lineHeight: 18, textAlign: 'center', marginTop: 11 },
  notice: { borderRadius: 17, paddingHorizontal: 15, paddingVertical: 13, flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 14 },
  successNotice: { backgroundColor: colors.green }, errorNotice: { backgroundColor: '#FFF0EC' },
  noticeText: { color: colors.greenInk, fontSize: 12, lineHeight: 20, flex: 1 },
  errorNoticeText: { color: '#984542' },
  summaryCard: { backgroundColor: colors.yellowLight, borderRadius: 23, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 17, marginTop: 18 },
  summaryTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  summaryHeading: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  summaryIcon: { width: 30, height: 30, backgroundColor: '#FFF9E7', borderRadius: 11, justifyContent: 'center', alignItems: 'center' },
  summaryTitle: { fontSize: 13, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  refreshButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  subtlePressed: { opacity: 0.6 },
  countRow: { flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 7, flexWrap: 'wrap' },
  count: { fontSize: 35, fontWeight: '800', color: colors.ink, fontVariant: ['tabular-nums'], letterSpacing: -1 },
  countUnit: { fontSize: 15, fontWeight: '600', color: colors.ink },
  countCaption: { color: colors.muted, fontSize: 11, marginLeft: 8, lineHeight: 19, flexShrink: 1 },
  summaryError: { color: '#984542', fontSize: 11, lineHeight: 18, marginTop: 7 },
  latestCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.white, borderRadius: 21, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 16, paddingVertical: 19, marginTop: 12 },
  latestIcon: { width: 43, height: 43, borderRadius: 15, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' },
  latestContent: { flex: 1, gap: 6 },
  latestTitle: { color: colors.muted, fontWeight: '500', fontSize: 11 },
  latestFileName: { color: colors.ink, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  emptyFileName: { color: colors.muted, fontSize: 11, fontWeight: '400' },
  bottomNote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, marginTop: 20, marginBottom: 1 },
  bottomNoteText: { color: colors.muted, fontSize: 10, letterSpacing: -0.1 },
  placeholderCard: { backgroundColor: colors.white, borderRadius: 28, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 24, paddingVertical: 40, alignItems: 'center' },
  placeholderIllustration: { width: 115, height: 115, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 23, transform: [{ rotate: '-5deg' }] },
  preparingBadge: { backgroundColor: colors.yellowLight, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, marginBottom: 15 },
  preparingBadgeText: { color: colors.ink, fontSize: 11, fontWeight: '700' },
  placeholderTitle: { color: colors.ink, textAlign: 'center', fontSize: 21, lineHeight: 31, letterSpacing: -0.7, fontWeight: '700' },
  placeholderDescription: { color: colors.muted, textAlign: 'center', fontSize: 12, lineHeight: 22, marginTop: 13 },
  tabNotice: { marginHorizontal: 16, marginBottom: 8, paddingVertical: 11, paddingHorizontal: 13, borderRadius: 14, backgroundColor: colors.yellowLight, flexDirection: 'row', gap: 7, alignItems: 'flex-start' },
  tabNoticeText: { color: colors.ink, fontSize: 11, lineHeight: 18, flex: 1 },
  tabBar: { flexDirection: 'row', backgroundColor: colors.white, paddingTop: 11, borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 14 },
  tab: { flex: 1, alignItems: 'center', gap: 4, minHeight: 53, paddingHorizontal: 2 },
  tabIcon: { width: 51, minHeight: 31, paddingVertical: 4, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  selectedTabIcon: { backgroundColor: colors.yellowLight },
  tabLabel: { color: colors.muted, fontSize: 10, lineHeight: 16, textAlign: 'center' },
  selectedTabLabel: { color: colors.ink, fontWeight: '800' },
});
