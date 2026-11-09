import type { Account } from '../auth/controller';
import { createExpoLibraryPlayer } from '../library/expoPlayer';
import { getAccountLibrary } from '../library/platform';
import { createRecordingRemote } from '../library/remote';
import type { LibraryPlayer } from '../library/types';
import type { SavedRecording } from '../recording/storage';

export async function listLocalAudio(account: Account, day: string): Promise<SavedRecording[]> {
  return (await getAccountLibrary(account).list()).filter(item => item.dateKey === day && item.location !== 'server');
}

export function removeNoticeAudio(account: Account, item: SavedRecording): Promise<void> {
  return getAccountLibrary(account).remove(item);
}

export async function openNoticeAudio(account: Account, item: SavedRecording, signal: AbortSignal): Promise<LibraryPlayer> {
  if (item.location !== 'server') return createExpoLibraryPlayer(item.uri);
  if (!item.serverId) throw new Error('Missing recording ID');
  const remote = createRecordingRemote(account);
  try {
    const uri = await remote.playback(item.serverId, signal);
    const player = createExpoLibraryPlayer(uri);
    return { ...player, async release() {
      try { await player.release(); } finally { await remote.cleanup(); }
    } };
  } catch (error) {
    await remote.cleanup();
    throw error;
  }
}
