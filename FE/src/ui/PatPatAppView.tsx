import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator, BackHandler, Image, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, layout, radius, typeScale } from './theme';
import { workStyles } from './WorkFields';
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
  /** 업로드 결과가 오류인지(없으면 phase로 판단). */
  messageIsError?: boolean;
  importBusy?: boolean;
  /** 기기의 녹음 파일을 서버에 올린다. 로그인 전에는 없다. */
  onImport?: () => void;
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
  if (phase === 'saved') return '녹음을 저장했어요';
  if (phase === 'error') return canRetry ? '녹음 저장을 마치지 못했어요' : '녹음을 다시 시작할 수 있어요';
  return '녹음 대기 중';
}

function RecordingScreen(props: RecorderViewProps) {
  const recording = props.phase === 'recording';
  const duration = formatDuration(recording ? props.durationMillis : 0);
  const busy = props.phase === 'preparing' || props.phase === 'saving';
  const retry = props.canRetry && !busy;
  const disabled = busy || (!recording && !retry && !props.canStart);
  const actionLabel = recording ? '중지하고 저장'
    : props.phase === 'saving' ? '저장 중…'
      : props.phase === 'preparing' ? '준비 중…'
        : retry ? '저장 다시 시도' : '녹음 시작';
  const action = recording ? props.onStop : retry ? props.onRetry : props.onStart;
  const iconName: IconName = recording ? 'stop' : retry ? 'refresh' : 'mic';
  const failed = props.messageIsError ?? props.phase === 'error';
  const canImport = !!props.onImport && !props.importBusy && !busy && !recording && !retry;

  return (
    <>
      <View style={styles.recorderCard}>
        <View style={styles.cardTopRow}>
          <Text accessibilityRole="header" style={workStyles.heading}>관찰 녹음</Text>
          <View style={styles.localBadge}>
            <Ionicons accessible={false} name="phone-portrait-outline" size={16} color={colors.muted} />
            <Text style={styles.localBadgeText}>기기에 저장</Text>
          </View>
        </View>
        <Text
          accessibilityLabel={'녹음 시간 ' + duration}
          adjustsFontSizeToFit minimumFontScale={0.65} numberOfLines={1}
          style={styles.timer} testID="recording-duration"
        >
          {duration}
        </Text>
        <View accessibilityLiveRegion="polite" style={styles.statusLine}>
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
        {props.onImport && (
          <Pressable
            accessibilityRole="button" accessibilityLabel="녹음 파일 올리기"
            accessibilityState={{ disabled: !canImport, busy: props.importBusy }}
            disabled={!canImport} onPress={props.onImport}
            style={({ pressed }) => [styles.importButton, !canImport && styles.disabledButton, pressed && canImport && styles.pressedButton]}
            testID="import-audio"
          >
            {props.importBusy ? <ActivityIndicator color={colors.muted} />
              : <Ionicons name="cloud-upload-outline" size={18} color={colors.ink} />}
            <Text style={styles.importButtonText}>{props.importBusy ? '올리는 중…' : '녹음 파일 올리기'}</Text>
          </Pressable>
        )}
      </View>

      {props.message && (
        <View
          accessibilityLiveRegion="polite" accessibilityRole={failed ? 'alert' : undefined}
          style={[styles.notice, failed ? styles.errorNotice : styles.successNotice]}
          testID="recording-message"
        >
          <Ionicons name={failed ? 'information-circle-outline' : 'checkmark-circle-outline'} color={failed ? colors.rose : colors.greenInk} size={20} />
          <Text style={[styles.noticeText, failed && styles.errorNoticeText]}>{props.message}</Text>
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
            <Text style={styles.dateText}>오늘 {props.dateLabel}</Text>
          </View>
          {props.account && <Pressable accessibilityRole="button" accessibilityLabel="설정 열기"
            style={({ pressed }) => [styles.settingsButton, pressed && workStyles.pressed]} onPress={() => { void openSettings(); }}>
            <Ionicons name="settings-outline" size={20} color={colors.ink} />
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
          <ScrollView key={tab} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} style={styles.scrollView}>
            <RecordingScreen {...props} />
          </ScrollView>
        ) : null}
        {tabNotice && (
          <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.tabNotice}>
            <Ionicons name="information-circle-outline" size={17} color={colors.ink} />
            <Text style={styles.tabNoticeText}>{tabNotice}</Text>
          </View>
        )}
        <View accessibilityRole="tablist" style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
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
                  <Ionicons accessible={false} name={selected ? item.activeIcon : item.icon} size={20} color={selected ? colors.ink : colors.muted} />
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
  appFrame: { flex: 1, width: '100%', maxWidth: layout.screenWidth, alignSelf: 'center' },
  appHeader: { minHeight: 60, paddingHorizontal: layout.gutter, paddingVertical: 8, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  brandLogoFrame: { width: 44, height: 40, flexShrink: 0, overflow: 'hidden', borderRadius: radius.control, backgroundColor: colors.white },
  // Frame the supplied illustration by hiding its outer whitespace; keep the asset unchanged.
  brandLogo: { width: 88, height: 60, position: 'absolute', left: -22, top: -10 },
  brandName: { ...typeScale.section, color: colors.ink, flexShrink: 1 },
  dateBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, marginLeft: 'auto' },
  dateText: { ...typeScale.caption, color: colors.muted, fontVariant: ['tabular-nums'], flexShrink: 1 },
  settingsButton: { ...workStyles.iconButton, minHeight: layout.touch, alignItems: 'center', justifyContent: 'center' },
  writingContainer: { flex: 1 }, hiddenScreen: { display: 'none' },
  scrollView: { flex: 1 }, scrollContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: layout.gutter, paddingVertical: 24 },
  recorderCard: { ...workStyles.panel, width: '100%', maxWidth: 480, alignSelf: 'center', padding: 20, gap: 8 },
  cardTopRow: workStyles.between,
  localBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  localBadgeText: workStyles.hint,
  timer: { color: colors.ink, fontSize: 56, lineHeight: 64, fontWeight: '500', textAlign: 'center', marginTop: 24,
    fontVariant: ['tabular-nums'] },
  statusLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 16 },
  recorderStatus: { ...workStyles.hint, textAlign: 'center' },
  recorderStatusRecording: { color: colors.rose },
  recordingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.rose },
  recordButton: { ...workStyles.button, minHeight: 48, flexDirection: 'row', gap: 8 },
  stopButton: { backgroundColor: colors.rose }, disabledButton: { backgroundColor: colors.disabled },
  pressedButton: workStyles.pressed,
  recordButtonText: { ...workStyles.buttonText, flexShrink: 1 },
  stopButtonText: { color: colors.white }, disabledButtonText: { color: colors.muted },
  importButton: { ...workStyles.button, ...workStyles.secondary, flexDirection: 'row', gap: 8 },
  importButtonText: { ...workStyles.buttonText, flexShrink: 1 },
  notice: { borderRadius: radius.control, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 16 },
  successNotice: { backgroundColor: colors.green }, errorNotice: { backgroundColor: colors.pink },
  noticeText: { ...typeScale.meta, color: colors.greenInk, flex: 1 },
  errorNoticeText: { color: colors.rose },
  subtlePressed: { opacity: 0.6 },
  tabNotice: { marginHorizontal: layout.gutter, marginBottom: 8, padding: 12, borderRadius: radius.control,
    backgroundColor: colors.yellowLight, flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  tabNoticeText: { ...typeScale.meta, color: colors.amberInk, flex: 1 },
  tabBar: { flexDirection: 'row', backgroundColor: colors.paper, paddingTop: 8, borderTopWidth: 1,
    borderTopColor: colors.line, paddingHorizontal: layout.gutter },
  tab: { flex: 1, alignItems: 'center', gap: 4, minHeight: 48, paddingHorizontal: 4 },
  tabIcon: { width: 48, minHeight: 28, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  selectedTabIcon: { backgroundColor: colors.yellowLight },
  tabLabel: { ...typeScale.caption, color: colors.muted, textAlign: 'center' },
  selectedTabLabel: { color: colors.ink, fontWeight: '600' },
});
