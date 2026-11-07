import { ApiError, createRequest, type Teacher } from './client';
import type { TeacherDocumentKind } from '../roster/teacherDocuments';

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
  result: { failed?: { child_id: string; error_code: string }[] } | null;
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
  warnings: { code: string; word: string }[];
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
}
export type JournalEdit = Pick<JournalEntry, 'content' | 'place' | 'time_text'>;

const id = encodeURIComponent;
function journalQuery(range?: DateRange, text = false) {
  const parts = text ? ['format=text'] : [];
  if (range?.from) parts.push('from=' + id(range.from));
  if (range?.to) parts.push('to=' + id(range.to));
  return parts.length ? '?' + parts.join('&') : '';
}

export function createV2Api(baseUrl: string, token: string | null, unauthorized?: (error: unknown) => void) {
  const request = createRequest(baseUrl, '/api/v2');
  async function send<T>(
    path: string, method = 'GET', body?: unknown, responseType?: 'text',
  ): Promise<T> {
    try {
      return await request(path, token, method, body, responseType) as T;
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
    openSession: (target_date: string, classroom_id?: string) =>
      send<WritingSession>('/sessions', 'POST', { target_date, classroom_id }),
    session: (sessionId: string) => send<WritingSession>('/sessions/' + id(sessionId)),
    saveBlock: (sessionId: string, blockId: string, edit: Partial<BlockEdit>) =>
      send<Block>('/sessions/' + id(sessionId) + '/blocks/' + id(blockId), 'PATCH', edit),
    generate: (sessionId: string) =>
      send<Job>('/sessions/' + id(sessionId) + '/generate?manual_areas=true&prepare_journals=true', 'POST'),
    answer: (sessionId: string, answers: ReviewAnswer[]) =>
      send<Job>('/sessions/' + id(sessionId) + '/answers', 'POST', { answers }),
    reopen: (sessionId: string) => send<WritingSession>('/sessions/' + id(sessionId) + '/reopen', 'POST'),
    regenerateNotice: (sessionId: string, childId: string) =>
      send<Job>('/sessions/' + id(sessionId) + '/children/' + id(childId) + '/regenerate', 'POST'),
    job: (jobId: string) => send<Job>('/jobs/' + id(jobId)),
    notice: (noticeId: string) => send<Notice>('/notices/' + id(noticeId)),
    saveNotice: (noticeId: string, edited_text: string, expected_version: number) =>
      send<Notice>('/notices/' + id(noticeId), 'PATCH', { edited_text, expected_version }),
    confirmNotice: (noticeId: string, expected_version: number) =>
      send<{ notice: Notice; journal_job: Job | null }>('/notices/' + id(noticeId) + '/confirm', 'POST', { expected_version }),
    unconfirmNotice: (noticeId: string, expected_version: number) =>
      send<Notice>('/notices/' + id(noticeId) + '/unconfirm', 'POST', { expected_version }),
    requestRevision: (noticeId: string, instruction: string, base_version: number) =>
      send<NoticeRevision>('/notices/' + id(noticeId) + '/revisions', 'POST', { instruction, base_version }),
    revision: (noticeId: string, revisionId: string) =>
      send<NoticeRevision>('/notices/' + id(noticeId) + '/revisions/' + id(revisionId)),
    adoptRevision: (noticeId: string, revisionId: string, expected_version: number) =>
      send<Notice>('/notices/' + id(noticeId) + '/revisions/' + id(revisionId) + '/adopt', 'POST', { expected_version }),
    journal: (childId: string, range?: DateRange) => send<Journal>('/children/' + id(childId) + '/journal' + journalQuery(range)),
    saveJournalDays: (childId: string, days: JournalDayEdit[]) =>
      send<JournalDay[]>('/children/' + id(childId) + '/journal', 'PATCH', { days }),
    journalArchive: () => send<JournalArchiveEntry[]>('/journal/archive'),
    journalText: (childId: string, range?: DateRange) =>
      send<string>('/children/' + id(childId) + '/journal/export' + journalQuery(range, true), 'GET', undefined, 'text'),
    saveJournalEntry: (entryId: string, edit: Partial<JournalEdit>, expected_version: number) =>
      send<JournalEntry>('/journal-entries/' + id(entryId), 'PATCH', { ...edit, expected_version }),
  };
}

export type V2Api = ReturnType<typeof createV2Api>;
