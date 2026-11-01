import type { PlayerFactory, RecordingLibrary } from './types';

export function createLibraryPlatform(): { recordings: RecordingLibrary; createPlayer: PlayerFactory } {
  const unavailable = async (): Promise<never> => { throw new Error('Device files are not available in the web preview'); };
  return {
    recordings: { available: false, list: unavailable, validate: unavailable, remove: unavailable },
    createPlayer() { throw new Error('Device playback is not available in the web preview'); },
  };
}
