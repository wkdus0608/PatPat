import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { LibraryPlayer } from './types';
import { createManagedPlayer } from './managedPlayer';

/** One manually owned player per selected file; no permission request or upload. */
export function createExpoLibraryPlayer(uri: string): LibraryPlayer {
  const native = createAudioPlayer({ uri }, { updateInterval: 250, keepAudioSessionActive: false });
  return createManagedPlayer(native, () => setAudioModeAsync({
    allowsRecording: false, playsInSilentMode: true,
    allowsBackgroundRecording: false, shouldPlayInBackground: false,
  }));
}
