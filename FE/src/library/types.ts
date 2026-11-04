import type { SavedRecording } from '../recording/storage';

export type LoadState<T> =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error' | 'unavailable'; message: string };

/** FE display input, not a new server response or persistence schema. */
export interface JournalListItem {
  recordId: string;
  childId: string;
  recordType: '관찰일지';
  status: '완료';
  title?: string;
  childLabel?: string;
  dateLabel?: string;
  periodLabel?: string;
}

export interface JournalDetail extends JournalListItem {
  finalText: string;
}

/** A future adapter maps its agreed contract to these FE display inputs. */
export interface JournalSource {
  list(): Promise<unknown>;
  get(recordId: string): Promise<unknown>;
}

export type DeleteTarget = 'device' | 'server' | 'both';

export interface RecordingLibrary {
  available: boolean;
  list(): Promise<SavedRecording[]>;
  validate(recording: SavedRecording): Promise<void>;
  remove(recording: SavedRecording, target?: DeleteTarget): Promise<void>;
  synchronize?(): Promise<string>;
  playbackUri?(recording: SavedRecording): Promise<string>;
  releasePlayback?(): Promise<void>;
}

export interface PlaybackStatus {
  loaded: boolean;
  playing: boolean;
  currentTime: number;
  duration: number | null;
  finished: boolean;
  error?: string;
}

export interface LibraryPlayer {
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(seconds: number): Promise<void>;
  release(): Promise<void>;
  getStatus(): PlaybackStatus;
}

export type PlayerFactory = (uri: string) => LibraryPlayer;

export interface PlayerState {
  phase: 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'finished' | 'error';
  currentTime: number;
  duration: number | null;
  message: string | null;
}

export interface LibraryState {
  route: 'home' | 'recordings' | 'recording' | 'journals' | 'journal';
  recordings: LoadState<readonly SavedRecording[]>;
  journals: LoadState<readonly JournalListItem[]>;
  journalDetail: LoadState<JournalDetail>;
  selectedRecording: SavedRecording | null;
  selectedJournal: JournalListItem | null;
  player: PlayerState;
  deletePrompt: boolean;
  deleting: boolean;
  navigationBusy: boolean;
  syncing?: boolean;
  notice: string | null;
}

export interface LibraryActions {
  showRecordings(): void;
  showJournals(): void;
  openRecording(recording: SavedRecording): void;
  openJournal(journal: JournalListItem): void;
  back(): void;
  refresh(): void;
  togglePlay(): void;
  restart(): void;
  retryPlayback(): void;
  requestDelete(): void;
  cancelDelete(): void;
  confirmDelete(target?: DeleteTarget): void;
}

export interface LibraryViewProps {
  state: LibraryState;
  actions: LibraryActions;
  onGoToRecording(): void;
}
