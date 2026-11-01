import { forwardRef, useEffect, useImperativeHandle, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { createLibraryController } from './controller';
import { createLibraryPlatform } from './platform';
import { LibraryView } from './LibraryView';
import type { JournalSource, LibraryActions } from './types';

export interface LibraryHandle {
  back(): void;
  leave(): Promise<boolean>;
}

export const LibraryScreen = forwardRef<LibraryHandle, {
  onGoToRecording(): void;
  journalSource?: JournalSource;
}>(function LibraryScreen({ onGoToRecording, journalSource }, ref) {
  const controller = useMemo(() => {
    const platform = createLibraryPlatform();
    return createLibraryController(platform.recordings, platform.createPlayer, journalSource);
  }, [journalSource]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useImperativeHandle(ref, () => ({
    back() { if (controller.getSnapshot().route === 'home') onGoToRecording(); else void controller.back(); },
    leave: controller.leave,
  }), [controller, onGoToRecording]);
  useEffect(() => {
    const interval = setInterval(controller.poll, 250);
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void controller.resume();
      else void controller.suspend();
    });
    return () => { clearInterval(interval); subscription.remove(); controller.dispose(); };
  }, [controller]);
  const actions: LibraryActions = {
    showRecordings() { void controller.showRecordings(); },
    showJournals() { void controller.showJournals(); },
    openRecording(recording) { void controller.openRecording(recording); },
    openJournal(journal) { void controller.openJournal(journal); },
    back() { void controller.back(); }, refresh() { void controller.refresh(); },
    togglePlay() { void controller.togglePlay(); }, restart() { void controller.restart(); },
    retryPlayback() { void controller.retryPlayback(); },
    requestDelete() { void controller.requestDelete(); }, cancelDelete: controller.cancelDelete,
    confirmDelete() { void controller.confirmDelete(); },
  };
  return <LibraryView state={state} actions={actions} onGoToRecording={onGoToRecording} />;
});
