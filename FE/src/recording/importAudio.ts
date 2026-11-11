import { createAudioPlayer } from 'expo-audio';
import { File, UploadType } from 'expo-file-system';
import { ApiError, serverRecording } from '../api/client';
import type { Account } from '../auth/controller';
import { checkImport, ImportError, importTitle, type ImportResult } from './importCommon';

async function audioSeconds(uri: string): Promise<number> {
  const player = createAudioPlayer({ uri });
  try {
    for (let waited = 0; waited < 10_000; waited += 100) {
      if (player.duration > 0) return player.duration;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new ImportError('녹음 길이를 읽지 못했어요. 다른 파일을 선택해 주세요.');
  } finally { player.remove(); }
}

async function uploadAsset(account: Account, asset: { uri: string; name: string; size?: number; mimeType?: string }): Promise<void> {
  const mime = checkImport(asset.name, asset.size, asset.mimeType);
  const file = new File(asset.uri);
  try {
    const duration = await audioSeconds(asset.uri);
    const result = await file.createUploadTask(account.api.baseUrl + '/api/v1/recordings', {
      httpMethod: 'POST', uploadType: UploadType.MULTIPART, fieldName: 'file', mimeType: mime,
      parameters: { title: importTitle(asset.name), recorded_at: new Date().toISOString(), duration_seconds: String(duration) },
      headers: { Authorization: 'Bearer ' + account.session.token, 'Idempotency-Key': Math.random().toString(36).slice(2) + Date.now() },
      sessionType: 'foreground',
    }).uploadAsync();
    if (result.status === 401) {
      account.unauthorized(new ApiError(401, 'UNAUTHORIZED', ''));
      throw new ImportError('로그인이 만료됐어요. 다시 로그인해 주세요.', true);
    }
    if (result.status === 415) throw new ImportError('이 파일은 재생할 수 없는 형식이에요.');
    if (result.status === 413) throw new ImportError('파일이 너무 커요. 100MB 이하 파일을 올려 주세요.');
    if (result.status < 200 || result.status >= 300) throw new ImportError('서버에 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    serverRecording(JSON.parse(result.body));
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('서버에 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
  } finally { if (file.exists) file.delete(); }
}

/** 기기에서 녹음 파일을 여러 개 골라 차례로 서버에 올린다. 선택을 취소하면 null. */
export async function importAudioFiles(account: Account): Promise<ImportResult | null> {
  const { getDocumentAsync } = await import('expo-document-picker');
  const selection = await getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true, multiple: true });
  if (selection.canceled) return null;
  const result: ImportResult = { uploaded: 0, failed: [] };
  for (const asset of selection.assets) {
    try { await uploadAsset(account, asset); result.uploaded++; }
    catch (error) {
      result.failed.push({ name: asset.name, message: error instanceof ImportError ? error.message : '올리지 못했어요.' });
      if (error instanceof ImportError && error.fatal) break;
    }
  }
  return result;
}
