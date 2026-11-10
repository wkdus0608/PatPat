import type { Account } from '../auth/controller';
import type { LibraryPlayer } from '../library/types';
import { createWebLibraryPlayer } from '../library/webPlayer';
import type { SavedRecording } from '../recording/storage';

export async function listLocalAudio(_account: Account, _day: string): Promise<SavedRecording[]> { return []; }

export async function removeNoticeAudio(account: Account, item: SavedRecording): Promise<void> {
  if (!item.serverId) throw new Error('Missing recording ID');
  await account.api.deleteRecording(account.session.token, item.serverId);
}

export async function openNoticeAudio(account: Account, item: SavedRecording, signal: AbortSignal): Promise<LibraryPlayer> {
  if (!item.serverId) throw new Error('Missing recording ID');
  const blob = await account.api.recordingAudio(account.session.token, item.serverId, signal);
  return createWebLibraryPlayer(URL.createObjectURL(blob));
}
