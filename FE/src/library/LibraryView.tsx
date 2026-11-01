import { Ionicons } from '@expo/vector-icons';
import { useMemo, useRef, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';

import type { SavedRecording } from '../recording/storage';
import { colors } from '../ui/theme';
import type { JournalListItem, LibraryViewProps } from './types';

type IconName = ComponentProps<typeof Ionicons>['name'];
type RecordingSection = { title: string; data: SavedRecording[] };
const emptyRecordings: readonly SavedRecording[] = [];

function dateText(dateKey: string) {
  const parts = dateKey.split('-');
  return parts.length === 3
    ? parts[0] + '년 ' + Number(parts[1]) + '월 ' + Number(parts[2]) + '일'
    : dateKey;
}

function timeText(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = String(Math.floor(safeSeconds / 60) % 60).padStart(2, '0');
  const remaining = String(safeSeconds % 60).padStart(2, '0');
  return hours > 0
    ? [String(hours).padStart(2, '0'), minutes, remaining].join(':')
    : [minutes, remaining].join(':');
}

function journalTitle(journal: JournalListItem) {
  return journal.title || (journal.childLabel || journal.childId) + ' 관찰일지';
}

function Button({
  label, onPress, icon, disabled = false, secondary = false, danger = false, busy = false, testID,
}: {
  label: string;
  onPress(): void;
  icon?: IconName;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const ink = danger && !disabled ? colors.white : disabled ? colors.muted : colors.ink;
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled, busy }} disabled={disabled} onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button, secondary && styles.secondaryButton, danger && styles.dangerButton,
        disabled && styles.disabledButton, pressed && !disabled && styles.pressed,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={ink} />
        : icon ? <Ionicons name={icon} size={19} color={ink} /> : null}
      <Text style={[styles.buttonText, { color: ink }]}>{label}</Text>
    </Pressable>
  );
}

function Header({
  title, subtitle, onBack, onRefresh, busy = false,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  onRefresh?: () => void;
  busy?: boolean;
}) {
  return (
    <View style={styles.header}>
      {(onBack || onRefresh) && (
        <View style={styles.navigationRow}>
          {onBack ? (
            <Pressable accessibilityRole="button" accessibilityLabel="이전 화면으로 돌아가기"
              accessibilityState={{ disabled: busy }} disabled={busy} onPress={onBack}
              style={({ pressed }) => [styles.backButton, busy && styles.disabledOpacity, pressed && styles.pressed]}
              testID="library-back"
            >
              <Ionicons name="chevron-back" size={19} color={colors.ink} />
              <Text style={styles.backLabel}>뒤로</Text>
            </Pressable>
          ) : <View />}
          {onRefresh && (
            <Pressable accessibilityRole="button" accessibilityLabel="목록 새로고침"
              accessibilityState={{ disabled: busy }} disabled={busy} onPress={onRefresh}
              style={({ pressed }) => [styles.iconButton, busy && styles.disabledOpacity, pressed && styles.pressed]}
              testID="library-refresh"
            >
              <Ionicons name="refresh-outline" size={19} color={colors.muted} />
            </Pressable>
          )}
        </View>
      )}
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
}

function Notice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice} testID="library-notice">
      <Ionicons name="information-circle-outline" size={20} color={colors.ink} />
      <Text style={styles.noticeText}>{message}</Text>
    </View>
  );
}

function StatePanel({
  icon, title, message, loading = false, action,
}: {
  icon: IconName;
  title: string;
  message: string;
  loading?: boolean;
  action?: { label: string; onPress(): void; disabled?: boolean };
}) {
  return (
    <View style={styles.stateCard}>
      <View style={styles.stateIcon}>
        {loading ? <ActivityIndicator size="large" color={colors.ink} />
          : <Ionicons name={icon} size={36} color={colors.ink} />}
      </View>
      <Text accessibilityRole="header" style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateMessage}>{message}</Text>
      {action && (
        <View style={styles.stateAction}>
          <Button label={action.label} onPress={action.onPress} disabled={action.disabled} testID="library-state-action" />
        </View>
      )}
    </View>
  );
}

function HomeCard({
  title, description, icon, tint, onPress, disabled, testID,
}: {
  title: string;
  description: string;
  icon: IconName;
  tint: string;
  onPress(): void;
  disabled: boolean;
  testID: string;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title + ' 보기'}
      accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} testID={testID}
      style={({ pressed }) => [styles.homeCard, disabled && styles.disabledOpacity, pressed && styles.pressed]}
    >
      <View style={[styles.homeIcon, { backgroundColor: tint }]}><Ionicons name={icon} size={29} color={colors.ink} /></View>
      <View style={styles.cardContent}>
        <Text style={styles.homeCardTitle}>{title}</Text>
        <Text style={styles.cardDescription}>{description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.muted} />
    </Pressable>
  );
}

function JournalRow({ item, onPress, disabled }: {
  item: JournalListItem;
  onPress(): void;
  disabled: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={journalTitle(item) + ' 열기'}
      accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.listCard, disabled && styles.disabledOpacity, pressed && styles.pressed]}
      testID={'library-journal-' + item.recordId}
    >
      <View style={[styles.listIcon, { backgroundColor: colors.green }]}>
        <Ionicons name="document-text-outline" size={23} color={colors.greenInk} />
      </View>
      <View style={styles.cardContent}>
        <View style={styles.journalLabelRow}>
          <Text style={styles.itemTitle}>{journalTitle(item)}</Text>
          <View style={styles.completeBadge}><Text style={styles.completeBadgeText}>완료</Text></View>
        </View>
        <Text style={styles.itemSubtitle}>{item.childLabel || item.childId}</Text>
        {(item.periodLabel || item.dateLabel) && (
          <Text style={styles.itemSubtitle}>{item.periodLabel || item.dateLabel}</Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
}

export function LibraryView({ state, actions, onGoToRecording }: LibraryViewProps) {
  const locked = state.navigationBusy || state.deleting;
  const recordings = state.recordings.status === 'ready' ? state.recordings.data : emptyRecordings;
  const recordingsOffset = useRef(0);
  const recordingsList = useRef<SectionList<SavedRecording, RecordingSection>>(null);
  const restorePending = useRef(true);
  const lastRoute = useRef(state.route);
  if (lastRoute.current !== state.route) {
    if (state.route === 'recordings') restorePending.current = true;
    lastRoute.current = state.route;
  }
  const sections = useMemo(() => {
    const groups = new Map<string, SavedRecording[]>();
    for (const recording of recordings) {
      const group = groups.get(recording.dateKey) || [];
      group.push(recording);
      groups.set(recording.dateKey, group);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([title, data]) => ({
        title, data: [...data].sort((left, right) => right.fileName.localeCompare(left.fileName)),
      }));
  }, [recordings]);

  function restoreScroll() {
    if (!restorePending.current || recordings.length === 0) return;
    requestAnimationFrame(() => {
      recordingsList.current?.getScrollResponder()?.scrollTo({
        x: 0, y: recordingsOffset.current, animated: false,
      });
      restorePending.current = false;
    });
  }

  const notice = state.deletePrompt ? null : <Notice message={state.notice} />;

  function recordingListPanel() {
    const load = state.recordings;
    if (load.status === 'idle' || load.status === 'loading') {
      return <StatePanel icon="mic-outline" title="녹음을 불러오고 있어요" message="이 기기에 저장된 녹음을 확인하고 있어요." loading />;
    }
    if (load.status === 'unavailable') {
      return <StatePanel icon="phone-portrait-outline" title="녹음한 기기에서 확인해 주세요" message={load.message} />;
    }
    if (load.status === 'error') {
      return <StatePanel icon="alert-circle-outline" title="녹음을 불러오지 못했어요" message={load.message}
        action={{ label: '다시 불러오기', onPress: actions.refresh, disabled: locked }} />;
    }
    return <StatePanel icon="mic-outline" title="아직 저장된 녹음이 없어요"
      message="기억해 둘 관찰을 녹음하면 날짜별로 모아 볼 수 있어요."
      action={{ label: '녹음하러 가기', onPress: onGoToRecording, disabled: locked }} />;
  }

  function journalListPanel() {
    const load = state.journals;
    if (load.status === 'idle' || load.status === 'loading') {
      return <StatePanel icon="document-text-outline" title="관찰일지를 불러오고 있어요" message="작성된 기록을 확인하고 있어요." loading />;
    }
    if (load.status === 'unavailable') {
      return <StatePanel icon="link-outline" title="관찰일지 연결을 준비 중이에요" message={load.message} />;
    }
    if (load.status === 'error') {
      return <StatePanel icon="alert-circle-outline" title="관찰일지를 불러오지 못했어요" message={load.message}
        action={{ label: '다시 불러오기', onPress: actions.refresh, disabled: locked }} />;
    }
    return <StatePanel icon="document-text-outline" title="아직 저장된 관찰일지가 없어요"
      message="검토를 마치고 확정한 관찰일지가 여기에 모여요." />;
  }

  if (state.route === 'home') {
    return (
      <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
        <Header title="보관함" subtitle="남겨 둔 순간과 기록을 다시 살펴보세요." />
        {notice}
        <HomeCard title="녹음 파일" description="날짜별로 모아 둔 목소리를 다시 들어요."
          icon="mic-outline" tint={colors.yellowLight} onPress={actions.showRecordings}
          disabled={locked} testID="library-home-recordings" />
        <HomeCard title="작성한 관찰일지" description="선생님이 검토하고 확정한 기록을 읽어요."
          icon="document-text-outline" tint={colors.green} onPress={actions.showJournals}
          disabled={locked} testID="library-home-journals" />
      </ScrollView>
    );
  }

  if (state.route === 'recordings') {
    return (
      <SectionList
        ref={recordingsList}
        style={styles.fill} contentContainerStyle={styles.content}
        sections={sections} keyExtractor={(item) => item.uri}
        ListHeaderComponent={<>
          <Header title="녹음 파일" subtitle="날짜별로 모아 둔 관찰을 다시 들어요."
            onBack={actions.back} onRefresh={actions.refresh} busy={locked} />
          {notice}
        </>}
        ListEmptyComponent={recordingListPanel()}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>{dateText(section.title)}</Text>
            <Text style={styles.sectionCount}>{section.data.length}개</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button"
            accessibilityLabel={dateText(item.dateKey) + ' ' + item.startTime + ' 녹음 열기'}
            accessibilityState={{ disabled: locked }} disabled={locked} onPress={() => actions.openRecording(item)}
            style={({ pressed }) => [styles.listCard, locked && styles.disabledOpacity, pressed && styles.pressed]}
            testID={'library-recording-' + item.fileName}
          >
            <View style={[styles.listIcon, { backgroundColor: colors.yellowLight }]}>
              <Ionicons name="mic-outline" size={23} color={colors.ink} />
            </View>
            <View style={styles.cardContent}>
              <Text style={styles.itemTitle}>{item.startTime} 녹음</Text>
              <Text style={styles.itemFileName}>{item.fileName}</Text>
            </View>
            <Ionicons name="play-circle-outline" size={25} color={colors.muted} />
          </Pressable>
        )}
        stickySectionHeadersEnabled={false}
        initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7}
        onScroll={(event) => { if (!restorePending.current) recordingsOffset.current = event.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={32}
        onLayout={restoreScroll} onContentSizeChange={restoreScroll}
        testID="library-recordings-list"
      />
    );
  }

  if (state.route === 'journals') {
    const data = state.journals.status === 'ready' ? state.journals.data : [];
    return (
      <FlatList
        style={styles.fill} contentContainerStyle={styles.content}
        data={data} keyExtractor={(item) => item.recordId}
        ListHeaderComponent={<>
          <Header title="작성한 관찰일지" subtitle="검토를 마친 기록을 있는 그대로 확인해요."
            onBack={actions.back} onRefresh={actions.refresh} busy={locked} />
          {notice}
        </>}
        ListEmptyComponent={journalListPanel()}
        renderItem={({ item }) => <JournalRow item={item} onPress={() => actions.openJournal(item)} disabled={locked} />}
        initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7}
        testID="library-journals-list"
      />
    );
  }

  if (state.route === 'journal') {
    const detail = state.journalDetail;
    let body;
    if (detail.status === 'ready') {
      const journal = detail.data;
      body = (
        <View style={styles.journalCard}>
          <View style={styles.journalLabelRow}>
            <Text style={styles.overline}>관찰일지</Text>
            <View style={styles.completeBadge}><Text style={styles.completeBadgeText}>완료</Text></View>
          </View>
          <Text accessibilityRole="header" style={styles.detailTitle}>{journalTitle(journal)}</Text>
          <View style={styles.metadata}>
            <Text style={styles.metadataText}>{journal.childLabel || journal.childId}</Text>
            {journal.periodLabel && <Text style={styles.metadataText}>{journal.periodLabel}</Text>}
            {journal.dateLabel && <Text style={styles.metadataText}>{journal.dateLabel}</Text>}
          </View>
          <View style={styles.divider} />
          <Text selectable style={styles.finalText} testID="library-journal-text">{journal.finalText}</Text>
        </View>
      );
    } else if (detail.status === 'idle' || detail.status === 'loading') {
      body = <StatePanel icon="document-text-outline" title="관찰일지를 불러오고 있어요" message="확정된 기록 내용을 확인하고 있어요." loading />;
    } else if (detail.status === 'error' || detail.status === 'unavailable') {
      body = <StatePanel icon={detail.status === 'unavailable' ? 'link-outline' : 'alert-circle-outline'}
        title={detail.status === 'unavailable' ? '관찰일지 연결을 준비 중이에요' : '관찰일지를 불러오지 못했어요'}
        message={detail.message}
        action={detail.status === 'error' ? { label: '다시 불러오기', onPress: actions.refresh, disabled: locked } : undefined} />;
    }
    return (
      <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
        <Header title="관찰일지 보기" onBack={actions.back} busy={locked} />
        {notice}{body}
      </ScrollView>
    );
  }

  const recording = state.selectedRecording;
  const player = state.player;
  const loading = player.phase === 'idle' || player.phase === 'loading';
  const playbackDisabled = locked || loading || player.phase === 'error' || !recording;
  const progress = player.duration !== null && player.duration > 0
    ? Math.min(1, Math.max(0, player.currentTime / player.duration)) : 0;
  const playLabel = player.phase === 'playing' ? '일시정지' : player.phase === 'finished' ? '다시 재생' : '재생';
  return (
    <View style={styles.fill}>
      <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
        <Header title="녹음 듣기" onBack={actions.back} busy={locked} />
        {notice}
        {recording ? <>
          <View style={styles.playerCard}>
            <View style={styles.playerIllustration}><Ionicons name="musical-notes-outline" size={45} color={colors.ink} /></View>
            <Text style={styles.recordingDate}>{dateText(recording.dateKey)}</Text>
            <Text accessibilityRole="header" style={styles.detailTitle}>{recording.startTime} 녹음</Text>
            <Text selectable style={styles.detailFileName}>{recording.fileName}</Text>
            <View
              accessibilityRole="progressbar" accessibilityLabel="녹음 재생 진행"
              accessibilityValue={player.duration === null ? { text: '전체 길이 확인 중' }
                : { min: 0, max: player.duration, now: Math.min(player.currentTime, player.duration), text: timeText(player.currentTime) + ' / ' + timeText(player.duration) }}
              style={styles.progressTrack}
            >
              <View style={[styles.progressFill, { width: (String(progress * 100) + '%') as DimensionValue }]} />
            </View>
            <View style={styles.timeRow}>
              <Text style={styles.timeText} testID="library-current-time">{timeText(player.currentTime)}</Text>
              <Text style={styles.timeText} testID="library-duration">
                {player.duration === null ? '길이 확인 중' : timeText(player.duration)}
              </Text>
            </View>
            {player.message && <Text accessibilityRole="alert" style={styles.playerMessage}>{player.message}</Text>}
            {loading && <Text style={styles.playerHelp}>녹음을 준비하고 있어요.</Text>}
            <View style={styles.playbackActions}>
              <Button label="처음부터" icon="play-skip-back" secondary disabled={playbackDisabled}
                onPress={actions.restart} testID="library-restart" />
              <Button label={loading ? '불러오는 중…' : playLabel} busy={loading}
                icon={player.phase === 'playing' ? 'pause' : 'play'} disabled={playbackDisabled}
                onPress={actions.togglePlay} testID="library-play" />
            </View>
            {player.phase === 'error' && <Button label="재생 다시 시도" icon="refresh-outline"
              disabled={locked} onPress={actions.retryPlayback} testID="library-play-retry" />}
          </View>
          <View style={styles.deleteSection}>
            <Button label="녹음 삭제" icon="trash-outline" secondary disabled={locked}
              onPress={actions.requestDelete} testID="library-delete" />
          </View>
        </> : <StatePanel icon="alert-circle-outline" title="녹음을 확인할 수 없어요" message="목록으로 돌아가 녹음을 다시 선택해 주세요." />}
      </ScrollView>

      <Modal visible={state.deletePrompt} transparent animationType="fade"
        onRequestClose={() => { if (!locked) actions.cancelDelete(); }}
      >
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={styles.modalCard}>
            <View style={styles.deleteIcon}><Ionicons name="trash-outline" size={27} color={colors.rose} /></View>
            <Text accessibilityRole="header" style={styles.modalTitle}>녹음을 삭제할까요?</Text>
            <Text selectable style={styles.modalFileName}>{recording?.fileName}</Text>
            <Text style={styles.modalDescription}>삭제한 녹음은 복구할 수 없어요.{'\n'}파일을 확인한 뒤 삭제해 주세요.</Text>
            <Notice message={state.notice} />
            <View style={styles.modalActions}>
              <Button label="취소" secondary disabled={locked} onPress={actions.cancelDelete} testID="library-delete-cancel" />
              <Button label={state.deleting ? '삭제 중…' : '삭제'} danger busy={state.deleting}
                disabled={locked} onPress={actions.confirmDelete} testID="library-delete-confirm" />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 5, paddingBottom: 30, flexGrow: 1 },
  header: { marginBottom: 24 },
  navigationRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 44, paddingRight: 12 },
  backLabel: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  title: { color: colors.ink, fontSize: 27, fontWeight: '800', letterSpacing: -1, lineHeight: 37 },
  subtitle: { color: colors.muted, fontSize: 13, lineHeight: 22, marginTop: 8 },
  homeCard: { flexDirection: 'row', alignItems: 'center', gap: 14, borderWidth: 1, borderColor: colors.line, borderRadius: 25, backgroundColor: colors.white, padding: 20, marginBottom: 15 },
  homeIcon: { width: 58, height: 62, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cardContent: { flex: 1, gap: 5 },
  homeCardTitle: { color: colors.ink, fontSize: 17, fontWeight: '700', lineHeight: 25, letterSpacing: -0.45 },
  cardDescription: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 14, borderRadius: 16, backgroundColor: colors.yellowLight, marginBottom: 16 },
  noticeText: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 20 },
  stateCard: { backgroundColor: colors.white, paddingHorizontal: 24, paddingVertical: 34, borderRadius: 26, borderWidth: 1, borderColor: colors.line, alignItems: 'center', marginBottom: 14 },
  stateIcon: { width: 84, height: 84, borderRadius: 30, backgroundColor: colors.yellowLight, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  stateTitle: { fontSize: 18, color: colors.ink, fontWeight: '700', textAlign: 'center', lineHeight: 28, letterSpacing: -0.5 },
  stateMessage: { color: colors.muted, fontSize: 13, textAlign: 'center', lineHeight: 22, marginTop: 10 },
  stateAction: { alignSelf: 'stretch', marginTop: 23 },
  button: { backgroundColor: colors.yellow, borderRadius: 16, minHeight: 50, paddingHorizontal: 17, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, flexShrink: 1 },
  secondaryButton: { backgroundColor: '#F6F3ED' },
  dangerButton: { backgroundColor: colors.rose },
  disabledButton: { backgroundColor: colors.disabled },
  buttonText: { fontWeight: '700', fontSize: 13, lineHeight: 20, flexShrink: 1 },
  pressed: { opacity: 0.68 },
  disabledOpacity: { opacity: 0.5 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, backgroundColor: colors.background },
  sectionTitle: { fontSize: 13, fontWeight: '700', lineHeight: 22, color: colors.ink },
  sectionCount: { fontSize: 11, color: colors.muted },
  listCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.white, borderRadius: 20, borderWidth: 1, borderColor: colors.line, padding: 15, marginBottom: 10 },
  listIcon: { width: 43, height: 47, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  itemTitle: { color: colors.ink, fontSize: 14, fontWeight: '700', lineHeight: 22, flexShrink: 1 },
  itemFileName: { color: colors.muted, fontSize: 11, lineHeight: 18 },
  itemSubtitle: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  journalLabelRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7 },
  completeBadge: { backgroundColor: colors.green, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  completeBadgeText: { color: colors.greenInk, fontSize: 10, fontWeight: '700' },
  journalCard: { backgroundColor: colors.white, borderRadius: 25, borderWidth: 1, borderColor: colors.line, padding: 23 },
  overline: { color: colors.greenInk, fontSize: 12, fontWeight: '600' },
  detailTitle: { color: colors.ink, fontSize: 22, fontWeight: '700', lineHeight: 33, marginTop: 9, letterSpacing: -0.5 },
  metadata: { gap: 4, marginTop: 12 },
  metadataText: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 21 },
  finalText: { color: colors.ink, fontSize: 15, lineHeight: 28 },
  playerCard: { alignItems: 'center', backgroundColor: colors.white, borderRadius: 27, padding: 23, borderWidth: 1, borderColor: colors.line },
  playerIllustration: { width: 100, height: 100, borderRadius: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.yellowLight, marginTop: 3, marginBottom: 23 },
  recordingDate: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  detailFileName: { color: colors.muted, fontSize: 12, lineHeight: 21, textAlign: 'center', marginTop: 7, marginBottom: 27 },
  progressTrack: { alignSelf: 'stretch', height: 7, borderRadius: 4, backgroundColor: '#F0EAE0', overflow: 'hidden' },
  progressFill: { height: 7, borderRadius: 4, backgroundColor: '#DDB855' },
  timeRow: { alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginTop: 9, marginBottom: 22 },
  timeText: { color: colors.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  playbackActions: { alignSelf: 'stretch', flexDirection: 'row', gap: 10, justifyContent: 'center', marginBottom: 10 },
  playerMessage: { color: colors.rose, fontSize: 12, lineHeight: 21, textAlign: 'center', marginBottom: 15 },
  playerHelp: { color: colors.muted, fontSize: 12, lineHeight: 20, marginBottom: 15 },
  deleteSection: { alignItems: 'center', marginTop: 21 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(49, 37, 28, 0.42)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 420, backgroundColor: colors.background, borderRadius: 28, padding: 25 },
  deleteIcon: { alignSelf: 'center', width: 65, height: 65, borderRadius: 23, backgroundColor: colors.pink, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  modalTitle: { color: colors.ink, fontSize: 21, fontWeight: '700', lineHeight: 31, textAlign: 'center' },
  modalFileName: { color: colors.ink, fontSize: 12, lineHeight: 20, textAlign: 'center', marginTop: 12 },
  modalDescription: { color: colors.muted, fontSize: 13, lineHeight: 23, textAlign: 'center', marginTop: 11, marginBottom: 23 },
  modalActions: { flexDirection: 'row', gap: 10, justifyContent: 'center' },
});
