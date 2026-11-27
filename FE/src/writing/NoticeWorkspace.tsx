import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError } from '../api/client';
import { OBSERVATION_AREAS, type Area, type Block, type BlockEdit, type Flag, type NoticeSummary,
  type RecordingDraftState, type ReviewAnswer, type V2Api,
  type WritingPreferences, type WritingSession } from '../api/v2';
import type { Account } from '../auth/controller';
import { todayDate } from '../ui/DatePicker';
import { bulkMessage, confirmReviewing } from './bulkConfirm';
import { elapsedText } from './elapsed';
import { WorkButton, WorkChoice, WorkField, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';
import { colors } from '../ui/theme';
import { NoticeReview, jobMessage, waitForJob } from './NoticeReview';
import { NoticeRecordingList, useNoticeRecordings } from './NoticeRecordings';
import { NoticeControl, NoticeDates, NoticeSubjects, noticePalette, noticeWidth, type NoticeDesign, type NoticePalette } from './NoticeLayout';
import { RecordingRunPanel, recordingRunWorking } from './RecordingRunPanel';
import { PresetField, usePresetMenu, type PresetMenu } from './WritingPreferences';

function isGenerating(status: WritingSession['status']) {
  return status === 'analyzing' || status === 'drafting';
}

function Areas({ areas, onChange, disabled }: { areas: Area[]; onChange(areas: Area[]): void; disabled: boolean }) {
  return (
    <View style={workStyles.row}>
      {OBSERVATION_AREAS.map(area => <WorkChoice key={area} label={area} checkbox selected={areas.includes(area)}
        disabled={disabled} onPress={() => onChange(areas.includes(area) ? areas.filter(value => value !== area) : [...areas, area])} />)}
    </View>
  );
}

function InputBlock({ block, common, preferences, menu, onChange, busy, palette }: {
  block: Block; common?: Block; preferences: WritingPreferences; menu: PresetMenu;
  onChange(change: Partial<BlockEdit>): void; busy: boolean; palette: NoticePalette;
}) {
  const name = block.child_name ?? '';
  const disabled = busy || block.absent;
  return (
    <View style={[styles.editor, { backgroundColor: palette.sheet, borderColor: palette.line, borderRadius: palette.radius },
      menu.selection?.groupId === block.block_id && workStyles.raised]}>
      {!block.is_common && <View style={workStyles.between}>
        <WorkChoice label="결석" checkbox selected={block.absent} disabled={busy}
          onPress={() => onChange({ absent: !block.absent })} />
      </View>}
      <WorkField label={block.is_common ? '반 전체 메모' : name + ' 관찰 메모'} value={block.text} multiline
        style={[styles.memoInput, { backgroundColor: palette.sheet, borderColor: palette.line, color: palette.ink, borderRadius: palette.radius }]}
        maxLength={5000} editable={!disabled}
        placeholder={block.is_common ? '반에서 함께한 일을 적어 주세요.' : '이 아이의 말이나 행동을 적어 주세요.'}
        onChangeText={text => onChange({ text })} />
      {!block.is_common && <>
        <Text style={styles.areaLabel}>영역 선택</Text>
        <View accessibilityLabel={name + ' 영역 선택'}>
          <Areas areas={block.areas} disabled={disabled} onChange={areas => onChange({ areas })} />
        </View>
      </>}
      <View style={styles.presetRow}>
        <PresetField label="장소" fieldId={(block.is_common ? '공통' : name) + ' 장소'} disabled={disabled}
          groupId={block.block_id} menu={menu}
          value={block.place ?? common?.place ?? ''} options={preferences.places} onChange={place => onChange({ place })} />
        <PresetField label="시간" fieldId={(block.is_common ? '공통' : name) + ' 시간'} disabled={disabled}
          groupId={block.block_id} menu={menu}
          value={block.time_text ?? common?.time_text ?? ''} options={preferences.times} onChange={time_text => onChange({ time_text })} />
      </View>
    </View>
  );
}

function ReviewQuestions({ flags, busy, onAnswer, onReopen, onDirty }: {
  flags: Flag[]; busy: boolean;
  onAnswer(answers: ReviewAnswer[]): void; onReopen(): void;
  onDirty(id: string, dirty: boolean): void;
}) {
  const [answers, setAnswers] = useState<Record<string, string | null>>({});
  // Existing sessions may still have pending area flags. Submit them as skipped.
  const questions = flags.filter(flag => flag.kind !== 'area');
  const assigningRecording = questions.some(flag => flag.kind === 'recording_scope');
  const ready = questions.every(flag => answers[flag.flag_id] === null || answers[flag.flag_id]?.trim());
  function answer(flagId: string, value: string | null) {
    setAnswers(old => ({ ...old, [flagId]: value }));
    onDirty('questions', true);
  }
  useEffect(() => () => onDirty('questions', false), [onDirty]);
  return (
    <>
      {questions.length > 0 ? <>
        <Text style={workStyles.title}>작성 전에 확인할 내용</Text>
        <WorkMessage>교사가 확인한 답을 알림장과 관찰일지에 반영해요.</WorkMessage>
      </> : <WorkMessage>확인할 질문이 없어요.</WorkMessage>}
      {questions.map((flag, index) => {
        const metadata = flag.kind === 'place' || flag.kind === 'time_text';
        return (
          <View key={flag.flag_id} style={workStyles.panel}>
            <Text style={workStyles.body}>{flag.question}</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel={'질문 ' + (index + 1) + ' 선택지'} style={workStyles.row}>
              {flag.options.map(option => <WorkChoice key={option} label={option}
                selected={answers[flag.flag_id] === option} disabled={busy} onPress={() => answer(flag.flag_id, option)} />)}
              <WorkChoice label={metadata ? '비워 두기' : '건너뛰기'} selected={answers[flag.flag_id] === null}
                disabled={busy} onPress={() => answer(flag.flag_id, null)} />
            </View>
            {flag.kind !== 'recording_scope' && <WorkField label={'질문 ' + (index + 1) + ' 답변'} placeholder="답변을 직접 입력할 수 있어요."
              value={answers[flag.flag_id] ?? ''} maxLength={metadata ? 100 : 500} editable={!busy}
              onChangeText={value => answer(flag.flag_id, value)} />}
          </View>
        );
      })}
      <WorkButton label={assigningRecording ? '확인하고 계속' : questions.length > 0 ? '답변하고 초안 만들기' : '초안 만들기'}
        busy={busy} disabled={!ready}
        onPress={() => onAnswer(flags.map(flag => flag.kind === 'area'
          ? { flag_id: flag.flag_id, areas: [] }
          : { flag_id: flag.flag_id, answer: answers[flag.flag_id] }))} />
      <WorkButton label="입력으로 돌아가기" secondary disabled={busy} onPress={onReopen} />
    </>
  );
}

export function NoticeWorkspace({ account, api, active, rosterVersion, onJournalUpdated, design = 'week', referenceDate }: {
  account: Account; api: V2Api; active: boolean; rosterVersion: number; onJournalUpdated(): void;
  design?: NoticeDesign; referenceDate?: string;
}) {
  const [session, setSession] = useState<WritingSession | null>(null);
  const [edits, setEdits] = useState<Record<string, Partial<BlockEdit>>>({});
  const [checkingAreas, setCheckingAreas] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [bulkText, setBulkText] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);
  const action = useWorkAction();
  const menu = usePresetMenu(active);
  const today = referenceDate ?? todayDate();
  const [day, setDay] = useState(today);
  const [subject, setSubject] = useState<string | null>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const palette = noticePalette(design);
  const [preferences, setPreferences] = useState<WritingPreferences>({ places: [], times: [] });
  const [audio, setAudio] = useState<RecordingDraftState>({ run: null, used_recordings: {} });
  const [audioReady, setAudioReady] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioAttempt, setAudioAttempt] = useState(0);
  const [recordingChoices, setRecordingChoices] = useState<Record<string, boolean>>({});
  const [targetChoices, setTargetChoices] = useState<string[]>([]);
  const recordings = useNoticeRecordings(account, day, active);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const dirtyEditors = useRef(new Set<string>());
  const onDirty = useCallback((id: string, dirty: boolean) => {
    if (dirty) dirtyEditors.current.add(id);
    else dirtyEditors.current.delete(id);
  }, []);
  const sessionId = session?.session_id;
  const generating = !!session && isGenerating(session.status);
  useEffect(() => {
    if (!generating) { setWaited(0); return; }
    const started = Date.now();
    const timer = setInterval(() => setWaited((Date.now() - started) / 1000), 1000);
    return () => clearInterval(timer);
  }, [generating]);
  const run = audio.run;
  const audioWorking = recordingRunWorking(run);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoadFailed(false);
    void Promise.all([api.openSession(day), api.writingPreferences()]).then(([value, choices]) => {
      if (!current) return;
      setSession(value);
      setPreferences(choices);
    }).catch(() => { if (current) setLoadFailed(true); });
    return () => { current = false; };
  }, [api, active, rosterVersion, day, loadAttempt]);

  useEffect(() => {
    if (!active || !sessionId) return;
    let current = true;
    setAudioReady(false);
    setAudioError(null);
    void api.recordingDraft(sessionId).then(state => {
      if (current) { setAudio(state); setAudioReady(true); }
    }).catch(error => {
      if (current && !(error instanceof ApiError && error.status === 404)) {
        setAudioError('녹음 작성 상태를 불러오지 못했어요.');
      }
    });
    return () => { current = false; };
  }, [api, active, sessionId, audioAttempt]);

  useEffect(() => {
    if (!active || !sessionId || !audioWorking) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(id: string) {
      try {
        const state = await api.recordingDraft(id);
        const updated = state.run ? null : await api.session(id);
        if (!current) return;
        setAudio(state);
        setAudioError(null);
        if (recordingRunWorking(state.run)) timer = setTimeout(() => { void poll(id); }, 1000);
        else if (updated) { setSession(updated); onJournalUpdated(); }
      } catch {
        if (!current) return;
        setAudioError('녹음 작성 상태를 다시 확인하고 있어요.');
        timer = setTimeout(() => { void poll(id); }, 3000);
      }
    }
    timer = setTimeout(() => { void poll(sessionId); }, 750);
    return () => { current = false; clearTimeout(timer); };
  }, [api, active, audioWorking, sessionId, onJournalUpdated]);

  useEffect(() => {
    if (!active || !generating || !sessionId) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(id: string) {
      try {
        const value = await api.session(id);
        if (!current) return;
        setSession(value);
        if (isGenerating(value.status)) timer = setTimeout(() => { void poll(id); }, 1000);
      } catch {
        if (current) timer = setTimeout(() => { void poll(id); }, 3000);
      }
    }
    timer = setTimeout(() => { void poll(sessionId); }, 800);
    return () => { current = false; clearTimeout(timer); };
  }, [api, active, generating, sessionId]);

  const blocks = session?.blocks.map(block => ({ ...block, ...edits[block.block_id] })) ?? [];
  const common = blocks.find(block => block.is_common);
  const selectedBlock = blocks.find(block => block.block_id === subject) ?? common ?? blocks[0];
  const nextBlock = selectedBlock && blocks[blocks.indexOf(selectedBlock) + 1];
  const wide = layoutWidth >= 760;
  const presentChildren = blocks.filter(block => !block.is_common && !block.absent);
  const observedChildren = presentChildren.filter(block => block.text.trim());
  const reviewing = session?.status === 'reviewing';
  const editing = !!session && !run?.initial && !generating && session.status !== 'asking' && !reviewing;
  const showAreaCheck = editing && checkingAreas;
  const eligible = presentChildren.filter(block => !session?.notices.some(notice => notice.child_id === block.child_id && notice.status === '완료'));
  const targets = eligible.flatMap(block => block.child_id && targetChoices.includes(block.child_id) ? [block.child_id] : []);
  const availableRecordingIds = new Set(recordings.rows.flatMap(row => row.draftId ? [row.draftId] : []));
  const defaults = new Set(targets.flatMap(child => audio.used_recordings[child] ?? [])
    .filter(id => availableRecordingIds.has(id)));
  const used = new Set(Object.values(audio.used_recordings).flat());
  const checkedRecordings = recordings.rows.filter(row => recordingChoices[row.uri] ?? (!!row.draftId && defaults.has(row.draftId)));
  const selected = checkedRecordings.flatMap(row => row.draftId ? [row.draftId] : []);
  const canRegenerate = audioReady && !action.busy && !run && reviewing && eligible.length > 0;

  function selectRecordings(uris: string[], checked: boolean) {
    setRecordingChoices(values => ({ ...values, ...Object.fromEntries(uris.map(uri => [uri, checked])) }));
  }

  function canUseSelectedRecordings() {
    if (!selected.length || audioReady) return true;
    action.setError('녹음 작성 상태를 확인하지 못했어요. 녹음 목록을 새로고침해 주세요.');
    return false;
  }

  function noticeStatusChanged(notice: NoticeSummary) {
    setSession(current => current && ({
      ...current, notices: current.notices.map(item => item.notice_id === notice.notice_id ? notice : item),
    }));
  }

  function recordingAction(work: () => Promise<RecordingDraftState>, refresh = false) {
    if (!sessionId) return;
    void action.run(async () => {
      const state = await work();
      setAudio(state);
      if (refresh || !state.run) {
        setSession(await api.session(sessionId));
        onJournalUpdated();
      }
    });
  }

  function editBlock(blockId: string, change: Partial<BlockEdit>) {
    setEdits(values => {
      const next = { ...values, [blockId]: { ...values[blockId], ...change } };
      const originalCommon = session?.blocks.find(block => block.is_common);
      if (!session || originalCommon?.block_id !== blockId) return next;

      const previousCommon = { ...originalCommon, ...values[blockId] };
      for (const field of ['place', 'time_text'] as const) {
        if (!(field in change) || (change[field] ?? '') === (previousCommon[field] ?? '')) continue;
        for (const child of session.blocks) {
          if (child.is_common) continue;
          const previousChild = { ...child, ...values[child.block_id] };
          if (previousChild[field] === null) continue;
          next[child.block_id] = { ...next[child.block_id], [field]: null };
        }
      }
      return next;
    });
    setSaved(false);
  }

  async function saveInputs(current: WritingSession, forRecording = false) {
    const common = current.blocks.find(block => block.is_common);
    const changes = { ...edits };
    if (common?.areas.length) changes[common.block_id] = { ...changes[common.block_id], areas: [] };
    if (forRecording) {
      for (const block of current.blocks) {
        changes[block.block_id] = { text: block.text, place: block.place, time_text: block.time_text, ...changes[block.block_id] };
      }
    }
    for (const [blockId, change] of Object.entries(changes)) {
      const values = { ...change };
      if ('place' in values) values.place = values.place?.trim() || null;
      if ('time_text' in values) values.time_text = values.time_text?.trim() || null;
      const childId = current.blocks.find(block => block.block_id === blockId)?.child_id;
      await api.saveBlock(current.session_id, blockId, values, childId, !forRecording);
    }
    const value = await api.session(current.session_id);
    setSession(value);
    setEdits({});
    return value;
  }

  function checkAreas() {
    if (!presentChildren.length) {
      action.setError('출석한 아이가 있어야 알림장을 만들 수 있어요.');
      return;
    }
    if (!common?.text.trim() && !observedChildren.length && !selected.length) {
      action.setError('관찰 내용을 적거나 사용할 녹음을 골라 주세요.');
      return;
    }
    if (!canUseSelectedRecordings()) return;
    action.setError(null);
    setCheckingAreas(true);
    scroll.current?.scrollTo({ y: 0, animated: false });
  }

  async function confirmAll(current: WritingSession) {
    if (dirtyEditors.current.size) {
      action.setError('수정 중인 알림장이 있어요. 저장하거나 취소한 뒤 전체 확정해 주세요.');
      return;
    }
    setBulkText(null);
    const result = await confirmReviewing(api, current.notices);
    setBulkText(bulkMessage(result));
    setSession(await api.session(current.session_id));
    onJournalUpdated();
  }

  async function generate(current: WritingSession) {
    if (!canUseSelectedRecordings()) return;
    await saveInputs(current, selected.length > 0);
    if (selected.length) setAudio(await api.startRecordingDraft(current.session_id, selected));
    else await api.generate(current.session_id);
    setSession(await api.session(current.session_id));
    setCheckingAreas(false);
    scroll.current?.scrollTo({ y: 0, animated: false });
  }

  function changeDay(next: string | null) {
    if (!next || next === day) return;
    void action.run(async () => {
      if (dirtyEditors.current.size) {
        action.setError('수정 내용이나 역질문 답변을 먼저 마친 뒤 날짜를 바꿔 주세요.');
        return;
      }
      if (session && Object.keys(edits).length) await saveInputs(session);
      setSession(null);
      setEdits({});
      setAudio({ run: null, used_recordings: {} });
      setAudioReady(false);
      setRecordingChoices({});
      setTargetChoices([]);
      setCheckingAreas(false);
      setSaved(false);
      setSubject(null);
      setDay(next);
    });
  }

  const dates = <NoticeDates design={design} day={day} today={today} disabled={action.busy} wide={wide} onChange={changeDay} />;
  const reloadRecordings = () => {
    recordings.reload();
    if (!audioWorking && !action.busy) setAudioAttempt(value => value + 1);
  };
  const recordingsSection = session && (!showAreaCheck || checkedRecordings.length > 0) &&
    <NoticeRecordingList key={day + (showAreaCheck ? ':preview' : '')} preview={showAreaCheck}
      palette={palette} list={{ ...recordings, reload: reloadRecordings }}
      account={account} active={active} used={used} busy={action.busy} deleteBlocked={!!run}
      selected={new Set(checkedRecordings.map(row => row.uri))} onSelect={selectRecordings}>
        {audioError && <WorkMessage error>{audioError}</WorkMessage>}
        {reviewing && !run && eligible.length > 0 && availableRecordingIds.size > 0 && <>
          <Text style={workStyles.label}>재생성할 아이</Text>
          <View style={workStyles.row}>
            {eligible.map(block => <WorkChoice key={block.block_id} label={block.child_name ?? '아동'} checkbox
              selected={targets.includes(block.child_id ?? '')} disabled={!canRegenerate}
              onPress={() => setTargetChoices(values => values.includes(block.child_id!)
                ? values.filter(value => value !== block.child_id) : [...values, block.child_id!])} />)}
          </View>
          <View style={styles.regenerateAction}>
            <WorkButton label="녹음으로 초안 다시 만들기" disabled={!canRegenerate || !targets.length || (!selected.length && !defaults.size)}
              onPress={() => recordingAction(async () => {
                await saveInputs(session, true);
                return api.startRecordingDraft(session.session_id, selected, targets);
              })} />
          </View>
        </>}
    </NoticeRecordingList>;
  const editingInputs = editing && !showAreaCheck;
  const editor = editingInputs && selectedBlock && <>
    {session?.status === 'failed' && <WorkMessage error>{jobMessage(session.error_code)}</WorkMessage>}
    <NoticeSubjects design={design} blocks={blocks} selected={selectedBlock} disabled={action.busy} onSelect={setSubject} />
    <InputBlock key={selectedBlock.block_id} block={selectedBlock} busy={action.busy} menu={menu} palette={palette}
      common={selectedBlock.is_common ? undefined : common} preferences={preferences}
      onChange={change => editBlock(selectedBlock.block_id, change)} />
    {blocks.every(block => block.is_common) && <WorkMessage>설정에서 아동을 등록해 주세요.</WorkMessage>}
    {design === 'focus' && nextBlock && <View style={styles.nextSubject}>
      <NoticeControl palette={palette} icon="person-outline" label={nextBlock.child_name + ' 메모'}
        disabled={action.busy} onPress={() => setSubject(nextBlock.block_id)} />
    </View>}
  </>;
  const monthAside = design === 'month' && wide && (!session || editingInputs);
  const weekAside = design === 'week' && wide && editingInputs;

  return (
    <View style={[styles.workspace, { backgroundColor: palette.ground }]}>
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled"
        onLayout={event => setLayoutWidth(event.nativeEvent.layout.width)} contentContainerStyle={[styles.content, design === 'focus' && styles.focusWidth]}>
        {monthAside ? <View style={styles.columns}>
          <View style={styles.monthRail}>{dates}</View>
          <View style={[styles.editorStack, styles.flexEditor]}>
            {session && <Text style={[styles.classroom, { color: palette.quiet }]}>{session.classroom.name}</Text>}
            {editor}
            {recordingsSection}
          </View>
        </View> : dates}
        {!session && (loadFailed ? <View style={styles.loadFailure}>
          <WorkMessage error>알림장을 불러오지 못했어요.</WorkMessage>
          <NoticeControl palette={palette} label="다시 불러오기" icon="refresh-outline" onPress={() => setLoadAttempt(value => value + 1)} />
        </View> : <ActivityIndicator color={palette.accent} accessibilityLabel="작성 내용 불러오는 중" />)}
        {session && <>
          {!monthAside && <>
            <Text style={[styles.classroom, { color: palette.quiet }]}>{session.classroom.name}</Text>
            {action.error && !editing && <WorkMessage error>{action.error}</WorkMessage>}
          </>}
          {run?.initial ? null : generating ? <View style={workStyles.panel}>
            <ActivityIndicator color={colors.ink} />
            <WorkMessage>{session.status === 'analyzing' ? '작성에 필요한 맥락을 확인하고 있어요.' : '알림장과 관찰일지 초안을 만들고 있어요.'}</WorkMessage>
            <WorkMessage>{elapsedText(waited)} 만드는 중이에요. 아이가 많으면 시간이 더 걸려요. 화면을 닫지 말아 주세요.</WorkMessage>
          </View> : session.status === 'asking' ? <ReviewQuestions
            key={session.flags.map(flag => flag.flag_id).join(',')} flags={session.flags.filter(flag => flag.status === 'open')}
            busy={action.busy} onDirty={onDirty} onAnswer={answers => { void action.run(async () => {
              await api.answer(session.session_id, answers);
              setSession(await api.session(session.session_id));
            }); }} onReopen={() => { void action.run(async () => setSession(await api.reopen(session.session_id))); }} />
            : session.status === 'reviewing' ? <>
              <Text style={workStyles.title}>아이별 알림장</Text>
              {session.notices.filter(notice => notice.status === '검토중').length > 1 && <View style={workStyles.row}>
                <WorkButton label={'전체 확정 (' + session.notices.filter(notice => notice.status === '검토중').length + '명)'}
                  busy={action.busy} disabled={action.busy}
                  onPress={() => { void action.run(() => confirmAll(session)); }} />
              </View>}
              {bulkText && <WorkMessage>{bulkText}</WorkMessage>}
              {session.notices.map(notice => <NoticeReview key={notice.notice_id} api={api} summary={notice}
                onDirty={onDirty} onJournalUpdated={onJournalUpdated} onStatusChange={noticeStatusChanged} />)}
              {session.job?.result?.failed?.map(failed => {
                const block = blocks.find(item => item.child_id === failed.child_id);
                return <View key={failed.child_id} style={workStyles.panel}>
                  <WorkMessage error>{block?.child_name ?? '아동'} · {jobMessage(failed.error_code)}</WorkMessage>
                  <WorkButton label="다시 시도" secondary busy={action.busy} onPress={() => { void action.run(async () => {
                    const job = await api.regenerateNotice(session.session_id, failed.child_id);
                    await waitForJob(api, job);
                    setSession(await api.session(session.session_id));
                  }); }} />
                </View>;
              })}
            </> : checkingAreas ? <>
              <Text style={workStyles.title}>아이별 영역 확인</Text>
              <WorkMessage>{selected.length > 0
                ? '녹음에서 확인할 관찰의 영역을 미리 고를 수 있어요. 비워 두어도 됩니다.'
                : observedChildren.length > 0
                ? '아이별 관찰 내용을 보고 필요한 영역을 선택해 주세요. 비워 두어도 됩니다.'
                : '아이별 관찰 내용이 없어 선택할 영역이 없어요.'}</WorkMessage>
              {(selected.length > 0 ? presentChildren : observedChildren).map(block => <View key={block.block_id} style={workStyles.panel}>
                <Text style={workStyles.title}>{block.child_name}</Text>
                <Text style={workStyles.body}>{block.text}</Text>
                <Areas areas={block.areas} disabled={action.busy} onChange={areas => editBlock(block.block_id, { areas })} />
              </View>)}
            </> : !monthAside && <View style={weekAside ? styles.columns : styles.stack}>
              <View style={[styles.editorStack, weekAside && styles.flexEditor]}>{editor}</View>
              {weekAside && <View style={styles.recordingsRail}>{recordingsSection}</View>}
            </View>}
          {run && (run.stage === 'asking' ? <ReviewQuestions
            key={run.flags.map(flag => flag.flag_id).join(',')} flags={run.flags} busy={action.busy} onDirty={onDirty}
            onAnswer={answers => recordingAction(() => api.answerRecordingDraft(session.session_id, run.run_id,
              Object.fromEntries(answers.flatMap(item => 'answer' in item ? [[item.flag_id, item.answer]] : []))))}
            onReopen={() => recordingAction(() => api.dismissRecordingDraft(session.session_id, run.run_id))} />
            : <RecordingRunPanel key={run.run_id} run={run} busy={action.busy}
              recordings={new Map(recordings.rows.flatMap(row => row.serverId ? [[row.serverId, row.fileName]] : []))}
              onRetry={choice => recordingAction(() => api.resolveTranscriptions(session.session_id, run.run_id, choice))}
              onApply={childId => {
                const notice = session.notices.find(item => item.child_id === childId);
                if (notice && dirtyEditors.current.has(notice.notice_id)) {
                  action.setError('이 아이의 작성 중인 수정 내용을 먼저 마쳐 주세요.');
                  return;
                }
                recordingAction(() => api.applyRecordingDraft(session.session_id, run.run_id, childId), true);
              }}
              onDismiss={() => recordingAction(() => api.dismissRecordingDraft(session.session_id, run.run_id))} />)}
          {!weekAside && !monthAside && recordingsSection}
        </>}
      </ScrollView>
      {session && editing && <View style={[styles.actionBar, { borderColor: palette.line }]}>
        <View style={[styles.actionInner, design === 'focus' && styles.focusWidth]}>
          {action.error && <WorkMessage error>{action.error}</WorkMessage>}
          {saved && editingInputs && <WorkMessage>메모를 저장했어요.</WorkMessage>}
          <View style={styles.actions}>
            {showAreaCheck ? <>
              <NoticeControl palette={palette} label="메모로 돌아가기" disabled={action.busy} onPress={() => setCheckingAreas(false)} />
              <NoticeControl palette={palette} label="초안 만들기" primary icon="document-text-outline" disabled={action.busy}
                onPress={() => { void action.run(() => generate(session)); }} />
            </> : <>
              <NoticeControl palette={palette} label="메모 저장" icon="bookmark-outline" disabled={action.busy}
                onPress={() => { void action.run(async () => { await saveInputs(session); setSaved(true); }); }} />
              <NoticeControl palette={palette} label="영역 확인" icon="list-outline" primary disabled={action.busy} onPress={checkAreas} />
            </>}
          </View>
        </View>
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  workspace: { flex: 1, width: '100%' },
  content: { width: '100%', maxWidth: noticeWidth, alignSelf: 'center', paddingHorizontal: 14, paddingTop: 14, paddingBottom: 26, gap: 14 },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: 18 },
  stack: { gap: 14 },
  editorStack: { minWidth: 0, gap: 14, zIndex: 1 },
  flexEditor: { flex: 1 },
  focusWidth: { maxWidth: 720 },
  monthRail: { width: '38%', maxWidth: 360 },
  recordingsRail: { width: '34%', maxWidth: 340 },
  editor: { borderWidth: 1, padding: 14, gap: 11 },
  memoInput: { minHeight: 126, lineHeight: 26, paddingVertical: 10 },
  classroom: { fontSize: 15, fontWeight: '700' },
  loadFailure: { alignItems: 'flex-start', gap: 8 },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  areaLabel: { color: colors.blueInk, fontSize: 14, fontWeight: '700' },
  nextSubject: { alignItems: 'flex-end' },
  actionBar: { borderTopWidth: 1 },
  actionInner: { width: '100%', maxWidth: noticeWidth, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 8, gap: 6 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  regenerateAction: { alignSelf: 'flex-end' },
});
