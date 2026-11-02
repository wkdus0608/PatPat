import type { JournalSource, LoadState } from '../library/types';
import type { SavedRecording } from '../recording/storage';

export type ContentKind = '관찰' | '배움 읽기' | '놀이 지원' | '지원 계획';

export interface Observation {
  observation_id: string;
  child_ids: string[];
  activity: string;
  text: string;
  observation_type: string[];
  scope: 'common' | 'individual' | 'joint' | 'unresolved';
  sensitive: boolean;
}

/** Local adapter context, NOT a new API or database schema. */
export interface PreparedObservations {
  recordingUris: string[];
  childIds: string[];
  observations: Observation[];
  privacyVerified: true;
}

export interface DraftRequest {
  record_type: '관찰일지';
  child_ids: string[];
  observation_ids: string[];
}

/** Only a trusted LOCAL gateway may implement this port. It must transcribe and
 * verify pseudonymization before generate, and pseudonymize edit/prompt before
 * any external AI call in revise. This FE never sends files or text to a URL. */
export interface JournalWorkflow {
  prepare(recordings: readonly SavedRecording[], signal: AbortSignal): Promise<unknown>;
  generate(request: DraftRequest, signal: AbortSignal): Promise<unknown>;
  revise?(input: {
    recordId: string; childId: string; editedText: string; prompt: string;
    observationIds: string[];
  }, signal: AbortSignal): Promise<unknown>;
}

export interface JournalConfirmation {
  confirm(recordId: string, input: { edited_text: string }): Promise<unknown>;
}

export interface TextSharing {
  share(text: string): Promise<'opened' | 'dismissed'>;
}

export interface WritingServices {
  workflow?: JournalWorkflow;
  confirmation?: JournalConfirmation;
  journals?: JournalSource;
  sharing?: TextSharing;
}

/** FE presentation state; no identifiers are persisted or fabricated here. */
export interface DraftSentence {
  text: string;
  observationIds: string[];
  contentKind: ContentKind;
}

export interface EditableJournal {
  recordId: string;
  childId: string;
  sentences: DraftSentence[];
  missingEvidence: boolean;
  initialText: string;
  editedText: string;
  prompt: string;
  version: number;
  candidate: { text: string; baseVersion: number } | null;
  confirmedText: string | null;
}

export interface WritingDraft {
  commonText: string;
  context: PreparedObservations;
  records: EditableJournal[];
}

export interface WritingState {
  route: 'editor' | 'picker';
  recordings: LoadState<readonly SavedRecording[]>;
  selected: readonly SavedRecording[];
  checked: readonly string[];
  draft: WritingDraft | null;
  activeRecordId: string | null;
  phase: 'idle' | 'validating' | 'generating' | 'revising' | 'confirming' | 'sharing';
  notice: string | null;
  guard: {
    kind: 'selection' | 'regenerate' | 'leave';
    title: string; message: string; confirmLabel: string;
  } | null;
}

export interface WritingCapabilities {
  generation: boolean;
  revision: boolean;
  confirmation: boolean;
  sharing: boolean;
}

export interface WritingActions {
  openPicker(): void;
  refreshRecordings(): void;
  toggleRecording(uri: string): void;
  cancelPicker(): void;
  importRecordings(): void;
  removeRecording(uri: string): void;
  generate(): void;
  selectRecord(recordId: string): void;
  editText(text: string): void;
  editPrompt(text: string): void;
  revise(): void;
  dismissCandidate(): void;
  applyCandidate(): void;
  confirm(): void;
  share(): void;
  resolveGuard(accepted: boolean): void;
}

export interface WritingViewProps {
  state: WritingState;
  capabilities: WritingCapabilities;
  actions: WritingActions;
}
