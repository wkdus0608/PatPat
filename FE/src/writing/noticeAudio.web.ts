import type { Account } from '../auth/controller';
import type { LibraryPlayer } from '../library/types';
import type { SavedRecording } from '../recording/storage';

export async function listLocalAudio(_account: Account, _day: string): Promise<SavedRecording[]> { return []; }

export async function removeNoticeAudio(account: Account, item: SavedRecording): Promise<void> {
  if (!item.serverId) throw new Error('Missing recording ID');
  await account.api.deleteRecording(account.session.token, item.serverId);
}

export async function openNoticeAudio(account: Account, item: SavedRecording, signal: AbortSignal): Promise<LibraryPlayer> {
  if (!item.serverId) throw new Error('Missing recording ID');
  const blob = await account.api.recordingAudio(account.session.token, item.serverId, signal);
  const uri = URL.createObjectURL(blob);
  const audio = new Audio(uri);
  return {
    play: () => audio.play(),
    async pause() { audio.pause(); },
    async seekTo(seconds) { audio.currentTime = seconds; },
    async release() { audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(uri); },
    getStatus() {
      return {
        loaded: audio.readyState > 0, playing: !audio.paused && !audio.ended, finished: audio.ended,
        currentTime: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
        error: audio.error ? '녹음을 재생하지 못했어요.' : undefined,
      };
    },
  };
}
