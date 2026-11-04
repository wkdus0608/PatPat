import { loadJournalDetail, loadJournalList } from './journals';
import type { SavedRecording } from '../recording/storage';
import type {
  DeleteTarget, JournalListItem, JournalSource, LibraryPlayer, LibraryState, PlayerFactory,
  PlayerState, RecordingLibrary,
} from './types';

const initialPlayer = (): PlayerState => ({ phase: 'idle', currentTime: 0, duration: null, message: null });
const playbackError = '녹음을 재생하지 못했어요. 파일을 확인하거나 다시 시도해 주세요.';

export function createLibraryController(
  recordings: RecordingLibrary,
  createPlayer: PlayerFactory,
  journalSource?: JournalSource,
  now: () => number = Date.now,
) {
  let state: LibraryState = {
    route: 'home', recordings: { status: 'idle' }, journals: { status: 'idle' },
    journalDetail: { status: 'idle' }, selectedRecording: null, selectedJournal: null,
    player: initialPlayer(), deletePrompt: false, deleting: false,
    navigationBusy: false, notice: null,
  };
  let player: LibraryPlayer | null = null;
  let generation = 0;
  let listVersion = 0;
  let journalVersion = 0;
  let loadedAt = 0;
  let controlBusy = false;
  let disposed = false;
  let suspended = false;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<LibraryState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const current = (version: number) => !disposed && version === generation;
  const busy = () => disposed || state.navigationBusy || state.deleting || state.syncing;

  async function closePlayer() {
    if (player) {
      const previous = player;
      await previous.release();
      if (player === previous) player = null;
    }
    await recordings.releasePlayback?.();
  }

  async function navigate(route: LibraryState['route'], patch: Partial<LibraryState> = {}) {
    if (busy() || state.deletePrompt) return false;
    const version = ++generation;
    update({ navigationBusy: true, notice: null });
    try {
      await closePlayer();
      if (!current(version) || suspended) { update({ navigationBusy: false }); return false; }
      update({ route, player: initialPlayer(), navigationBusy: false, ...patch });
      return true;
    } catch {
      update({ navigationBusy: false, notice: '재생을 중지하지 못했어요. 다시 이동해 주세요.' });
      return false;
    }
  }

  async function refreshRecordings() {
    const version = ++listVersion;
    if (!recordings.available) {
      update({ recordings: { status: 'unavailable', message: '녹음 파일은 이 기기의 모바일 앱에서 확인할 수 있어요.' } });
      return;
    }
    update({ recordings: { status: 'loading' } });
    try {
      const data = await recordings.list();
      if (!disposed && version === listVersion) update({ recordings: { status: 'ready', data } });
    } catch {
      if (!disposed && version === listVersion) {
        update({ recordings: { status: 'error', message: '녹음 목록을 불러오지 못했어요. 다시 시도해 주세요.' } });
      }
    }
  }

  async function showRecordings() {
    if (await navigate('recordings', { selectedRecording: null, selectedJournal: null })) await refreshRecordings();
  }

  async function showJournals() {
    if (!(await navigate('journals', { selectedRecording: null, selectedJournal: null }))) return;
    const version = ++journalVersion;
    update({ journals: { status: 'loading' } });
    const result = await loadJournalList(journalSource);
    if (!disposed && version === journalVersion) update({ journals: result });
  }

  async function loadRecording(recording: SavedRecording, version: number) {
    if (!current(version) || suspended) return;
    update({ player: { ...initialPlayer(), phase: 'loading' }, notice: null });
    try {
      await recordings.validate(recording);
      if (!current(version) || suspended) return;
      const uri = recordings.playbackUri ? await recordings.playbackUri(recording) : recording.uri;
      if (!current(version) || suspended) return;
      player = createPlayer(uri);
      loadedAt = now();
      poll();
    } catch {
      if (current(version)) update({ player: { ...initialPlayer(), phase: 'error', message: playbackError } });
    }
  }

  async function openRecording(recording: SavedRecording) {
    if (await navigate('recording', { selectedRecording: recording })) {
      await loadRecording(recording, generation);
    }
  }

  async function openJournal(journal: JournalListItem) {
    if (!(await navigate('journal', { selectedJournal: journal, journalDetail: { status: 'loading' } }))) return;
    const version = generation;
    const result = await loadJournalDetail(journalSource, journal);
    if (current(version)) update({ journalDetail: result });
  }

  function poll() {
    if (!player || state.route !== 'recording' || disposed || suspended
      || state.navigationBusy || state.deleting || state.player.phase === 'error') return;
    try {
      const status = player.getStatus();
      if (status.error || (!status.loaded && now() - loadedAt > 15000)) throw new Error('Playback unavailable');
      if (!status.loaded) return;
      const phase = status.playing ? 'playing' : status.finished ? 'finished'
        : state.player.phase === 'paused' ? 'paused' : 'ready';
      update({ player: { phase, currentTime: status.currentTime, duration: status.duration, message: null } });
    } catch {
      update({ player: { ...state.player, phase: 'error', message: playbackError } });
      void player.pause().catch(() => {});
    }
  }

  async function playbackAction(restart = false) {
    if (busy() || state.deletePrompt || controlBusy || !player || !state.selectedRecording
      || state.player.phase === 'loading' || state.player.phase === 'error') return;
    const active = player;
    const version = generation;
    controlBusy = true;
    try {
      if (!restart && state.player.phase === 'playing') {
        // Pausing must work even if the file was removed or the disk is unreadable.
        await active.pause();
        if (current(version)) update({ player: { ...state.player, phase: 'paused' } });
      } else {
        await recordings.validate(state.selectedRecording);
        if (!current(version) || active !== player) return;
        if (restart || state.player.phase === 'finished') await active.seekTo(0);
        if (!current(version) || active !== player) return;
        await active.play();
        if (current(version)) update({ player: { ...state.player, phase: 'playing' } });
      }
    } catch {
      if (current(version)) {
        try { await active.pause(); } catch { /* Retry/release controls remain available. */ }
        update({ player: { ...state.player, phase: 'error', message: playbackError } });
      }
    } finally { controlBusy = false; }
  }

  async function retryPlayback() {
    if (busy() || state.deletePrompt || !state.selectedRecording) return;
    const selected = state.selectedRecording;
    if (await navigate('recording', { selectedRecording: selected })) await loadRecording(selected, generation);
  }

  async function requestDelete() {
    if (busy() || controlBusy || state.deletePrompt || !state.selectedRecording) return;
    controlBusy = true;
    const version = generation;
    try {
      if (player) await player.pause();
      if (current(version)) update({ deletePrompt: true, notice: null, player: { ...state.player, phase: state.player.phase === 'playing' ? 'paused' : state.player.phase } });
    } catch {
      if (current(version)) update({ notice: '재생을 멈추지 못했어요. 다시 시도해 주세요.' });
    } finally { controlBusy = false; }
  }

  function cancelDelete() {
    if (state.deleting) return;
    update({ deletePrompt: false, notice: null });
    if (!player && state.selectedRecording) void retryPlayback();
  }

  async function confirmDelete(target?: DeleteTarget) {
    if (busy() || !state.deletePrompt || !state.selectedRecording) return;
    const selected = state.selectedRecording;
    ++generation;
    update({ deleting: true, notice: null });
    try {
      await closePlayer();
      await recordings.remove(selected, target);
      update({ route: 'recordings', selectedRecording: null, deleting: false, deletePrompt: false,
        player: initialPlayer(), notice: '녹음 파일을 삭제했어요.' });
      await refreshRecordings();
    } catch {
      update({ deleting: false, notice: '삭제 결과를 확인하지 못했어요. 목록을 확인하거나 다시 시도해 주세요.',
        player: { ...initialPlayer(), phase: 'error', message: '재생하려면 다시 불러와 주세요.' } });
    }
  }

  async function back() {
    if (state.deletePrompt) { cancelDelete(); return; }
    if (state.route === 'recording') await showRecordings();
    else if (state.route === 'journal') await showJournals();
    else if (state.route !== 'home') await navigate('home');
  }

  async function leave() {
    if (busy() || state.deletePrompt) return false;
    ++generation;
    update({ navigationBusy: true });
    try {
      await closePlayer();
      update({ navigationBusy: false });
      return true;
    } catch {
      update({ navigationBusy: false, notice: '재생을 중지하지 못했어요. 다시 이동해 주세요.' });
      return false;
    }
  }

  async function suspend() {
    suspended = true;
    ++generation;
    if (state.deleting) return;
    try {
      await closePlayer();
      update({ deletePrompt: false, player: initialPlayer() });
    } catch {
      update({ player: { ...state.player, phase: 'error', message: '재생을 중지하지 못했어요.' } });
    }
  }

  async function refresh() {
    if (busy() || state.deletePrompt) return;
    if (state.route === 'recordings') {
      if (recordings.synchronize) {
        update({ syncing: true, notice: '미전송 녹음을 서버에 저장하고 목록을 새로고침하고 있어요.' });
        try { update({ notice: await recordings.synchronize() }); }
        catch { update({ notice: '새로고침을 마치지 못했어요. 기기 녹음은 보존돼요.' }); }
        finally { update({ syncing: false }); }
      }
      await refreshRecordings();
    }
    else if (state.route === 'recording') await retryPlayback();
    else if (state.route === 'journals') await showJournals();
    else if (state.route === 'journal' && state.selectedJournal) await openJournal(state.selectedJournal);
  }

  async function resume() {
    suspended = false;
    if (state.route === 'recordings') await refreshRecordings();
    else if (!state.syncing) await refresh();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    showRecordings, showJournals, openRecording, openJournal, back, refresh,
    togglePlay: () => playbackAction(), restart: () => playbackAction(true),
    retryPlayback, requestDelete, cancelDelete, confirmDelete, poll, leave, suspend, resume,
    dispose() { disposed = true; ++generation; ++listVersion; ++journalVersion; listeners.clear(); void closePlayer().catch(() => {}); },
  };
}

export type LibraryController = ReturnType<typeof createLibraryController>;
