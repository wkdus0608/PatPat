import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { errorMessage } from '../api/client';
import type { Journal, JournalEntry, V2Api } from '../api/v2';
import type { Account } from '../auth/controller';
import { colors } from '../ui/theme';
import { WorkButton, WorkField, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';
import { RecordingComingSoon } from './RecordingComingSoon';

type Draft = { text: string; version: number };

function JournalText({ name, value, onClose }: { name: string; value: string; onClose(): void }) {
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);
  const action = useWorkAction();
  const clipboard = Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={[styles.outputPage, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.outputFrame}>
          <View style={workStyles.between}>
            <Text style={workStyles.heading}>{name} 관찰일지</Text>
            <WorkButton label="닫기" secondary onPress={onClose} />
          </View>
          <ScrollView style={styles.outputScroll} contentContainerStyle={workStyles.panel}>
            <Text selectable style={workStyles.body}>{value}</Text>
          </ScrollView>
          {clipboard && <WorkButton label="텍스트 복사" busy={action.busy} onPress={() => { void action.run(async () => {
            await clipboard.writeText(value);
            setCopied(true);
          }); }} />}
          {copied && <WorkMessage>복사했어요.</WorkMessage>}
          {action.error && <WorkMessage error>{action.error}</WorkMessage>}
        </View>
      </View>
    </Modal>
  );
}

function JournalCard({ journal, api, onSaved }: {
  journal: Journal; api: V2Api; onSaved(childId: string, entry: JournalEntry): void;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [output, setOutput] = useState<string | null>(null);
  const action = useWorkAction();
  const { child, items } = journal;
  const hasOutput = items.some(entry => entry.included && (entry.status === 'ready' || entry.status === 'edited'));

  async function save() {
    for (const entry of items) {
      const draft = drafts[entry.entry_id];
      if (draft && draft.text !== entry.content && !draft.text.trim()) {
        action.setError('관찰내용을 입력해 주세요.');
        return;
      }
    }
    for (const entry of items) {
      const draft = drafts[entry.entry_id];
      if (!draft || draft.text === entry.content) continue;
      const stored = await api.saveJournalEntry(entry.entry_id, draft.text, draft.version);
      onSaved(child.child_id, stored);
      setDrafts(old => {
        const remaining = { ...old };
        delete remaining[entry.entry_id];
        return remaining;
      });
    }
    setEditing(false);
    setDrafts({});
  }

  return (
    <View style={workStyles.panel}>
      <Text style={workStyles.title}>{child.name}</Text>
      {items.length === 0 && <WorkMessage>확정한 알림장에서 관찰일지가 쌓여요.</WorkMessage>}
      {items.map(entry => (
        <View key={entry.entry_id} style={styles.entry}>
          <Text style={workStyles.label}>{entry.observed_date}</Text>
          {!!(entry.place || entry.time_text || entry.areas.length) &&
            <WorkMessage>{[entry.place, entry.time_text, ...entry.areas].filter(Boolean).join(' · ')}</WorkMessage>}
          {entry.status === 'pending' ? <WorkMessage>관찰일지를 만들고 있어요.</WorkMessage>
            : editing ? <WorkField label="관찰내용" value={drafts[entry.entry_id]?.text ?? entry.content}
              editable={!action.busy} multiline maxLength={3000} onChangeText={text => setDrafts(old => ({
                ...old, [entry.entry_id]: { text, version: old[entry.entry_id]?.version ?? entry.version },
              }))} />
              : entry.status === 'failed' ? <WorkMessage error>관찰일지를 만들지 못했어요. 수정하기에서 내용을 입력할 수 있어요.</WorkMessage>
                : <Text selectable style={workStyles.body}>{entry.content}</Text>}
        </View>
      ))}
      {action.error && <WorkMessage error>{action.error}</WorkMessage>}
      <View style={workStyles.row}>
        {editing ? <>
          <WorkButton label="수정 저장" busy={action.busy} onPress={() => { void action.run(save); }} />
          <WorkButton label="취소" secondary disabled={action.busy} onPress={() => {
            setDrafts({});
            setEditing(false);
            action.setError(null);
          }} />
        </> : <>
          <WorkButton label="출력하기" busy={action.busy} disabled={!hasOutput} onPress={() => {
            void action.run(async () => setOutput(await api.journalText(child.child_id)));
          }} />
          <WorkButton label="수정하기" secondary disabled={action.busy || !items.some(entry => entry.status !== 'pending')}
            onPress={() => { action.setError(null); setEditing(true); }} />
        </>}
      </View>
      {output !== null && <JournalText name={child.name} value={output} onClose={() => setOutput(null)} />}
    </View>
  );
}

export function JournalWorkspace({ api, account, active, rosterVersion }: {
  api: V2Api; account: Account; active: boolean; rosterVersion: number;
}) {
  const [journals, setJournals] = useState<Journal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const legacy = account.api;
  const token = account.session.token;
  const unauthorized = account.unauthorized;
  useEffect(() => {
    if (!active) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const roster = await legacy.listChildren(token);
        if (!current) return;
        const values = await Promise.all(roster.map(child => api.journal(child.child_id)));
        if (!current) return;
        setJournals(previous => values.map(value => {
          const old = previous?.find(journal => journal.child.child_id === value.child.child_id);
          const versions = new Map(old?.items.map(item => [item.entry_id, item]));
          return { ...value, items: value.items.map(entry => {
            const latest = versions.get(entry.entry_id);
            return latest && latest.version > entry.version ? latest : entry;
          }) };
        }));
        setError(null);
        if (values.some(value => value.items.some(entry => entry.status === 'pending'))) {
          timer = setTimeout(() => { void load(); }, 1400);
        }
      } catch (failure) {
        if (!current) return;
        unauthorized(failure);
        setError(errorMessage(failure));
      }
    }
    setError(null);
    void load();
    return () => { current = false; clearTimeout(timer); };
  }, [active, api, legacy, token, unauthorized, rosterVersion, attempt]);

  function updateEntry(childId: string, entry: JournalEntry) {
    setJournals(values => values?.map(journal => journal.child.child_id === childId
      ? { ...journal, items: journal.items.map(item => item.entry_id === entry.entry_id ? entry : item) }
      : journal) ?? null);
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={workStyles.content}>
      {error && <WorkMessage error>{error}</WorkMessage>}
      {!journals && !error && <ActivityIndicator color={colors.ink} accessibilityLabel="관찰일지 불러오는 중" />}
      {journals?.length === 0 && <WorkMessage>설정에서 아동을 등록해 주세요.</WorkMessage>}
      {journals?.map(journal => <JournalCard key={journal.child.child_id} journal={journal} api={api} onSaved={updateEntry} />)}
      {error && <WorkButton label="다시 불러오기" secondary onPress={() => setAttempt(value => value + 1)} />}
      <RecordingComingSoon />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  entry: { paddingVertical: 11, borderTopWidth: 1, borderTopColor: colors.line, gap: 5 },
  outputPage: { flex: 1, backgroundColor: colors.background },
  outputFrame: { flex: 1, width: '100%', maxWidth: 540, alignSelf: 'center', paddingHorizontal: 22, gap: 12 },
  outputScroll: { flex: 1 },
});
