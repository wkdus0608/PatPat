import { ApiError, uploadWebRecording } from '../api/client';
import type { Account } from '../auth/controller';
import { checkImport, ImportError, importTitle } from './importCommon';

function pickFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.m4a,.mp3,.wav,.aac,.webm';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function audioSeconds(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (seconds: number | Error) => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      return seconds instanceof Error ? reject(seconds) : resolve(seconds);
    };
    const fail = () => done(new ImportError('녹음 길이를 읽지 못했어요. 다른 파일을 선택해 주세요.'));
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? done(audio.duration) : fail());
    audio.onerror = fail;
    audio.src = url;
  });
}

/** 컴퓨터에서 녹음 파일을 골라 서버에 올린다. 취소하면 false. */
export async function importAudioFile(account: Account): Promise<boolean> {
  const file = await pickFile();
  if (!file) return false;
  const mime = checkImport(file.name, file.size, file.type);
  const duration = await audioSeconds(file);
  const form = new FormData();
  form.append('file', new Blob([file], { type: mime }), file.name);
  form.append('title', importTitle(file.name));
  form.append('recorded_at', new Date().toISOString());
  form.append('duration_seconds', String(duration));
  try {
    await uploadWebRecording(account.api.baseUrl, account.session.token, form, crypto.randomUUID(), new AbortController().signal);
    return true;
  } catch (error) {
    account.unauthorized(error);
    if (error instanceof ApiError && error.status === 413) throw new ImportError('파일이 너무 커요. 100MB 이하 파일을 올려 주세요.');
    if (error instanceof ApiError && error.status === 415) throw new ImportError('이 파일은 재생할 수 없는 형식이에요.');
    throw new ImportError('서버에 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
  }
}
