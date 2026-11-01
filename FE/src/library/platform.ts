import { createExpoFilePort } from '../recording/expoFileStore';
import { createExpoLibraryPlayer } from './expoPlayer';
import { createRecordingLibrary } from './recordingLibrary';

export function createLibraryPlatform() {
  return { recordings: createRecordingLibrary(createExpoFilePort()), createPlayer: createExpoLibraryPlayer };
}
