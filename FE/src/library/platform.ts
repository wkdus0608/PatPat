import { createExpoFilePort } from '../recording/expoFileStore';
import { createExpoLibraryPlayer } from './expoPlayer';
import { createRecordingLibrary } from './recordingLibrary';
import type { Account } from '../auth/controller';
import { createSyncStore } from '../recording/syncStore';
import { createSyncedLibrary, type SyncedRecordingLibrary } from './sync';
import { createRecordingRemote } from './remote';

let shared: { key: string; library: SyncedRecordingLibrary } | null = null;

/**
 * One synchronizer per signed-in account, shared by the recorder (upload right after saving)
 * and the library (refresh button), so the two never upload the same file at the same time.
 */
export function getAccountLibrary(account: Account): SyncedRecordingLibrary {
  const key = [account.api.baseUrl, account.session.teacher.teacher_id, account.session.token].join('\n');
  if (shared?.key !== key) {
    shared = {
      key,
      library: createSyncedLibrary(createRecordingLibrary(createExpoFilePort(account)),
        createRecordingLibrary(createExpoFilePort()), createSyncStore(account), createRecordingRemote(account)),
    };
  }
  return shared.library;
}

export function createLibraryPlatform(account?: Account) {
  const recordings = account ? getAccountLibrary(account) : createRecordingLibrary(createExpoFilePort());
  return { recordings, createPlayer: createExpoLibraryPlayer };
}
