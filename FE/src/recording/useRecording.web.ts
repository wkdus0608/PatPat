import { useEffect, useState } from 'react';
import type { RecorderViewProps } from '../ui/PatPatAppView';

/** Browser preview renders the real UI; it never simulates a successful recording. */
export function useRecording(): RecorderViewProps {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  return {
    phase: 'idle', durationMillis: 0, todayCount: null, latestFileName: null,
    message: '화면 미리보기예요. 녹음과 파일 저장은 Android·iOS 앱에서 사용할 수 있어요.',
    summaryError: '기기에 저장된 녹음은 모바일 앱에서 확인할 수 있어요.',
    canStart: false, canRetry: false,
    dateLabel: clock.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }),
    onStart() {}, onStop() {}, onRetry() {}, onRefresh() { setClock(new Date()); },
  };
}
