import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, errorMessage } from '../api/client';
import type { Account } from '../auth/controller';
import { playbackTime } from '../library/playbackTime';
import type { ServerRecording } from '../library/sync';
import type { LibraryPlayer, PlaybackStatus } from '../library/types';
import { compareRecordings } from '../recording/files';
import type { SavedRecording } from '../recording/storage';
import { WorkButton, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';
import { colors } from '../ui/theme';
import { listLocalAudio, openNoticeAudio, removeNoticeAudio } from './noticeAudio';
import { PlaybackTrack } from './PlaybackTrack';

type Row = SavedRecording & { duration?: number; draftId?: string };
type ListState = { day: string; rows: Row[]; loading: boolean; error: string | null };

const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

async function serverAudio(account: Account, day: string): Promise<ServerRecording[]> {
  const rows = new Map<string, ServerRecording>();
  let offset = 0;
  do {
    const page = await account.api.listRecordings(account.session.token, offset, day);
    for (const row of page.items) rows.set(row.recording_id, row);
    if (!page.items.length || offset + page.items.length >= page.total) break;
    offset += page.items.length;
  } while (true);
  return Array.from(rows.values());
}

export function useNoticeRecordings(account: Account, day: string, active: boolean) {
  const [list, setList] = useState<ListState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { api, session, unauthorized } = account;
  useEffect(() => {
    if (!active) return;
    let current = true;
    setList(value => ({ day, rows: value?.day === day ? value.rows : [], loading: true, error: null }));
    void Promise.allSettled([serverAudio(account, day), listLocalAudio(account, day)]).then(([remote, device]) => {
      if (!current) return;
      const local = device.status === 'fulfilled' ? device.value : [];
      const byId = new Map(local.filter(item => item.serverId).map(item => [item.serverId, item]));
      const uploaded = remote.status === 'fulfilled' ? remote.value.map(row => ({
        uri: 'patpat-server:' + row.recording_id, fileName: row.title, dateKey: day,
        startTime: clock.format(new Date(row.recorded_at)), serverId: row.recording_id,
        location: 'server' as const, syncLabel: '서버에 저장됨', ...byId.get(row.recording_id),
        duration: row.duration_seconds, draftId: row.recording_id,
      })) : [];
      const ids = new Set(uploaded.map(item => item.serverId));
      const pending = local.filter(item => !item.serverId || !ids.has(item.serverId)).map(item => ({
        ...item, syncLabel: item.serverId ? '서버 저장 확인 필요' : item.syncLabel,
      }));
      if (remote.status === 'rejected') unauthorized(remote.reason);
      setList({ day, rows: [...uploaded, ...pending].sort(compareRecordings), loading: false,
        error: remote.status === 'rejected' ? errorMessage(remote.reason) : null });
    });
    return () => { current = false; };
  }, [active, api, session.token, unauthorized, day, attempt]);
  const current = list?.day === day ? list : { day, rows: [], loading: true, error: null };
  return {
    ...current,
    reload: () => setAttempt(value => value + 1),
    removeRows: (uris: ReadonlySet<string>) => setList(value => value?.day === day
      ? { ...value, rows: value.rows.filter(row => !uris.has(row.uri)) } : value),
  };
}

export function NoticeRecordingList({ list, account, active, selected, used, busy, deleteBlocked, onSelect, preview = false, children }: {
  list: ReturnType<typeof useNoticeRecordings>; account: Account; active: boolean; selected: ReadonlySet<string>; used: Set<string>;
  busy: boolean; deleteBlocked: boolean; onSelect(uris: string[], checked: boolean): void; preview?: boolean; children?: ReactNode;
}) {
  const playback = useRef<{ abort: AbortController; player?: LibraryPlayer } | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [playing, setPlaying] = useState<string | null>(null);
  const [playStatus, setPlayStatus] = useState<PlaybackStatus | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [deletePrompt, setDeletePrompt] = useState<Row[] | null>(null);
  const [deleteResult, setDeleteResult] = useState<{ text: string; error: boolean } | null>(null);
  const deletion = useWorkAction();
  const chosen = list.rows.filter(row => selected.has(row.uri));
  const rows = preview ? chosen : list.rows;
  const allSelected = chosen.length > 0 && chosen.length === list.rows.length;
  const locked = busy || list.loading || deletion.busy;

  async function release() {
    const current = playback.current;
    playback.current = null;
    current?.abort.abort();
    await current?.player?.release();
  }

  function stop() {
    setPlaying(null);
    setPlayStatus(null);
    return release();
  }

  useEffect(() => {
    if (!active) void stop().catch(() => {});
    return () => { void release().catch(() => {}); };
  }, [active]);

  useEffect(() => {
    if (playing === null) return;
    const timer = setInterval(() => {
      const status = playback.current?.player?.getStatus();
      if (status?.error) setPlayError(status.error);
      if (status?.error || status?.finished) void stop().catch(() => {});
      else if (status) setPlayStatus(status);
    }, 250);
    return () => clearInterval(timer);
  }, [playing]);

  async function play(row: Row) {
    void stop().catch(() => {});
    if (row.uri === playing) return;
    const request: { abort: AbortController; player?: LibraryPlayer } = { abort: new AbortController() };
    playback.current = request;
    setPlaying(row.uri);
    setPlayError(null);
    try {
      const player = await openNoticeAudio(account, row, request.abort.signal);
      if (playback.current !== request) { await player.release(); return; }
      request.player = player;
      await player.play();
    } catch (failure) {
      if (playback.current !== request) return;
      account.unauthorized(failure);
      void stop().catch(() => {});
      setPlayError('녹음을 재생하지 못했어요. 다시 시도해 주세요.');
    }
  }

  async function seek(seconds: number) {
    const request = playback.current;
    const player = request?.player;
    if (!player) return;
    try {
      await player.seekTo(seconds);
      if (playback.current === request) setPlayStatus(player.getStatus());
    } catch {
      if (playback.current === request) setPlayError('재생 위치를 바꾸지 못했어요. 다시 시도해 주세요.');
    }
  }

  function confirmDelete() {
    if (!deletePrompt || locked || deleteBlocked) return;
    const requested = deletePrompt;
    void deletion.run(async () => {
      if (requested.some(row => row.uri === playing)) await stop();
      const removed = new Set<string>();
      for (const row of requested) {
        try {
          await removeNoticeAudio(account, row);
          removed.add(row.uri);
        } catch (error) {
          account.unauthorized(error);
          if (error instanceof ApiError && (error.status === 0 || error.status === 401)) break;
        }
      }
      list.removeRows(removed);
      onSelect([...removed], false);
      setDeletePrompt(null);
      const failed = requested.length - removed.size;
      setDeleteResult({
        text: failed ? `${removed.size}개를 삭제했고 ${failed}개는 삭제하지 못했어요. 다시 시도해 주세요.`
          : `녹음 ${removed.size}개를 삭제했어요.`,
        error: failed > 0,
      });
    });
  }

  const header = preview ? <Text style={workStyles.title}>선택한 녹음 목록</Text> : <View style={workStyles.between}>
    <Pressable accessibilityRole="button" accessibilityLabel="녹음 목록"
      accessibilityState={{ expanded, disabled: deletion.busy }} aria-expanded={expanded}
      disabled={deletion.busy} style={styles.listToggle} onPress={() => {
        if (expanded) void stop().catch(() => {});
        setExpanded(!expanded);
      }}>
      <Text style={workStyles.title}>녹음 목록</Text>
      {!expanded && chosen.length > 0 && <WorkMessage>{chosen.length}개 선택</WorkMessage>}
      <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.muted} accessible={false} />
    </Pressable>
    {expanded && <WorkButton label="녹음 새로고침" icon="refresh-outline" secondary disabled={locked} onPress={list.reload} />}
  </View>;
  if (!expanded && !preview) return <View style={workStyles.panel}>{header}</View>;

  return <View style={workStyles.panel}>
    {header}
    {!preview && rows.length > 0 && <View style={workStyles.between}>
      <View style={workStyles.row}>
        <WorkButton label={allSelected ? '전체 해제' : '전체 선택'} secondary disabled={locked}
          onPress={() => onSelect(list.rows.map(row => row.uri), !allSelected)} />
        {chosen.length > 0 && <WorkMessage>{chosen.length}개 선택</WorkMessage>}
      </View>
      <WorkButton label="삭제" icon="trash-outline" secondary disabled={locked || deleteBlocked || !chosen.length}
        onPress={() => { deletion.setError(null); setDeleteResult(null); setDeletePrompt(chosen); }} />
    </View>}
    {!preview && list.error && <WorkMessage error>{list.error}</WorkMessage>}
    {playError && <WorkMessage error>{playError}</WorkMessage>}
    {deleteResult && <WorkMessage error={deleteResult.error}>{deleteResult.text}</WorkMessage>}
    {!preview && list.loading && <WorkMessage>녹음을 불러오고 있어요.</WorkMessage>}
    {!preview && !list.loading && !list.error && !rows.length && <WorkMessage>이 날짜에 녹음한 파일이 없어요.</WorkMessage>}
    {preview && rows.some(row => !row.draftId) && <WorkMessage>서버에 저장된 녹음만 초안에 사용돼요.</WorkMessage>}
    {rows.map(row => {
      const status = row.uri === playing ? playStatus : null;
      const duration = status?.duration ?? row.duration ?? 0;
      const position = Math.max(0, Math.min(status?.currentTime ?? 0, duration));
      const checked = selected.has(row.uri);
      const info = <View style={styles.recordingInfo}>
        <Text style={workStyles.label}>{row.startTime} · {row.fileName}</Text>
        <WorkMessage>{[row.syncLabel, row.serverId && used.has(row.serverId) ? '사용한 녹음' : null]
          .filter(Boolean).join(' · ')}</WorkMessage>
      </View>;
      return <View key={row.uri} style={styles.recordingRow}>
        {preview ? info : <Pressable style={styles.recordingHeading} accessibilityRole="checkbox" accessibilityLabel={row.fileName + ' 선택'}
          aria-checked={checked} accessibilityState={{ checked, disabled: locked }} disabled={locked}
          onPress={() => onSelect([row.uri], !checked)}>
          <Ionicons accessible={false} name={checked ? 'checkbox' : 'square-outline'} size={23}
            color={checked ? colors.greenInk : colors.muted} />
          {info}
        </Pressable>}
        <View style={workStyles.row}>
          <WorkButton label={row.uri === playing ? '정지' : '재생'} icon={row.uri === playing ? 'stop' : 'play'}
            secondary onPress={() => { void play(row); }} />
          <View style={styles.playbackProgress}>
            <PlaybackTrack label={row.fileName + ' 재생 위치'} duration={duration} position={position}
              disabled={!status?.loaded || duration === 0} onSeek={seconds => { void seek(seconds); }} />
            <View style={styles.timeRow}>
              <Text style={styles.time}>{playbackTime(position)}</Text>
              <Text style={styles.time}>{duration > 0 ? playbackTime(duration) : '–:–'}</Text>
            </View>
          </View>
        </View>
      </View>;
    })}
    {children}
    {deletePrompt && <Modal transparent animationType="fade"
      onRequestClose={() => { if (!deletion.busy) setDeletePrompt(null); }}>
      <View style={styles.backdrop}>
        <View accessibilityViewIsModal style={[workStyles.panel, styles.dialog]}>
          <Text accessibilityRole="header" style={workStyles.title}>녹음 {deletePrompt.length}개를 삭제할까요?</Text>
          <WorkMessage>삭제한 녹음은 복구할 수 없어요.</WorkMessage>
          {deletion.error && <WorkMessage error>{deletion.error}</WorkMessage>}
          <View style={styles.dialogActions}>
            <WorkButton label="취소" secondary disabled={deletion.busy} onPress={() => setDeletePrompt(null)} />
            <WorkButton label="녹음 삭제" busy={deletion.busy} disabled={busy || deleteBlocked} onPress={confirmDelete} />
          </View>
        </View>
      </View>
    </Modal>}
  </View>;
}

const styles = StyleSheet.create({
  listToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  recordingRow: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, gap: 6 },
  recordingHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 40 },
  recordingInfo: { flex: 1, gap: 3 },
  playbackProgress: { flex: 1, minWidth: 90 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { color: colors.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  backdrop: { flex: 1, backgroundColor: '#49372C66', justifyContent: 'center', alignItems: 'center', padding: 22 },
  dialog: { width: '100%', maxWidth: 410, padding: 20 },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
