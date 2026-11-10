import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ApiError, uploadWebRecording } from '../api/client';
import type { Account } from '../auth/controller';
import { serverItem } from '../library/sync';
import type { RecorderViewProps } from '../ui/PatPatAppView';
import { createRecordingController, type RecordingEngine } from './controller';
import { describeRecording, formatDateKey, MAX_RECORDINGS_PER_MINUTE } from './files';
import { RecordingStorageError, type RecordingStorage } from './storage';

function webRecordingFormat() {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return undefined;
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
}

function createWebRecorder(account: Account | undefined, format: string | undefined) {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let finished: Promise<Blob | null> | null = null;
  let started = 0;
  let stopped = 0;
  let generation = 0;
  let pending: { key: string; blob: Blob } | null = null;
  let upload: AbortController | null = null;
  let previousMinute = '';
  let sequence = 0;

  function release(active = stream) {
    active?.getTracks().forEach(track => track.stop());
    if (stream === active) stream = null;
  }

  const engine: RecordingEngine = {
    async prepare() {
      const version = generation;
      try {
        const active = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (version !== generation) { release(active); throw new Error('Recording cancelled'); }
        stream = active;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          throw new RecordingStorageError('PERMISSION', '브라우저에서 마이크 접근을 허용한 뒤 다시 시도해 주세요.');
        }
        throw error;
      }
    },
    async start() {
      if (!stream || !format) throw new Error('Microphone unavailable');
      const active = stream;
      const recording = new MediaRecorder(active, { mimeType: format });
      recorder = recording;
      const chunks: Blob[] = [];
      started = performance.now();
      stopped = 0;
      finished = new Promise(resolve => {
        recording.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recording.onstop = () => {
          if (recorder === recording) stopped ||= performance.now();
          release(active);
          resolve(new Blob(chunks, { type: format.split(';')[0] }));
        };
        recording.onerror = () => { release(active); resolve(null); };
      });
      recording.start();
    },
    async stop() {
      if (recorder?.state === 'recording') {
        stopped = performance.now();
        recorder.stop();
      }
      const durationMillis = (stopped || performance.now()) - started;
      const blob = await finished;
      if (!blob?.size) return { uri: null, durationMillis };
      pending = { blob, key: crypto.randomUUID() };
      return { uri: pending.key, durationMillis };
    },
    async cancelPreparation() { release(); },
    getStatus: () => ({ isRecording: recorder?.state === 'recording', durationMillis: performance.now() - started }),
  };

  const storage: RecordingStorage = {
    async assertAvailable() {
      if (!account || !format) throw new RecordingStorageError('PERMISSION', '이 브라우저에서 마이크를 사용할 수 없어요.');
    },
    async save(source, startedAt, durationMillis = 0) {
      if (!account || !pending || pending.key !== source) {
        throw new RecordingStorageError('EMPTY', '저장할 녹음이 없어요.');
      }
      const { blob, key } = pending;
      const first = describeRecording(startedAt).fileName;
      if (previousMinute !== first) { previousMinute = first; sequence = 0; }
      const fileName = describeRecording(startedAt, Math.min(sequence + 1, MAX_RECORDINGS_PER_MINUTE)).fileName
        .replace(/\.m4a$/, blob.type === 'audio/webm' ? '.webm' : '.m4a');
      const form = new FormData();
      form.append('file', blob, fileName);
      form.append('title', fileName);
      form.append('recorded_at', startedAt.toISOString());
      form.append('duration_seconds', String(Math.max(durationMillis, 1) / 1000));
      upload = new AbortController();
      try {
        const row = await uploadWebRecording(account.api.baseUrl, account.session.token, form, key, upload.signal);
        pending = null;
        sequence += 1;
        return serverItem(row);
      } catch (error) {
        account.unauthorized(error);
        if (error instanceof ApiError && (error.status === 413 || error.status === 415)) {
          pending = null;
          throw new RecordingStorageError('FORMAT', error.status === 413
            ? '녹음 파일이 너무 커요. 짧게 나누어 녹음해 주세요.' : '이 녹음은 재생할 수 없어요. 다시 녹음해 주세요.');
        }
        throw new RecordingStorageError('IO', '서버에 녹음을 저장하지 못했어요. 연결을 확인하고 다시 저장해 주세요.');
      } finally { upload = null; }
    },
    async getSummary(now) {
      if (!account) return { todayCount: 0, latest: null };
      const { items, total } = await account.api.listRecordings(account.session.token, 0, formatDateKey(now));
      return { todayCount: total, latest: items.length ? serverItem(items[0]) : null };
    },
  };

  return {
    controller: createRecordingController(engine, storage),
    dispose() {
      generation++;
      upload?.abort();
      if (recorder?.state === 'recording') recorder.stop();
      release();
      recorder = null;
      finished = null;
      pending = null;
    },
  };
}

export function useRecording(account?: Account): RecorderViewProps {
  const format = webRecordingFormat();
  const { controller, dispose } = useMemo(() => createWebRecorder(account, format),
    [account?.api, account?.session.token, format]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => { controller.poll(); setClock(new Date()); }, 250);
    return () => { clearInterval(timer); dispose(); };
  }, [controller, dispose]);

  return {
    phase: state.phase, durationMillis: state.durationMillis,
    message: !format ? '이 브라우저에서는 녹음을 사용할 수 없어요. 마이크를 지원하는 브라우저에서 열어 주세요.'
      : state.phase === 'saved' ? '서버에 저장했어요. 같은 계정의 보관함에서 다시 들을 수 있어요.' : state.message,
    canStart: !!account && !!format && state.canStart, canRetry: state.canRetry,
    dateLabel: clock.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }),
    onStart: () => { void controller.start(); },
    onStop: () => { void controller.stop(); },
    onRetry: () => { void controller.retry(); },
  };
}
