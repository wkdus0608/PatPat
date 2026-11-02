import { forwardRef, useEffect, useImperativeHandle, useMemo, useSyncExternalStore } from 'react';
import { createLibraryPlatform } from '../library/platform';
import { createWritingController } from './controller';
import { createTextSharing } from './sharing';
import type { WritingActions, WritingServices } from './types';
import { WritingView } from './WritingView';

export interface WritingHandle {
  back(): void;
  leave(): Promise<boolean>;
}

const noServices: WritingServices = {};

/** Remains mounted across tabs so unfinished FE edits are not discarded. */
export const WritingScreen = forwardRef<WritingHandle, {
  services?: WritingServices;
  onGoToRecording(): void;
}>(function WritingScreen({ services = noServices, onGoToRecording }, ref) {
  const controller = useMemo(() => createWritingController(createLibraryPlatform().recordings,
    { ...services, sharing: services.sharing ?? createTextSharing() }), [services]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);
  useImperativeHandle(ref, () => ({
    back() {
      if (controller.getSnapshot().route === 'picker') controller.cancelPicker();
      else onGoToRecording();
    },
    leave: controller.leave,
  }), [controller, onGoToRecording]);
  const actions: WritingActions = {
    openPicker() { void controller.openPicker(); },
    refreshRecordings() { void controller.refreshRecordings(); },
    cancelPicker: controller.cancelPicker,
    toggleRecording: controller.toggleRecording,
    importRecordings() { void controller.importRecordings(); },
    removeRecording: controller.removeRecording,
    generate: controller.generate,
    selectRecord: controller.selectRecord,
    editText: controller.editText,
    editPrompt: controller.editPrompt,
    revise() { void controller.revise(); },
    dismissCandidate: controller.dismissCandidate,
    applyCandidate: controller.applyCandidate,
    confirm() { void controller.confirm(); },
    share() { void controller.share(); },
    resolveGuard: controller.resolveGuard,
  };
  return <WritingView state={state} capabilities={controller.capabilities} actions={actions} />;
});
