import type { RecordingEngine } from './controller';
import { RecordingStorageError } from './storage';

/** The subset of the Expo recorder used by the recording coordinator. */
export interface NativeRecorder {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(): void;
  stop(): Promise<void>;
  getStatus(): { isRecording: boolean; durationMillis: number };
}

export interface NativeEnginePorts {
  /** Read permission only. This adapter never requests microphone access. */
  getPermission(): Promise<boolean>;
  setMode(recording: boolean): Promise<void>;
  wait?(milliseconds: number): Promise<void>;
}

export interface NativeRecordingStatus {
  hasError: boolean;
  isFinished: boolean;
}

/** Keep SDK events separate from React so native failure paths can be tested. */
export function createNativeEngine(recorder: NativeRecorder, ports: NativeEnginePorts) {
  const wait = ports.wait ?? ((milliseconds: number) => new Promise<void>(
    (resolve) => setTimeout(resolve, milliseconds),
  ));
  let lastDuration = 0;
  let nativeError = false;

  function onStatus(status: NativeRecordingStatus): void {
    // Android may resolve stop() and report encoder failure through an event.
    // A later successful stop event must not make that file valid again.
    if (status.hasError) nativeError = true;
  }

  function readStatus() {
    const status = recorder.getStatus();
    lastDuration = Math.max(lastDuration, status.durationMillis);
    return { isRecording: status.isRecording, durationMillis: lastDuration };
  }

  const engine: RecordingEngine = {
    async prepare() {
      if (!(await ports.getPermission())) throw new Error('Microphone is not available');
      nativeError = false;
      lastDuration = 0;
      await ports.setMode(true);
      await recorder.prepareToRecordAsync();
    },
    async start() {
      recorder.record();
      // The native recorder can settle after record() returns. Wait at most 500 ms.
      for (let elapsed = 0; elapsed <= 500; elapsed += 50) {
        if (nativeError) throw new Error('Native recording failed');
        if (readStatus().isRecording) return;
        if (elapsed < 500) await wait(50);
      }
      throw new Error('Recorder did not start');
    },
    async stop() {
      try { readStatus(); } catch { /* Still attempt to stop if status polling fails. */ }
      try {
        await recorder.stop();
      } catch (error) {
        // An OS interruption can have stopped the recorder before this call.
        // Suppress that error only when recording ended and a file is available.
        if (readStatus().isRecording || !recorder.uri) throw error;
      }
      // Let an already-dispatched native completion/error event reach onStatus.
      await wait(0);
      const uri = recorder.uri;
      try { await ports.setMode(false); } catch { /* Preserve the file/error result. */ }
      if (nativeError) {
        throw new RecordingStorageError(
          'EMPTY', '녹음이 정상적으로 마무리되지 않았어요. 다시 녹음해 주세요.',
        );
      }
      return { uri, durationMillis: lastDuration };
    },
    async cancelPreparation() {
      try { await recorder.stop(); } finally {
        await ports.setMode(false);
      }
    },
    getStatus: readStatus,
  };

  return { engine, onStatus };
}
