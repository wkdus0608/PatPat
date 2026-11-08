import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { V2Api } from '../api/v2';
import type { Account } from '../auth/controller';
import { WorkChoice, workStyles } from '../ui/WorkFields';
import { JournalWorkspace } from './JournalWorkspace';
import { NoticeWorkspace } from './NoticeWorkspace';
import type { WritingHandle } from './WritingScreen';

export const DailyWritingScreen = forwardRef<WritingHandle, {
  account: Account; api: V2Api; active: boolean; rosterVersion: number; onGoToRecording(): void;
}>(function DailyWritingScreen({ account, api, active, rosterVersion, onGoToRecording }, ref) {
  const [mode, setMode] = useState<'알림장' | '관찰일지'>('알림장');
  const [journalVersion, setJournalVersion] = useState(0);
  const onJournalUpdated = useCallback(() => setJournalVersion(version => version + 1), []);
  useEffect(() => { if (active) setMode('알림장'); }, [active]);
  useImperativeHandle(ref, () => ({
    back() {
      if (mode === '관찰일지') setMode('알림장');
      else onGoToRecording();
    },
    async leave() { return true; },
  }), [mode, onGoToRecording]);

  return (
    <View style={styles.workspace}>
      <View style={styles.modes}>
        <Text style={workStyles.heading}>일지 작성</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="기록 유형" style={workStyles.row}>
          <WorkChoice label="알림장" selected={mode === '알림장'} onPress={() => setMode('알림장')} />
          <WorkChoice label="관찰일지" selected={mode === '관찰일지'} onPress={() => setMode('관찰일지')} />
        </View>
      </View>
      <View style={[styles.workspace, mode !== '알림장' && styles.hidden]}>
        <NoticeWorkspace api={api} active={active && mode === '알림장'} rosterVersion={rosterVersion} onJournalUpdated={onJournalUpdated} />
      </View>
      <View style={[styles.workspace, mode !== '관찰일지' && styles.hidden]}>
        <JournalWorkspace account={account} api={api} active={active && mode === '관찰일지'} rosterVersion={rosterVersion}
          journalVersion={journalVersion} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  workspace: { flex: 1 },
  hidden: { display: 'none' },
  modes: { paddingHorizontal: 22, paddingBottom: 6, gap: 9 },
});
