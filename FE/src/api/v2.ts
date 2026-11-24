import { ApiError, createRequest, type Teacher } from './client';
import { hasNameToken, textNames, type RosterName } from './textNames';
import type { TeacherDocumentKind } from '../roster/teacherDocuments';
import type { WordTemplateUpload } from '../writing/wordTemplate';

export const OBSERVATION_AREAS = ['신체운동·건강', '의사소통', '사회관계', '예술경험', '자연탐구'] as const;
export type Area = typeof OBSERVATION_AREAS[number];
export type OnboardingStep = 1 | 2 | 3 | 4 | 5;
export type WritingPreferences = { places: string[]; times: string[] };
export type DateRange = { from: string | null; to: string | null };

export interface Classroom {
  classroom_id: string;
  name: string;
  age_label: string;
}

export interface ChildDetails {
  gender: string | null;
  birth_date: string | null;
}

export interface Block {
  block_id: string;
  child_id: string | null;
  child_name: string | null;
  is_common: boolean;
  text: string;
  areas: Area[];
  place: string | null;
  time_text: string | null;
  absent: boolean;
}

export type BlockEdit = Pick<Block, 'text' | 'areas' | 'place' | 'time_text' | 'absent'>;

export interface Flag {
  flag_id: string;
  kind: string;
  question: string;
  options: string[];
  status: 'open' | 'answered' | 'skipped';
}

export type ReviewAnswer = { flag_id: string; answer: string | null } | { flag_id: string; areas: Area[] };

export interface Job {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error_code: string | null;
  result: { content?: string; failed?: { child_id: string; error_code: string }[] } | null;
}

export interface NoticeSummary {
  notice_id: string;
  child_id: string;
  child_name: string;
  version: number;
  status: '작성중' | '검토중' | '완료';
  needs_check: boolean;
  busy: boolean;
}

export interface Notice extends NoticeSummary {
  text: string;
  from_recording?: boolean;
  warnings: { code: string; word: string }[];
  needs_journal_update_choice: boolean;
}

export interface NoticeRevision {
  revision_id: string;
  status: Job['status'];
  job_id: string | null;
  candidate_text: string | null;
}

export interface WritingSession {
  session_id: string;
  classroom: Classroom;
  target_date: string;
  status: 'writing' | 'analyzing' | 'asking' | 'drafting' | 'reviewing' | 'failed';
  error_code: string | null;
  blocks: Block[];
  flags: Flag[];
  notices: NoticeSummary[];
  job: Job | null;
}

export interface RecordingCandidate {
  child_id: string;
  child_name: string;
  text: string;
  replaces_notice: boolean;
}

export interface RecordingRun {
  run_id: string;
  stage: 'transcribing' | 'transcription_failed' | 'analyzing' | 'asking' | 'drafting' | 'ready' | 'failed';
  initial: boolean;
  recording_ids: string[];
  child_ids: string[];
  flags: Flag[];
  failed_recordings: { recording_id: string; code: string }[];
  candidates: RecordingCandidate[];
  missing_children: string[];
  error_code: string | null;
}

export interface RecordingDraftState {
  used_recordings: Record<string, string[]>;
  run: RecordingRun | null;
}

export interface JournalEntry {
  entry_id: string;
  observed_date: string;
  block_kind: 'common' | 'individual';
  areas: Area[];
  place: string | null;
  time_text: string | null;
  content: string;
  status: 'pending' | 'ready' | 'edited' | 'failed';
  included: boolean;
  is_draft: boolean;
  version: number;
}

export interface JournalDayText {
  observed_date: string;
  content: string;
  areas: Area[];
  places: string[];
  times: string[];
}

export interface JournalDay extends JournalDayText {
  edit_version: number;
  revision: string;
  editable: boolean;
}

export interface JournalArchiveEntry extends JournalDayText {
  child_id: string;
  child_name: string;
}

export type JournalDayEdit = Pick<JournalDayText, 'observed_date' | 'content'> & { expected_revision: string };

export interface Journal {
  child: { child_id: string; name: string; gender: string | null; birth_date: string | null };
  items: JournalEntry[];
  days: JournalDay[];
  output_revision?: string | null;
  output_stale?: boolean;
}
export type JournalOutput = { text: string; revision: string; can_export_word: boolean };
export type JournalEdit = Pick<JournalEntry, 'content' | 'place' | 'time_text'>;
export type JournalObservation = JournalEdit & { areas: Area[] };
export type JournalCreate = JournalObservation & { observed_date: string };

const id = encodeURIComponent;
const recordingDraftPath = (sessionId: string, runId?: string) =>
  '/sessions/' + id(sessionId) + '/recording-drafts' + (runId ? '/' + id(runId) : '');
function journalQuery(range?: DateRange, text = false) {
  const parts = text ? ['format=text'] : [];
  if (range?.from) parts.push('from=' + id(range.from));
  if (range?.to) parts.push('to=' + id(range.to));
  return parts.length ? '?' + parts.join('&') : '';
}

export function createV2Api(baseUrl: string, token: string | null, unauthorized?: (error: unknown) => void,
  roster?: () => Promise<RosterName[]>,
) {
  const request = createRequest(baseUrl, '/api/v2');
  let loading: Promise<ReturnType<typeof textNames>> | null = null;
  async function names() {
    if (!roster) return textNames([]);
    loading ??= roster().then(textNames).finally(() => { loading = null; });
    return loading;
  }
  let privacyCheck: Promise<void> | null = null;
  function verifyPrivacy(): Promise<void> {
    if (!roster) return Promise.resolve();
    privacyCheck ??= send<{ supported: boolean }>('/sessions/text-privacy').then(result => {
      if (result.supported !== true) throw new Error('텍스트 가명 처리를 지원하는 서버가 필요해요.');
    }).catch(error => {
      privacyCheck = null;
      if (error instanceof ApiError && error.status === 404) {
        throw new ApiError(0, 'TEXT_PRIVACY_UNAVAILABLE', '서버 업데이트 후 가명 처리로 작성할 수 있어요.');
      }
      throw error;
    });
    return privacyCheck;
  }
  function transform<T>(value: T, convert: (text: string) => string): T {
    if (typeof value === 'string') return convert(value) as T;
    if (Array.isArray(value)) return value.map(item => transform(item, convert)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transform(item, convert)])) as T;
    }
    return value;
  }
  async function protect<T>(value: T, owner?: string | null, enabled = true): Promise<T> {
    if (!roster || !enabled) return value;
    const [, codec] = await Promise.all([verifyPrivacy(), names()]);
    return transform(value, text => codec.encode(text, owner));
  }
  async function protectFields<T extends { text?: string; content?: string; place?: string | null; time_text?: string | null }>(
    value: T, owner?: string | null, enabled = true,
  ): Promise<T> {
    if (!roster || !enabled) return value;
    const [, codec] = await Promise.all([verifyPrivacy(), names()]);
    const result = { ...value };
    for (const field of ['text', 'content', 'place', 'time_text'] as const) {
      const text = value[field];
      if (typeof text === 'string') result[field] = codec.encode(text, owner);
    }
    return result;
  }
  const privateQuery = roster ? '?protect_text=true' : '';

  async function send<T>(
    path: string, method = 'GET', body?: unknown, responseType?: 'text' | 'arrayBuffer', timeoutMs?: number,
  ): Promise<T> {
    try {
      const value = await request(path, token, method, body, responseType, undefined, timeoutMs) as T;
      if (!roster || responseType === 'arrayBuffer' || !hasNameToken(JSON.stringify(value) ?? '')) return value;
      const codec = await names();
      return transform(value, codec.restore);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) unauthorized?.(error);
      throw error;
    }
  }

  return {
    signup: (login_id: string, display_name: string, password: string) =>
      send<Teacher>('/auth/signup', 'POST', { login_id, display_name, password }),
    onboarding: () => send<{ step: OnboardingStep }>('/onboarding'),
    saveOnboarding: (step: OnboardingStep) => send<{ step: OnboardingStep }>('/onboarding', 'PUT', { step }),
    writingPreferences: () => send<WritingPreferences>('/teacher/writing-preferences'),
    saveWritingPreferences: (value: WritingPreferences) => send<WritingPreferences>('/teacher/writing-preferences', 'PUT', value),
    classrooms: async () => (await send<{ items: Classroom[] }>('/classrooms')).items,
    saveClassroom: (classroom: { classroom_id: string; name: string; age_label?: string }) =>
      send<Classroom>('/classrooms/' + id(classroom.classroom_id), 'PATCH', {
        name: classroom.name, age_label: classroom.age_label,
      }),
    characteristics: async (childId: string) =>
      (await send<{ text: string | null }>('/children/' + id(childId) + '/characteristics')).text,
    saveCharacteristics: (childId: string, text: string) =>
      send<void>('/children/' + id(childId) + '/characteristics', 'PUT', { text }),
    childDetails: (childId: string) => send<ChildDetails>('/children/' + id(childId) + '/details'),
    saveChildDetails: (childId: string, details: ChildDetails) =>
      send<ChildDetails>('/children/' + id(childId) + '/details', 'PATCH', details),
    teacherDocument: async (kind: TeacherDocumentKind) =>
      (await send<{ text: string | null }>('/teacher/documents/' + kind)).text,
    saveTeacherDocument: (kind: TeacherDocumentKind, text: string) =>
      send<void>('/teacher/documents/' + kind, 'PUT', { text }),
    journalTemplate: () => send<{ filename: string | null }>('/teacher/journal-template'),
    uploadJournalTemplate: ({ name, data }: WordTemplateUpload) =>
      send<{ filename: string }>('/teacher/journal-template?filename=' + id(name), 'POST', data, undefined, 60000),
    deleteJournalTemplate: () => send<void>('/teacher/journal-template', 'DELETE'),
    openSession: (target_date: string, classroom_id?: string) =>
      send<WritingSession>('/sessions', 'POST', { target_date, classroom_id }),
    session: (sessionId: string) => send<WritingSession>('/sessions/' + id(sessionId)),
    saveBlock: async (sessionId: string, blockId: string, edit: Partial<BlockEdit>, owner?: string | null, protectedText = true) =>
      send<Block>('/sessions/' + id(sessionId) + '/blocks/' + id(blockId), 'PATCH', await protectFields(edit, owner, protectedText)),
    generate: async (sessionId: string) => {
      await verifyPrivacy();
      return send<Job>('/sessions/' + id(sessionId) + '/generate?manual_areas=true&prepare_journals=true' +
        (roster ? '&protect_text=true' : ''), 'POST');
    },
    recordingDraft: (sessionId: string) => send<RecordingDraftState>(recordingDraftPath(sessionId)),
    startRecordingDraft: (sessionId: string, recording_ids: string[], child_ids?: string[]) =>
      send<RecordingDraftState>(recordingDraftPath(sessionId), 'POST', { recording_ids, child_ids }),
    resolveTranscriptions: (sessionId: string, runId: string, action: 'retry' | 'exclude') =>
      send<RecordingDraftState>(recordingDraftPath(sessionId, runId) + '/transcriptions/' + action, 'POST'),
    answerRecordingDraft: (sessionId: string, runId: string, answers: Record<string, string | null>) =>
      send<RecordingDraftState>(recordingDraftPath(sessionId, runId) + '/answers', 'POST', { answers }),
    applyRecordingDraft: (sessionId: string, runId: string, childId: string) =>
      send<RecordingDraftState>(recordingDraftPath(sessionId, runId) + '/children/' + id(childId) + '/apply', 'POST'),
    dismissRecordingDraft: (sessionId: string, runId: string) =>
      send<RecordingDraftState>(recordingDraftPath(sessionId, runId), 'DELETE'),
    answer: async (sessionId: string, answers: ReviewAnswer[]) => {
      await verifyPrivacy();
      return send<Job>('/sessions/' + id(sessionId) + '/answers' + privateQuery, 'POST', {
        answers: await Promise.all(answers.map(async answer =>
          'answer' in answer ? { ...answer, answer: await protect(answer.answer) } : answer)),
      });
    },
    reopen: (sessionId: string) => send<WritingSession>('/sessions/' + id(sessionId) + '/reopen', 'POST'),
    regenerateNotice: async (sessionId: string, childId: string) => {
      await verifyPrivacy();
      return send<Job>('/sessions/' + id(sessionId) + '/children/' + id(childId) + '/regenerate' + privateQuery, 'POST');
    },
    job: (jobId: string) => send<Job>('/jobs/' + id(jobId)),
    notice: (noticeId: string) => send<Notice>('/notices/' + id(noticeId)),
    saveNotice: async (noticeId: string, edited_text: string, expected_version: number, owner?: string, protectedText = true) =>
      send<Notice>('/notices/' + id(noticeId), 'PATCH', { edited_text: await protect(edited_text, owner, protectedText), expected_version }),
    confirmNotice: async (noticeId: string, expected_version: number, update_journal?: boolean) => {
      await verifyPrivacy();
      return send<{ notice: Notice; journal_job: Job | null }>('/notices/' + id(noticeId) + '/confirm' + privateQuery, 'POST',
        { expected_version, update_journal });
    },
    unconfirmNotice: (noticeId: string, expected_version: number) =>
      send<Notice>('/notices/' + id(noticeId) + '/unconfirm', 'POST', { expected_version }),
    requestRevision: async (noticeId: string, instruction: string, base_version: number, owner?: string, protectedText = true) =>
      send<NoticeRevision>('/notices/' + id(noticeId) + '/revisions' + (protectedText ? privateQuery : ''), 'POST',
        { instruction: await protect(instruction, owner, protectedText), base_version }),
    revision: (noticeId: string, revisionId: string) =>
      send<NoticeRevision>('/notices/' + id(noticeId) + '/revisions/' + id(revisionId)),
    adoptRevision: (noticeId: string, revisionId: string, expected_version: number) =>
      send<Notice>('/notices/' + id(noticeId) + '/revisions/' + id(revisionId) + '/adopt', 'POST', { expected_version }),
    journal: (childId: string, range?: DateRange) => send<Journal>('/children/' + id(childId) + '/journal' + journalQuery(range)),
    draftStandaloneJournal: async (childId: string, observation: JournalObservation) =>
      send<Job>('/children/' + id(childId) + '/journal/draft' + privateQuery, 'POST', await protectFields(observation, childId)),
    createJournal: async (childId: string, entry: JournalCreate) =>
      send<JournalEntry>('/children/' + id(childId) + '/journal', 'POST', await protectFields(entry, childId)),
    saveJournalDays: async (childId: string, days: JournalDayEdit[]) =>
      send<JournalDay[]>('/children/' + id(childId) + '/journal', 'PATCH', { days: await Promise.all(days.map(async day =>
        ({ ...day, content: await protect(day.content, childId) }))) }),
    journalArchive: () => send<JournalArchiveEntry[]>('/journal/archive'),
    journalText: (childId: string, range?: DateRange) =>
      send<string>('/children/' + id(childId) + '/journal/export' + journalQuery(range, true), 'GET', undefined, 'text'),
    journalOutput: (childId: string, range: DateRange) =>
      send<JournalOutput>('/children/' + id(childId) + '/journal/output' + journalQuery(range), 'POST'),
    journalWord: async (childId: string, range: DateRange, revision: string) => {
      const query = journalQuery(range);
      const data = await send<ArrayBuffer>('/children/' + id(childId) + '/journal/output/word' + query +
        (query ? '&' : '?') + 'revision=' + id(revision), 'POST', undefined, 'arrayBuffer', 150000);
      if (!roster) return data;
      const { restoreWordNames } = await import('../writing/wordNames');
      return restoreWordNames(data, names);
    },
    saveJournalEntry: (entryId: string, edit: Partial<JournalEdit>, expected_version: number) =>
      send<JournalEntry>('/journal-entries/' + id(entryId), 'PATCH', { ...edit, expected_version }),
  };
}

export type V2Api = ReturnType<typeof createV2Api>;
