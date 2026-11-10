import { ApiError, uploadWebRecording } from '../api/client';
import type { Account } from '../auth/controller';
import { checkImport, ImportError, importTitle, type ImportResult } from './importCommon';

function pickFiles(): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'audio/*,.m4a,.mp3,.wav,.aac,.webm';
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
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

async function uploadFile(account: Account, file: File): Promise<void> {
  const mime = checkImport(file.name, file.size, file.type);
  const duration = await audioSeconds(file);
  const form = new FormData();
  form.append('file', new Blob([file], { type: mime }), file.name);
  form.append('title', importTitle(file.name));
  form.append('recorded_at', new Date().toISOString());
  form.append('duration_seconds', String(duration));
  try {
    await uploadWebRecording(account.api.baseUrl, account.session.token, form, crypto.randomUUID(), new AbortController().signal);
  } catch (error) {
    account.unauthorized(error);
    if (error instanceof ApiError && error.status === 401) throw new ImportError('로그인이 만료됐어요. 다시 로그인해 주세요.', true);
    if (error instanceof ApiError && error.status === 413) throw new ImportError('파일이 너무 커요. 100MB 이하 파일을 올려 주세요.');
    if (error instanceof ApiError && error.status === 415) throw new ImportError('이 파일은 재생할 수 없는 형식이에요.');
    throw new ImportError('서버에 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
  }
}

/** 컴퓨터에서 녹음 파일을 여러 개 골라 차례로 서버에 올린다. 선택을 취소하면 null. */
export async function importAudioFiles(account: Account): Promise<ImportResult | null> {
  const files = await pickFiles();
  if (!files.length) return null;
  const result: ImportResult = { uploaded: 0, failed: [] };
  for (const file of files) {
    try { await uploadFile(account, file); result.uploaded++; }
    catch (error) {
      result.failed.push({ name: file.name, message: error instanceof ImportError ? error.message : '올리지 못했어요.' });
      if (error instanceof ImportError && error.fatal) break;
    }
  }
  return result;
}
