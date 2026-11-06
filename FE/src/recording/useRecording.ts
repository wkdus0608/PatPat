import {
  getRecordingPermissionsAsync, requestRecordingPermissionsAsync, RecordingPresets, setAudioModeAsync, useAudioRecorder,
} from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, BackHandler } from 'react-native';
import type { RecorderViewProps } from '../ui/PatPatAppView';
import { createRecordingController, type RecordingController } from './controller';
import { createExpoRecordingStorage } from './expoFileStore';
import { createNativeEngine } from './nativeEngine';
import type { Account } from '../auth/controller';
import { backgroundRecordingSupported } from './backgroundMode';
import { ensureMicrophonePermission } from './permissions';
import { startRequestInbox } from './startRequest';
import { getAccountLibrary } from '../library/platform';

const OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1 };
const RETRY_FIRST_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;

type UploadState = 'idle' | 'uploading' | 'done' | 'failed';

function savedMessage(upload: UploadState, signedIn: boolean): string {
  if (!signedIn) return '기기에 저장했어요.';
  if (upload === 'done') return '기기와 서버에 모두 저장했어요.';
  if (upload === 'failed') return '기기에 저장했어요. 서버에 연결되면 자동으로 저장해요.';
  return '기기에 저장했어요. 서버에도 저장하고 있어요.';
}

export function useRecording(account?: Account): RecorderViewProps {
  const controllerRef = useRef<RecordingController | null>(null);
  const adapterRef = useRef<ReturnType<typeof createNativeEngine> | null>(null);
  const recorder = useAudioRecorder(OPTIONS, (status) => {
    adapterRef.current?.onStatus(status);
    if (status.hasError || status.isFinished) void controllerRef.current?.interrupt();
  });
  const [upload, setUpload] = useState<UploadState>('idle');
  const [startSignal, setStartSignal] = useState(0);
  const alive = useRef(true);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay = useRef(RETRY_FIRST_MS);
  const library = useMemo(
    () => (account ? getAccountLibrary(account) : null),
    [account?.api, account?.session.teacher.teacher_id, account?.session.token],
  );

  /** Upload anything still on the device. On failure retry later, backing off up to 5 minutes. */
  const syncNow = useCallback(async () => {
    if (!library) return;
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    setUpload('uploading');
    const result = await library.autoSync();
    if (!alive.current) return;
    if (result.failed || result.remaining > 0) {
      setUpload('failed');
      retryTimer.current = setTimeout(() => { void syncNow(); }, retryDelay.current);
      retryDelay.current = Math.min(retryDelay.current * 2, RETRY_MAX_MS);
    } else {
      retryDelay.current = RETRY_FIRST_MS;
      setUpload('done');
    }
  }, [library]);
  const syncRef = useRef(syncNow);
  syncRef.current = syncNow;

  const controller = useMemo(() => {
    const adapter = createNativeEngine(recorder, {
      getPermission() {
        return ensureMicrophonePermission({ read: getRecordingPermissionsAsync, request: requestRecordingPermissionsAsync });
      },
      async setMode(recording) {
        await setAudioModeAsync({
          allowsRecording: recording, playsInSilentMode: true,
          allowsBackgroundRecording: recording && backgroundRecordingSupported, shouldPlayInBackground: false,
        });
      },
    });
    adapterRef.current = adapter;
    return createRecordingController(adapter.engine, createExpoRecordingStorage(account, () => { void syncRef.current(); }));
  }, [recorder, account?.api, account?.session.teacher.teacher_id]);
  controllerRef.current = controller;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [clock, setClock] = useState(() => new Date());

  // Side-button request (iPhone Siri / Galaxy shortcut): show the recording screen and start.
  // `start()` ignores the call when a recording is already running or an unsaved one is waiting.
  useEffect(() => {
    const consume = () => {
      if (!startRequestInbox.take()) return;
      setStartSignal((value) => value + 1);
      void controllerRef.current?.start();
    };
    consume(); // A request that arrived before sign-in finished.
    return startRequestInbox.subscribe(consume);
  }, []);

  // Flush recordings left from earlier sessions, and stop timers when the screen goes away.
  useEffect(() => {
    alive.current = true;
    void syncNow();
    return () => {
      alive.current = false;
      if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    };
  }, [syncNow]);

  useEffect(() => {
    const interval = setInterval(() => {
      controller.poll();
      setClock(new Date());
    }, 250);
    const foreground = AppState.addEventListener('change', (next) => {
      // With background recording (development/production builds) leaving the screen keeps recording.
      // In Expo Go it cannot, so stop and save. iOS permission prompts can briefly make the app inactive.
      if (!backgroundRecordingSupported
        && (next === 'background' || (next === 'inactive' && controller.getSnapshot().phase === 'recording'))) void controller.interrupt();
      else if (next === 'active') {
        setClock(new Date());
        retryDelay.current = RETRY_FIRST_MS;
        void syncRef.current();
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

  return {
    phase: state.phase, durationMillis: state.durationMillis,
    message: state.phase === 'saved' ? savedMessage(upload, !!account) : state.message,
    canStart: state.canStart, canRetry: state.canRetry, startSignal,
    dateLabel: clock.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }),
    onStart: () => { void controller.start(); },
    onStop: () => { void controller.stop(); },
    onRetry: () => { void controller.retry(); },
  };
}
