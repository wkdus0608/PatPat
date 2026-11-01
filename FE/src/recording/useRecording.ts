import {
  getRecordingPermissionsAsync, RecordingPresets, setAudioModeAsync, useAudioRecorder,
} from 'expo-audio';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, BackHandler } from 'react-native';
import type { RecorderViewProps } from '../ui/PatPatAppView';
import { createRecordingController, type RecordingController } from './controller';
import { createExpoRecordingStorage } from './expoFileStore';
import { createNativeEngine } from './nativeEngine';

const OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1 };

export function useRecording(): RecorderViewProps {
  const controllerRef = useRef<RecordingController | null>(null);
  const adapterRef = useRef<ReturnType<typeof createNativeEngine> | null>(null);
  const recorder = useAudioRecorder(OPTIONS, (status) => {
    adapterRef.current?.onStatus(status);
    if (status.hasError || status.isFinished) void controllerRef.current?.interrupt();
  });
  const controller = useMemo(() => {
    const adapter = createNativeEngine(recorder, {
      async getPermission() { return (await getRecordingPermissionsAsync()).granted; },
      async setMode(recording) {
        await setAudioModeAsync({
          allowsRecording: recording, playsInSilentMode: true,
          allowsBackgroundRecording: false, shouldPlayInBackground: false,
        });
      },
    });
    adapterRef.current = adapter;
    return createRecordingController(adapter.engine, createExpoRecordingStorage());
  }, [recorder]);
  controllerRef.current = controller;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => {
      controller.poll();
      setClock(new Date());
    }, 250);
    const foreground = AppState.addEventListener('change', (next) => {
      if (next !== 'active') void controller.interrupt();
      else {
        setClock(new Date());
        void controller.refreshSummary();
      }
    });
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      const current = controller.getSnapshot();
      return current.phase === 'recording' || current.phase === 'preparing'
        || current.phase === 'saving' || current.canRetry;
    });
    return () => {
      clearInterval(interval);
      foreground.remove();
      back.remove();
      // useAudioRecorder owns native disposal. Normal app background is handled above.
      void controller.interrupt();
    };
  }, [controller]);

  const dayKey = `${clock.getFullYear()}-${clock.getMonth()}-${clock.getDate()}`;
  useEffect(() => { void controller.refreshSummary(); }, [controller, dayKey]);

  return {
    phase: state.phase, durationMillis: state.durationMillis,
    todayCount: state.todayCount, latestFileName: state.latest?.fileName ?? null,
    message: state.message, summaryError: state.summaryError,
    canStart: state.canStart, canRetry: state.canRetry,
    dateLabel: clock.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }),
    onStart: () => { void controller.start(); },
    onStop: () => { void controller.stop(); },
    onRetry: () => { void controller.retry(); },
    onRefresh: () => { void controller.refreshSummary(); },
  };
}
