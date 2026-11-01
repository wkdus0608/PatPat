import type { LibraryPlayer } from './types';

export interface NativePlaybackStatus {
  isLoaded: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  playbackState: string;
  error: string | null;
  didJustFinish?: boolean;
  mediaServicesDidReset?: boolean;
}

export interface NativePlaybackHandle {
  readonly currentStatus: NativePlaybackStatus;
  play(): void;
  pause(): void;
  remove(): void;
  seekTo(seconds: number): Promise<void>;
  addListener(event: 'playbackStatusUpdate', listener: (status: NativePlaybackStatus) => void): { remove(): void };
}

/** Cancellation belongs to the player, so a delayed audio-mode change cannot restart it. */
export function createManagedPlayer(native: NativePlaybackHandle, setPlaybackMode: () => Promise<void>): LibraryPlayer {
  let released = false;
  let releasePromise: Promise<void> | null = null;
  let playVersion = 0;
  let finished = false;
  let failure: string | undefined;
  let modeWork: Promise<void> | null = null;

  function observe(status: NativePlaybackStatus) {
    if (released) return;
    if (status.error || status.playbackState === 'error' || status.mediaServicesDidReset) {
      failure = '오디오 재생이 중단되었어요.';
      ++playVersion;
      try { native.pause(); } catch { /* Leave/retry will also attempt native release. */ }
    }
  }
  const subscription = native.addListener('playbackStatusUpdate', (status) => {
    if (status.didJustFinish) finished = true;
    observe(status);
  });

  return {
    async play() {
      const version = ++playVersion;
      if (released || failure) throw new Error('Playback is unavailable');
      const work = setPlaybackMode();
      modeWork = work;
      try { await work; } finally { if (modeWork === work) modeWork = null; }
      if (released || version !== playVersion || failure) return;
      finished = false;
      native.play();
    },
    async pause() {
      ++playVersion;
      if (!released) native.pause();
    },
    async seekTo(seconds) {
      if (released || failure) throw new Error('Playback is unavailable');
      await native.seekTo(seconds);
      finished = false;
    },
    release() {
      ++playVersion;
      if (released) return Promise.resolve();
      if (releasePromise) return releasePromise;
      releasePromise = (async () => {
        try { native.pause(); } catch { /* Removing the player must still be attempted. */ }
        // Do not let an old pending mode change race the next microphone session.
        if (modeWork) await modeWork.catch(() => {});
        try { native.pause(); } catch { /* A successful remove is authoritative cleanup. */ }
        native.remove();
        released = true;
        try { subscription.remove(); } catch { /* Native audio is already disposed. */ }
      })().finally(() => { releasePromise = null; });
      return releasePromise;
    },
    getStatus() {
      if (released) throw new Error('Player released');
      const status = native.currentStatus;
      observe(status);
      return {
        loaded: status.isLoaded, playing: status.playing,
        currentTime: Number.isFinite(status.currentTime) ? Math.max(0, status.currentTime) : 0,
        duration: status.isLoaded && Number.isFinite(status.duration) && status.duration > 0 ? status.duration : null,
        finished, error: failure,
      };
    },
  };
}
