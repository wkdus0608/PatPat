import { ApiError } from '../api/client';

export const TEACHER_DOCUMENT_KINDS = ['writing_examples', 'record_format'] as const;
export type TeacherDocumentKind = typeof TEACHER_DOCUMENT_KINDS[number];

export const TEACHER_DOCUMENTS: Record<TeacherDocumentKind, {
  title: string; prompt: string; hint: string; placeholder: string; successMessage: string;
}> = {
  writing_examples: {
    title: '내 글쓰기 예시', prompt: '선생님이 작성한 글을 남겨주세요.',
    hint: '이전에 작성한 관찰일지나 알림장 내용을 붙여 넣어주세요.',
    placeholder: '작성했던 글을 붙여 넣어주세요.', successMessage: '글쓰기 예시를 저장했어요.',
  },
  record_format: {
    title: '관찰일지 기록 양식', prompt: '우리 원에서는 어떻게 기록하나요?',
    hint: '관찰일지의 항목과 작성 규칙을 적어 주세요. Word 양식을 올렸다면 어떤 칸을 채울지 지정할 수 있어요.',
    placeholder: '우리 원의 관찰일지 기록 형식을 적어 주세요.', successMessage: '기록 양식을 저장했어요.',
  },
};

// Per-authenticated-controller FE boundary; no teacher settings API exists yet.
export interface TeacherDocumentSource {
  load(kind: TeacherDocumentKind): Promise<string | null>;
  save(kind: TeacherDocumentKind, text: string): Promise<void>;
}

function unavailable(): never {
  throw new ApiError(501, 'NOT_IMPLEMENTED', '아직 저장 기능이 연결되지 않았어요. 입력한 내용은 유지돼요.');
}

export const unavailableTeacherDocumentSource: TeacherDocumentSource = {
  async load() { return unavailable(); },
  async save() { unavailable(); },
};
