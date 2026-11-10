import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account } from '../auth/controller';
import { ImportError } from './importCommon';
import { importAudioFile } from './importAudio';

/** 녹음 화면의 '녹음 파일 올리기' 상태. */
export function useAudioImport(account?: Account) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = useCallback(async () => {
    if (!account || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const uploaded = await importAudioFile(account);
      if (alive.current && uploaded) setResult({ text: '녹음 파일을 서버에 저장했어요. 보관함에서 확인할 수 있어요.', error: false });
    } catch (error) {
      const text = error instanceof ImportError ? error.message : '녹음 파일을 올리지 못했어요. 다시 시도해 주세요.';
      if (alive.current) setResult({ text, error: true });
    } finally { if (alive.current) setBusy(false); }
  }, [account, busy]);
  return { busy, result, run, clear: () => setResult(null) };
}
