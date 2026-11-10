import type { LibraryPlayer } from './types';

export function createWebLibraryPlayer(uri: string): LibraryPlayer {
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
