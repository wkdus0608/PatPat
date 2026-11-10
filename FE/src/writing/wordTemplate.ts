import { ApiError } from '../api/client';

const extensions = ['.docx', '.doc', '.dotx', '.dot', '.docm', '.dotm', '.rtf', '.odt', '.ott', '.xml', '.fodt', '.word'];
export const wordTemplateAccept = extensions.join(',');
export type WordTemplateUpload = { name: string; data: ArrayBuffer };

export function checkWordTemplate(name: string, size?: number): void {
  const lower = name.toLowerCase();
  if (!extensions.some(extension => lower.endsWith(extension))) {
    throw new ApiError(422, 'UNSUPPORTED_WORD_TEMPLATE', 'Word 문서 또는 호환 양식(.docx, .doc, .dotx, .rtf, .odt 등)을 선택해 주세요.');
  }
  if (size === 0) {
    throw new ApiError(422, 'WORD_FILE_MISSING', '양식 파일이 비어 있어요. 파일을 다시 선택해 주세요.');
  }
  if (size !== undefined && size > 5 * 1024 * 1024) {
    throw new ApiError(413, 'WORD_TEMPLATE_TOO_LARGE', '5MB 이하의 Word 양식 파일을 선택해 주세요.');
  }
}
