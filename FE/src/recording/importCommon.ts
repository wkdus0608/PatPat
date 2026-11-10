/** 서버가 받는 오디오 형식과 업로드 한도(BE/docs/RECORDINGS.md). */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

const byExtension: Record<string, string> = {
  m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', aac: 'audio/aac',
};
const accepted = new Set([
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/aac',
]);

export class ImportError extends Error {}

/** 선택한 파일의 서버 업로드용 MIME. 지원하지 않으면 null. */
export function importMimeType(name: string, declared?: string | null): string | null {
  const type = (declared ?? '').split(';')[0].trim().toLowerCase();
  if (accepted.has(type)) return type;
  return byExtension[name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

export function checkImport(name: string, size: number | undefined, declared?: string | null): string {
  const mime = importMimeType(name, declared);
  if (!mime) throw new ImportError('m4a·mp3·wav·aac·webm 녹음 파일만 올릴 수 있어요.');
  if (!size || size <= 0) throw new ImportError('비어 있는 파일은 올릴 수 없어요.');
  if (size > MAX_IMPORT_BYTES) throw new ImportError('파일이 너무 커요. 100MB 이하 파일을 올려 주세요.');
  return mime;
}

export function importTitle(name: string): string {
  return name.trim().slice(0, 120) || '업로드한 녹음';
}
