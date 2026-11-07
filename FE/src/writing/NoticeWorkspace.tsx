import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { errorMessage } from '../api/client';
import { OBSERVATION_AREAS, type Area, type Block, type BlockEdit, type Flag, type ReviewAnswer, type V2Api, type WritingSession } from '../api/v2';
import { WorkButton, WorkChoice, WorkField, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';
import { colors } from '../ui/theme';
import { NoticeReview, jobMessage, waitForJob } from './NoticeReview';
import { RecordingComingSoon } from './RecordingComingSoon';

function localDate() {
  const now = new Date();
  const twoDigits = (number: number) => String(number).padStart(2, '0');
  return [now.getFullYear(), twoDigits(now.getMonth() + 1), twoDigits(now.getDate())].join('-');
}

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

function InputBlock({ block, onChange, busy }: { block: Block; onChange(change: Partial<BlockEdit>): void; busy: boolean }) {
  const [showAreas, setShowAreas] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const name = block.child_name ?? '';
  const disabled = busy || block.absent;
  return (
    <View style={workStyles.panel}>
      {!block.is_common && <View style={workStyles.between}>
        <Text style={workStyles.title}>{name}</Text>
        <WorkChoice label="결석" checkbox selected={block.absent} disabled={busy}
          onPress={() => onChange({ absent: !block.absent })} />
      </View>}
      <WorkField label={block.is_common ? '공통 내용' : name + ' 관찰 내용'} value={block.text} multiline
        maxLength={5000} editable={!disabled}
        placeholder={block.is_common ? '반에서 함께한 일을 적어 주세요.' : '이 아이의 말이나 행동을 적어 주세요.'}
        onChangeText={text => onChange({ text })} />
      {!block.is_common && !block.absent && <>
        <Pressable accessibilityRole="button" accessibilityLabel={name + ' 영역 선택'}
          aria-expanded={showAreas} accessibilityState={{ expanded: showAreas, disabled: busy }} disabled={busy}
          onPress={() => setShowAreas(value => !value)} style={styles.smallControl}>
          <View style={styles.controlLabel}>
            <Text style={styles.areaLabel}>영역 선택</Text>
            <Ionicons accessible={false} name={showAreas ? 'chevron-up' : 'chevron-down'} size={15} color={colors.blueInk} />
          </View>
          {block.areas.length > 0 && <Text style={workStyles.hint}>{block.areas.join(' · ')}</Text>}
        </Pressable>
        {showAreas && <Areas areas={block.areas} disabled={busy} onChange={areas => onChange({ areas })} />}
      </>}
      {!block.absent && <>
        <Pressable accessibilityRole="button" aria-expanded={showDetails} accessibilityState={{ expanded: showDetails }} disabled={busy}
          onPress={() => setShowDetails(value => !value)} style={styles.smallControl}>
          <View style={styles.controlLabel}>
            <Text style={workStyles.hint}>장소·시간</Text>
            <Ionicons accessible={false} name={showDetails ? 'chevron-up' : 'chevron-down'} size={15} color={colors.muted} />
          </View>
        </Pressable>
        {showDetails && <>
          <WorkField label="장소" placeholder="(선택사항)" value={block.place ?? ''} editable={!busy} maxLength={100}
            onChangeText={place => onChange({ place: place || null })} />
          <WorkField label="시간" placeholder="(선택사항)" value={block.time_text ?? ''} editable={!busy} maxLength={100}
            onChangeText={time_text => onChange({ time_text: time_text || null })} />
        </>}
      </>}
    </View>
  );
}

function ReviewQuestions({ flags, busy, onAnswer, onReopen }: {
  flags: Flag[]; busy: boolean;
  onAnswer(answers: ReviewAnswer[]): void; onReopen(): void;
}) {
  const [answers, setAnswers] = useState<Record<string, string | null>>({});
  const [areaAnswers, setAreaAnswers] = useState<Record<string, Area[] | undefined>>({});
  const ready = flags.every(flag => flag.kind === 'area'
    ? areaAnswers[flag.flag_id] !== undefined
    : answers[flag.flag_id] === null || answers[flag.flag_id]?.trim());
  function answer(flagId: string, value: string | null) {
    setAnswers(old => ({ ...old, [flagId]: value }));
  }
  function chooseAreas(flagId: string, areas: Area[]) {
    setAreaAnswers(old => ({ ...old, [flagId]: areas }));
  }
  return (
    <>
      <Text style={workStyles.title}>작성 전에 확인할 내용</Text>
      <WorkMessage>교사가 확인한 답을 알림장에 반영해요.</WorkMessage>
      {flags.map((flag, index) => {
        const selected = areaAnswers[flag.flag_id];
        const recommended = OBSERVATION_AREAS.filter(area => flag.options.includes(area));
        return (
          <View key={flag.flag_id} style={workStyles.panel}>
            <Text style={workStyles.body}>{flag.question}</Text>
            {flag.kind === 'area' ? <>
              <Areas areas={selected ?? []} disabled={busy} onChange={areas => chooseAreas(flag.flag_id, areas)} />
              <View style={workStyles.row}>
                {recommended.length > 0 && <WorkButton label="추천 영역으로 할게요" secondary disabled={busy}
                  onPress={() => chooseAreas(flag.flag_id, recommended)} />}
                <WorkButton label="영역 없이 계속" secondary disabled={busy}
                  onPress={() => chooseAreas(flag.flag_id, [])} />
              </View>
              {selected?.length === 0 && <WorkMessage>영역을 비워 두었어요.</WorkMessage>}
            </> : <>
              <View accessibilityRole="radiogroup" accessibilityLabel={'질문 ' + (index + 1) + ' 선택지'} style={workStyles.row}>
                {flag.options.map(option => <WorkChoice key={option} label={option}
                  selected={answers[flag.flag_id] === option} disabled={busy}
                  onPress={() => answer(flag.flag_id, option)} />)}
                <WorkChoice label="건너뛰기" selected={answers[flag.flag_id] === null} disabled={busy}
                  onPress={() => answer(flag.flag_id, null)} />
              </View>
              <WorkField label={'질문 ' + (index + 1) + ' 답변'} placeholder="답변을 직접 입력할 수 있어요."
                value={answers[flag.flag_id] ?? ''} maxLength={500} editable={!busy}
                onChangeText={value => answer(flag.flag_id, value)} />
            </>}
          </View>
        );
      })}
      <WorkButton label="답변하고 초안 만들기" busy={busy} disabled={!ready}
        onPress={() => onAnswer(flags.map(flag => flag.kind === 'area'
          ? { flag_id: flag.flag_id, areas: areaAnswers[flag.flag_id] ?? [] }
          : { flag_id: flag.flag_id, answer: answers[flag.flag_id] }))} />
      <WorkButton label="입력으로 돌아가기" secondary disabled={busy} onPress={onReopen} />
    </>
  );
}

export function NoticeWorkspace({ api, active, rosterVersion }: { api: V2Api; active: boolean; rosterVersion: number }) {
  const [session, setSession] = useState<WritingSession | null>(null);
  const [edits, setEdits] = useState<Record<string, Partial<BlockEdit>>>({});
  const [areaCheckIds, setAreaCheckIds] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const action = useWorkAction();
  const [day] = useState(localDate);
  const sessionId = session?.session_id;
  const generating = !!session && isGenerating(session.status);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoadError(null);
    void api.openSession(day).then(value => { if (current) setSession(value); })
      .catch(error => { if (current) setLoadError(errorMessage(error)); });
    return () => { current = false; };
  }, [api, active, rosterVersion, attempt, day]);

  useEffect(() => {
    if (!active || !generating || !sessionId) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(id: string) {
      try {
        const value = await api.session(id);
        if (!current) return;
        setSession(value);
        setLoadError(null);
        if (isGenerating(value.status)) timer = setTimeout(() => { void poll(id); }, 1000);
      } catch (error) {
        if (current) setLoadError(errorMessage(error));
      }
    }
    timer = setTimeout(() => { void poll(sessionId); }, 800);
    return () => { current = false; clearTimeout(timer); };
  }, [api, active, generating, sessionId, attempt]);

  const blocks = session?.blocks.map(block => ({ ...block, ...edits[block.block_id] })) ?? [];
  const missing = blocks.filter(block => !block.is_common && !block.absent && block.text.trim() && !block.areas.length);

  function editBlock(blockId: string, change: Partial<BlockEdit>) {
    setEdits(values => ({ ...values, [blockId]: { ...values[blockId], ...change } }));
    setSaved(false);
  }

  async function saveInputs(current: WritingSession) {
    const common = current.blocks.find(block => block.is_common);
    const changes = { ...edits };
    if (common?.areas.length) changes[common.block_id] = { ...changes[common.block_id], areas: [] };
    for (const [blockId, change] of Object.entries(changes)) {
      await api.saveBlock(current.session_id, blockId, change);
    }
    const value = await api.session(current.session_id);
    setSession(value);
    setEdits({});
    return value;
  }

  async function generate(current: WritingSession, afterAreaCheck = false) {
    if (!blocks.some(block => !block.is_common && !block.absent)) {
      action.setError('출석한 아이가 있어야 알림장을 만들 수 있어요.');
      return;
    }
    if (!blocks.some(block => !block.absent && block.text.trim())) {
      action.setError('공통 내용이나 아이의 관찰 내용을 적어 주세요.');
      return;
    }
    if (missing.length && !afterAreaCheck) {
      setAreaCheckIds(missing.map(block => block.block_id));
      return;
    }
    await saveInputs(current);
    await api.generate(current.session_id);
    setAreaCheckIds(null);
    setSession(await api.session(current.session_id));
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={workStyles.content}>
      {loadError && <>
        <WorkMessage error>{loadError}</WorkMessage>
        <WorkButton label="다시 불러오기" secondary disabled={action.busy}
          onPress={() => setAttempt(value => value + 1)} />
      </>}
      {!session && !loadError && <ActivityIndicator color={colors.ink} accessibilityLabel="작성 내용 불러오는 중" />}
      {session && <>
        <WorkMessage>{session.classroom.name} · {session.target_date}</WorkMessage>
        {action.error && <WorkMessage error>{action.error}</WorkMessage>}
        {generating ? <View style={workStyles.panel}>
          <ActivityIndicator color={colors.ink} />
          <WorkMessage>{session.status === 'analyzing' ? '작성에 필요한 맥락을 확인하고 있어요.' : '알림장 초안을 쓰고 있어요.'}</WorkMessage>
        </View> : session.status === 'asking' ? <ReviewQuestions
          key={session.flags.map(flag => flag.flag_id).join(',')} flags={session.flags.filter(flag => flag.status === 'open')}
          busy={action.busy} onAnswer={answers => { void action.run(async () => {
            await api.answer(session.session_id, answers);
            setSession(await api.session(session.session_id));
          }); }} onReopen={() => { void action.run(async () => setSession(await api.reopen(session.session_id))); }} />
          : session.status === 'reviewing' ? <>
            <Text style={workStyles.title}>아이별 알림장</Text>
            {session.notices.map(notice => <NoticeReview key={notice.notice_id} api={api} summary={notice} />)}
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
          </> : areaCheckIds ? <>
            <Text style={workStyles.title}>아이별 영역 확인</Text>
            <WorkMessage>영역을 아직 고르지 않은 아이의 관찰 내용을 확인해 주세요.</WorkMessage>
            {blocks.filter(block => areaCheckIds.includes(block.block_id))
              .map(block => <View key={block.block_id} style={workStyles.panel}>
                <Text style={workStyles.title}>{block.child_name}</Text>
                <Text style={workStyles.body}>{block.text}</Text>
                <Areas areas={block.areas} disabled={action.busy} onChange={areas => editBlock(block.block_id, { areas })} />
              </View>)}
            <WorkButton label="초안 만들기" busy={action.busy}
              onPress={() => { void action.run(() => generate(session, true)); }} />
            <WorkButton label="입력으로 돌아가기" secondary disabled={action.busy} onPress={() => setAreaCheckIds(null)} />
          </> : <>
            {session.status === 'failed' && <WorkMessage error>{jobMessage(session.error_code)}</WorkMessage>}
            {blocks.map(block => <InputBlock key={block.block_id} block={block} busy={action.busy}
              onChange={change => editBlock(block.block_id, change)} />)}
            {blocks.every(block => block.is_common) && <WorkMessage>설정에서 아동을 등록해 주세요.</WorkMessage>}
            {saved && <WorkMessage>입력한 내용을 저장했어요.</WorkMessage>}
            <View style={workStyles.row}>
              <WorkButton label="입력 저장" secondary disabled={action.busy} onPress={() => { void action.run(async () => {
                await saveInputs(session);
                setSaved(true);
              }); }} />
              <WorkButton label="알림장 만들기" busy={action.busy}
                onPress={() => { void action.run(() => generate(session)); }} />
            </View>
          </>}
      </>}
      <RecordingComingSoon />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  smallControl: { minHeight: 34, justifyContent: 'center', gap: 3, alignSelf: 'flex-start' },
  controlLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  areaLabel: { color: colors.blueInk, fontSize: 13, fontWeight: '700' },
});
