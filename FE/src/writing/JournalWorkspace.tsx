import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError, errorMessage } from '../api/client';
import type { DateRange, Journal, JournalDay, JournalDayEdit, JournalEntry, JournalOutput, V2Api } from '../api/v2';
import type { Account } from '../auth/controller';
import { colors } from '../ui/theme';
import { copyRecord } from '../ui/clipboard';
import { DatePicker } from '../ui/DatePicker';
import { WorkButton, WorkField, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';
import { saveWordFile } from './wordFiles';

type Draft = JournalDayEdit & { original: string };

function JournalText({ name, output, download, onClose }: {
  name: string; output: JournalOutput; download(): Promise<ArrayBuffer>; onClose(): void;
}) {
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);
  const action = useWorkAction();
  const wordAction = useWorkAction();
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={[styles.outputPage, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.outputFrame}>
          <View style={workStyles.between}>
            <Text style={workStyles.heading}>{name} 관찰일지</Text>
            <WorkButton label="닫기" secondary disabled={wordAction.busy} onPress={onClose} />
          </View>
          <ScrollView style={styles.outputScroll} contentContainerStyle={workStyles.panel}>
            <Text selectable style={workStyles.body}>{output.text}</Text>
          </ScrollView>
          <View style={styles.outputActions}>
            <View style={styles.outputAction}>
              <WorkButton label="텍스트 복사" busy={action.busy} onPress={() => { void action.run(async () => {
                await copyRecord(output.text);
                setCopied(true);
              }); }} />
            </View>
            <View style={styles.outputAction}>
              <WorkButton label="Word로 출력하기" busy={wordAction.busy} disabled={!output.can_export_word}
                onPress={() => { void wordAction.run(async () => saveWordFile(await download(), name)); }} />
            </View>
          </View>
          {wordAction.busy && <WorkMessage>Word 파일을 준비하고 있어요.</WorkMessage>}
          {copied && <WorkMessage>복사했어요.</WorkMessage>}
          {action.error && <WorkMessage error>{action.error}</WorkMessage>}
          {wordAction.error && <WorkMessage error>{wordAction.error}</WorkMessage>}
        </View>
      </View>
    </Modal>
  );
}

function JournalCard({ journal, api, range, onEditing, onSaved, onOutput, onReload }: {
  journal: Journal; api: V2Api; range: DateRange;
  onEditing(childId: string, editing: boolean): void; onSaved(childId: string, days: JournalDay[]): void;
  onOutput(childId: string, output: JournalOutput): void; onReload(): void;
}) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [output, setOutput] = useState<JournalOutput | null>(null);
  const action = useWorkAction();
  const { child, items } = journal;
  const days = journal.days ?? [];
  const editing = drafts !== null;
  useEffect(() => {
    onEditing(child.child_id, editing || action.busy);
    return () => onEditing(child.child_id, false);
  }, [child.child_id, editing, action.busy, onEditing]);

  function startEditing() {
    action.setError(null);
    setDrafts(days.filter(day => day.editable).map(day => ({
      observed_date: day.observed_date, content: day.content, original: day.content, expected_revision: day.revision,
    })));
  }

  async function save(current: Draft[]) {
    const changes = current.filter(draft => draft.content !== draft.original)
      .map(({ observed_date, content, expected_revision }) => ({ observed_date, content, expected_revision }));
    const empty = changes.find(day => !day.content.trim());
    if (empty) {
      action.setError(empty.observed_date + '의 관찰내용을 입력해 주세요.');
      return;
    }
    if (changes.length > 0) {
      try {
        onSaved(child.child_id, await api.saveJournalDays(child.child_id, changes));
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === 'VERSION_CONFLICT') onReload();
        throw failure;
      }
    }
    setDrafts(null);
  }

  const entriesByDate = new Map<string, JournalEntry[]>();
  for (const entry of items) {
    const entries = entriesByDate.get(entry.observed_date);
    if (entries) entries.push(entry);
    else entriesByDate.set(entry.observed_date, [entry]);
  }
  const editedDays = new Map(days.filter(day => day.edit_version > 0).map(day => [day.observed_date, day]));

  return (
    <View style={workStyles.panel}>
      <Text style={workStyles.title}>{child.name}</Text>
      {items.length === 0 && <WorkMessage>이 기간에 표시할 관찰일지가 없어요.</WorkMessage>}
      {drafts ? drafts.map(draft => (
        <View key={draft.observed_date} style={styles.entry}>
          <WorkField label={draft.observed_date} accessibilityLabel={child.name + ' ' + draft.observed_date + ' 관찰내용'}
            style={styles.dayInput} value={draft.content} multiline editable={!action.busy}
            onChangeText={content => setDrafts(current => current?.map(day =>
              day.observed_date === draft.observed_date ? { ...day, content } : day) ?? null)} />
        </View>
      )) : Array.from(entriesByDate, ([date, entries]) => {
        const edited = editedDays.get(date);
        const metadata = edited && [edited.places.join(', '), edited.times.join(', ')].filter(Boolean).join(' · ');
        return <View key={date} style={styles.entry}>
          <Text style={workStyles.label}>{date}</Text>
          {edited && <View style={styles.observation}>
            {edited.areas.length > 0 && <WorkMessage>관찰영역 · {edited.areas.join(', ')}</WorkMessage>}
            {!!metadata && <WorkMessage>{metadata}</WorkMessage>}
            <Text selectable style={workStyles.body}>{edited.content}</Text>
          </View>}
          {entries.filter(entry => !edited || entry.is_draft).map(entry => (
            <View key={entry.entry_id} style={styles.observation}>
              {entry.is_draft && <WorkMessage>초안</WorkMessage>}
              {entry.areas.length > 0 && <WorkMessage>관찰영역 · {entry.areas.join(', ')}</WorkMessage>}
              {!!(entry.place || entry.time_text) &&
                <WorkMessage>{[entry.place, entry.time_text].filter(Boolean).join(' · ')}</WorkMessage>}
              {entry.status === 'pending' ? <WorkMessage>관찰일지를 만들고 있어요.</WorkMessage>
                : entry.status === 'failed' ? <WorkMessage error>관찰일지를 만들지 못했어요. 수정하기에서 내용을 입력할 수 있어요.</WorkMessage>
                  : <Text selectable style={workStyles.body}>{entry.content}</Text>}
            </View>
          ))}
        </View>;
      })}
      {action.error && <WorkMessage error>{action.error}</WorkMessage>}
      <View style={[workStyles.row, styles.cardActions]}>
        {drafts ? <>
          <WorkButton label="수정 저장" busy={action.busy} onPress={() => { void action.run(() => save(drafts)); }} />
          <WorkButton label="취소" secondary disabled={action.busy} onPress={() => {
            setDrafts(null);
            action.setError(null);
          }} />
        </> : <>
          <WorkButton label={journal.output_stale ? '재출력하기' : '출력하기'} busy={action.busy}
            disabled={!days.some(day => day.content.trim())} onPress={() => {
            void action.run(async () => {
              const result = await api.journalOutput(child.child_id, range);
              onOutput(child.child_id, result);
              setOutput(result);
            });
          }} />
          <WorkButton label="수정하기" secondary disabled={action.busy || !days.some(day => day.editable)} onPress={startEditing} />
        </>}
      </View>
      {output && <JournalText name={child.name} output={output}
        download={() => api.journalWord(child.child_id, range, output.revision)} onClose={() => setOutput(null)} />}
    </View>
  );
}

export function JournalWorkspace({ api, account, active, rosterVersion, journalVersion }: {
  api: V2Api; account: Account; active: boolean; rosterVersion: number; journalVersion: number;
}) {
  const [journals, setJournals] = useState<Journal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [range, setRange] = useState<DateRange>({ from: null, to: null });
  const [editingIds, setEditingIds] = useState<string[]>([]);
  const localSaves = useRef(0);
  const legacy = account.api;
  const token = account.session.token;
  const unauthorized = account.unauthorized;
  const onEditing = useCallback((id: string, editing: boolean) => {
    setEditingIds(ids => editing
      ? ids.includes(id) ? ids : [...ids, id]
      : ids.includes(id) ? ids.filter(value => value !== id) : ids);
  }, []);
  useEffect(() => {
    if (!active) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      const saveCount = localSaves.current;
      try {
        const roster = await legacy.listChildren(token);
        if (!current) return;
        const values = await Promise.all(roster.map(child => api.journal(child.child_id, range)));
        if (!current) return;
        if (saveCount !== localSaves.current) {
          timer = setTimeout(() => { void load(); }, 0);
          return;
        }
        setJournals(values.map(value => ({ ...value, days: value.days ?? [] })));
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
  }, [active, api, legacy, token, unauthorized, rosterVersion, journalVersion, attempt, range]);

  function updateDays(childId: string, days: JournalDay[]) {
    localSaves.current += 1;
    const saved = new Map(days.map(day => [day.observed_date, day]));
    setJournals(values => values?.map(journal => journal.child.child_id === childId
      ? { ...journal, days: journal.days.map(day => saved.get(day.observed_date) ?? day), output_stale: !!journal.output_revision }
      : journal) ?? null);
  }
  function updateOutput(childId: string, output: JournalOutput) {
    localSaves.current += 1;
    setJournals(values => values?.map(journal => journal.child.child_id === childId
      ? { ...journal, output_revision: output.revision, output_stale: false } : journal) ?? null);
  }
  function changeRange(next: DateRange) {
    if (next.from === range.from && next.to === range.to) return;
    setJournals(null);
    setRange(next);
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={workStyles.content}>
      <View style={styles.metadataRow}>
        <View style={styles.dateField}><DatePicker label="시작 날짜" value={range.from} max={range.to ?? undefined}
          disabled={editingIds.length > 0} onChange={from => changeRange({ ...range, from })} /></View>
        <View style={styles.dateField}><DatePicker label="종료 날짜" value={range.to} min={range.from ?? undefined}
          disabled={editingIds.length > 0} onChange={to => changeRange({ ...range, to })} /></View>
      </View>
      {error && <WorkMessage error>{error}</WorkMessage>}
      {!journals && !error && <ActivityIndicator color={colors.ink} accessibilityLabel="관찰일지 불러오는 중" />}
      {journals?.length === 0 && <WorkMessage>설정에서 아동을 등록해 주세요.</WorkMessage>}
      {journals?.map(journal => <JournalCard key={journal.child.child_id} journal={journal} api={api}
        range={range} onEditing={onEditing} onSaved={updateDays} onOutput={updateOutput} onReload={() => setAttempt(value => value + 1)} />)}
      {error && <WorkButton label="다시 불러오기" secondary onPress={() => setAttempt(value => value + 1)} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  entry: { paddingVertical: 11, borderTopWidth: 1, borderTopColor: colors.line, gap: 10 },
  observation: { gap: 4 },
  dayInput: { minHeight: 126 },
  metadataRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  dateField: { flex: 1, minWidth: 115 },
  outputPage: { flex: 1, backgroundColor: colors.background },
  outputFrame: { flex: 1, width: '100%', maxWidth: 540, alignSelf: 'center', paddingHorizontal: 22, gap: 12 },
  outputScroll: { flex: 1 },
  cardActions: { justifyContent: 'flex-end' },
  outputActions: { flexDirection: 'row', gap: 8 },
  outputAction: { flex: 1 },
});
