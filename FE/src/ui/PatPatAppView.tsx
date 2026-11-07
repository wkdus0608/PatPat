import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator, BackHandler, Image, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from './theme';
import { LibraryScreen, type LibraryHandle } from '../library/LibraryScreen';
import { WritingScreen, type WritingHandle } from '../writing/WritingScreen';
import { DailyWritingScreen } from '../writing/DailyWritingScreen';
import type { WritingServices } from '../writing/types';
import type { Account } from '../auth/controller';
import type { V2Api } from '../api/v2';
import { SettingsScreen, type SettingsHandle } from '../roster/SettingsScreen';
import { createRosterController } from '../roster/controller';

export interface RecorderViewProps {
  phase: 'idle' | 'preparing' | 'recording' | 'saving' | 'saved' | 'error';
  durationMillis: number;
  message: string | null;
  canRetry: boolean;
  canStart: boolean;
  /** Increases each time a side-button request asks to show the recording screen. */
  startSignal?: number;
  dateLabel: string;
  onStart: () => void;
  onStop: () => void;
  onRetry: () => void;
}

type IconName = ComponentProps<typeof Ionicons>['name'];
type Tab = 'record' | 'write' | 'library';

const tabs: { key: Tab; label: string; icon: IconName; activeIcon: IconName }[] = [
  { key: 'write', label: '일지 작성', icon: 'create-outline', activeIcon: 'create' },
  { key: 'record', label: '녹음', icon: 'mic-outline', activeIcon: 'mic' },
  { key: 'library', label: '보관함', icon: 'folder-open-outline', activeIcon: 'folder-open' },
];

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

  return (
    <>
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

    </>
  );
}

export function PatPatAppView(props: RecorderViewProps & { writingServices?: WritingServices; account?: Account; apiV2?: V2Api }) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('write');
  const [tabNotice, setTabNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rosterVersion, setRosterVersion] = useState(0);
  const apiV2 = props.apiV2;
  const roster = useMemo(() => props.account ? createRosterController(
    props.account.api, props.account.session.token, props.account.unauthorized,
    apiV2 && { load: apiV2.characteristics, save: apiV2.saveCharacteristics },
    apiV2 && { load: apiV2.teacherDocument, save: apiV2.saveTeacherDocument },
  ) : null, [props.account?.api, props.account?.session.token, props.account?.session.teacher.teacher_id, apiV2]);
  useEffect(() => () => roster?.dispose(), [roster]);
  const settingsSaving = useRef(false);
  const settingsRef = useRef<SettingsHandle | null>(null);
  const libraryRef = useRef<LibraryHandle | null>(null);
  const writingRef = useRef<WritingHandle | null>(null);
  const switching = useRef(false);
  const blockNavigation = props.phase === 'recording' || props.phase === 'preparing'
    || props.phase === 'saving' || props.canRetry;

  useEffect(() => { if (!blockNavigation) setTabNotice(null); }, [blockNavigation]);

  // A side-button request shows the recording screen even while the recording is already starting.
  useEffect(() => {
    if (!props.startSignal || switching.current) return;
    switching.current = true;
    void (async () => {
      try {
        await libraryRef.current?.leave().catch(() => false);
        Keyboard.dismiss();
        setTabNotice(null);
        setTab('record');
      } finally { switching.current = false; }
    })();
  }, [props.startSignal]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (tab === 'library') libraryRef.current?.back();
      else if (tab === 'write') writingRef.current?.back();
      else return false;
      return true;
    });
    return () => subscription.remove();
  }, [tab]);

  async function selectTab(nextTab: Tab) {
    if (nextTab === tab || switching.current) return;
    if (blockNavigation) {
      setTabNotice(props.canRetry
        ? '저장하지 못한 녹음이 있어요. 먼저 저장을 다시 시도해 주세요.'
        : '현재 녹음을 마치고 저장한 뒤 이동해 주세요.');
      return;
    }
    switching.current = true;
    try {
      if (tab === 'library' && await libraryRef.current?.leave() === false) {
        setTabNotice('처리 중인 작업을 마치거나 삭제 확인창을 닫은 뒤 이동해 주세요.');
        return;
      }
      if (tab === 'write' && await writingRef.current?.leave() === false) return;
      Keyboard.dismiss();
      setTabNotice(null);
      setTab(nextTab);
    } finally { switching.current = false; }
  }

  async function openSettings() {
    if (switching.current) return;
    if (blockNavigation) {
      setTabNotice('현재 녹음을 마치고 저장한 뒤 설정을 열어 주세요.');
      return;
    }
    switching.current = true;
    try {
      if (tab === 'library' && await libraryRef.current?.leave() === false) return;
      if (tab === 'write' && await writingRef.current?.leave() === false) return;
      Keyboard.dismiss();
      setSettingsOpen(true);
    } finally { switching.current = false; }
  }

  return (
    <View style={styles.appBackground}>
      <View style={[styles.appFrame, { paddingTop: insets.top }]}>
        <View style={styles.appHeader}>
          <View accessibilityLabel="PatPat 쓰담쓰담" style={styles.brand}>
            <View style={styles.brandLogoFrame}>
              <Image
                source={require('../../assets/patpat-logo.png')}
                resizeMode="contain"
                accessible={false}
                style={styles.brandLogo}
              />
            </View>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.brandName}>PatPat</Text>
          </View>
          <View style={styles.dateBadge}>
            <Ionicons name="calendar-outline" size={13} color={colors.muted} />
            <Text style={styles.dateText}>{props.dateLabel}</Text>
          </View>
          {props.account && <Pressable accessibilityRole="button" accessibilityLabel="설정 열기"
            style={{ padding: 10 }} onPress={() => { void openSettings(); }}>
            <Ionicons name="settings-outline" size={23} color={colors.ink} />
          </Pressable>}
        </View>
        {props.account && roster && settingsOpen && <Modal animationType="slide" onRequestClose={() => { if (!props.account?.busy && !settingsSaving.current) settingsRef.current?.back(); }}>
          <SettingsScreen ref={settingsRef} account={props.account} controller={roster} apiV2={apiV2} onClose={() => {
            setSettingsOpen(false);
            setRosterVersion(value => value + 1);
          }} onSavingChange={saving => { settingsSaving.current = saving; }} />
        </Modal>}
        <View style={[styles.writingContainer, tab !== 'write' && styles.hiddenScreen]}
          accessibilityElementsHidden={tab !== 'write'} importantForAccessibility={tab !== 'write' ? 'no-hide-descendants' : 'auto'}>
          {props.account && apiV2
            ? <DailyWritingScreen ref={writingRef} active={tab === 'write'} account={props.account} api={apiV2}
              rosterVersion={rosterVersion} onGoToRecording={() => { void selectTab('record'); }} />
            : <WritingScreen ref={writingRef} active={tab === 'write'} services={props.writingServices}
              onGoToRecording={() => { void selectTab('record'); }} />}
        </View>
        {tab === 'library' ? (
          <LibraryScreen account={props.account} ref={libraryRef} apiV2={apiV2} journalSource={props.writingServices?.journals}
            onGoToRecording={() => { void selectTab('record'); }} />
        ) : tab === 'record' ? (
          <ScrollView key={tab} contentContainerStyle={[styles.scrollContent, tab === 'record' && styles.recordingScrollContent]} showsVerticalScrollIndicator={false} style={styles.scrollView}>
            <RecordingScreen {...props} />
          </ScrollView>
        ) : null}
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
  brandLogoFrame: { width: 60, height: 52, flexShrink: 0, overflow: 'hidden', borderRadius: 12, backgroundColor: colors.white },
  // Frame the supplied illustration by hiding its outer whitespace; keep the asset unchanged.
  brandLogo: { width: 114, height: 76, position: 'absolute', left: -27, top: -12 },
  brandName: { fontSize: 27, fontWeight: '900', color: colors.ink, letterSpacing: -1.2, flexShrink: 1 },
  dateBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  dateText: { fontSize: 11, color: colors.muted, fontWeight: '500', flexShrink: 1 },
  writingContainer: { flex: 1 }, hiddenScreen: { display: 'none' },
  scrollView: { flex: 1 }, scrollContent: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 20 },
  recordingScrollContent: { flexGrow: 1, justifyContent: 'center', paddingTop: 24, paddingBottom: 32 },
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
  subtlePressed: { opacity: 0.6 },
  tabNotice: { marginHorizontal: 16, marginBottom: 8, paddingVertical: 11, paddingHorizontal: 13, borderRadius: 14, backgroundColor: colors.yellowLight, flexDirection: 'row', gap: 7, alignItems: 'flex-start' },
  tabNoticeText: { color: colors.ink, fontSize: 11, lineHeight: 18, flex: 1 },
  tabBar: { flexDirection: 'row', backgroundColor: colors.white, paddingTop: 11, borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 14 },
  tab: { flex: 1, alignItems: 'center', gap: 4, minHeight: 53, paddingHorizontal: 2 },
  tabIcon: { width: 51, minHeight: 31, paddingVertical: 4, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  selectedTabIcon: { backgroundColor: colors.yellowLight },
  tabLabel: { color: colors.muted, fontSize: 10, lineHeight: 16, textAlign: 'center' },
  selectedTabLabel: { color: colors.ink, fontWeight: '800' },
});
