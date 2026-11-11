import type { Account } from '../auth/controller';
import { compareRecordings } from '../recording/files';
import type { SavedRecording } from '../recording/storage';
import { serverItem } from './sync';
import type { PlayerFactory, RecordingLibrary } from './types';
import { createWebLibraryPlayer } from './webPlayer';
import { importAudioFiles } from '../recording/importAudio';
import { importSummary } from '../recording/importCommon';

export function createLibraryPlatform(account?: Account): { recordings: RecordingLibrary; createPlayer: PlayerFactory } {
  let playback: AbortController | null = null;
  let playbackUri: string | null = null;
  function releasePlayback() {
    playback?.abort();
    playback = null;
    if (playbackUri) URL.revokeObjectURL(playbackUri);
    playbackUri = null;
  }

  function serverId(recording: SavedRecording) {
    if (!recording.serverId) throw new Error('Missing recording ID');
    return recording.serverId;
  }

  async function signedIn<T>(action: (account: Account) => Promise<T>): Promise<T> {
    if (!account) throw new Error('Sign-in required');
    try { return await action(account); } catch (error) { account.unauthorized(error); throw error; }
  }

  return {
    recordings: {
      available: !!account,
      async importFiles() {
        if (!account) return null;
        const outcome = await importAudioFiles(account);
        return outcome && importSummary(outcome).text;
      },
      list: () => signedIn(async ({ api, session }) => {
        const items = new Map<string, SavedRecording>();
        let offset = 0;
        while (true) {
          const page = await api.listRecordings(session.token, offset);
          for (const row of page.items) items.set(row.recording_id, serverItem(row));
          offset += page.items.length;
          if (!page.items.length || offset >= page.total) break;
        }
        return Array.from(items.values()).sort(compareRecordings);
      }),
      validate: (recording) => signedIn(async ({ api, session }) => { await api.getRecording(session.token, serverId(recording)); }),
      remove: (recording) => signedIn(({ api, session }) => api.deleteRecording(session.token, serverId(recording))),
      playbackUri: (recording) => signedIn(async ({ api, session }) => {
        releasePlayback();
        const active = new AbortController();
        playback = active;
        const blob = await api.recordingAudio(session.token, serverId(recording), active.signal);
        if (active.signal.aborted) throw new Error('Playback cancelled');
        playbackUri = URL.createObjectURL(blob);
        return playbackUri;
      }),
      async releasePlayback() { releasePlayback(); },
    },
    createPlayer: createWebLibraryPlayer,
  };
}
