import { useState } from 'react';
import { Text, View } from 'react-native';
import type { Job, Journal, V2Api, WeeklyJournalDraft, WeeklyJournalEntry } from '../api/v2';
import { DateArrow, DatePicker, shiftDate, todayDate } from '../ui/DatePicker';
import { WorkButton, WorkChoice, WorkField, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';
import { weekRange, type Range } from './journalRange';
import { waitForJob } from './NoticeReview';

type ReviewEntry = WeeklyJournalEntry & { selected: boolean };
type Review = { jobId: string; result: WeeklyJournalDraft; entries: ReviewEntry[] };
const sceneKey = (entry: WeeklyJournalEntry) => JSON.stringify([entry.date, entry.evidence]);

function draftResult(job: Job): WeeklyJournalDraft {
  const result = job.result;
  if (!result?.week_start || !result.week_end || result.source_dates === undefined ||
      !result.entries || !result.questions) {
    throw new Error('초안을 불러오지 못했어요. 다시 시도해 주세요.');
  }
  return {
    week_start: result.week_start, week_end: result.week_end, source_dates: result.source_dates,
    entries: result.entries, questions: result.questions,
  };
}

export function WeeklyJournalForm({ api, children, initialWeek, onSaved, onClose }: {
  api: V2Api;
  children: Journal['child'][];
  initialWeek: string;
  onSaved(name: string, range: Range, count: number): void;
  onClose(): void;
}) {
  const [childId, setChildId] = useState(children.length === 1 ? children[0].child_id : '');
  const [weekOf, setWeekOf] = useState(initialWeek);
  const [review, setReview] = useState<Review | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [pending, setPending] = useState<Job | null>(null);
  const [skip, setSkip] = useState(false);
  const action = useWorkAction();
  const child = children.find(item => item.child_id === childId);
  const range = weekRange(weekOf);
  const selected = review?.entries.filter(entry => entry.selected) ?? [];
  const questions = skip ? [] : review?.result.questions ?? [];
  const responses = Object.fromEntries(Object.entries(answers).filter(([, answer]) => answer.trim()));

  function reset() {
    setReview(null);
    setAnswers({});
    setSkip(false);
    setPending(null);
    action.setError(null);
  }

  async function load(job: Job) {
    setPending(job);
    let completed: Job;
    try {
      completed = await waitForJob(api, job);
    } catch (error) {
      // Keep the job ID if polling was interrupted so the draft can be recovered.
      setPending(await api.job(job.job_id).catch(() => job));
      throw error;
    }
    setPending(null);
    const result = draftResult(completed);
    setReview(previous => {
      const prior = new Map(previous?.entries.map(entry => [sceneKey(entry), entry]));
      return {
        jobId: completed.job_id, result,
        entries: result.entries.map(entry => {
          const previous = prior.get(sceneKey(entry));
          return { ...entry, content: previous?.content ?? entry.content, selected: !entry.saved && (previous?.selected ?? true) };
        }),
      };
    });
    setAnswers({});
    setSkip(false);
  }

  function chooseWeek(value: string | null) {
    if (!value || weekRange(value).from === range.from) return;
    reset();
    setWeekOf(value);
  }

  function editEntry(index: number, changes: Partial<ReviewEntry>) {
    setReview(previous => previous && ({
      ...previous, entries: previous.entries.map((entry, order) => order === index ? { ...entry, ...changes } : entry),
    }));
  }

  async function save() {
    if (!child || !review) return;
    const entries = Object.fromEntries(review.entries.flatMap((entry, index) => entry.selected ? [[index, entry.content]] : []));
    const saved = await api.confirmWeeklyJournal(child.child_id, review.jobId, entries);
    onSaved(child.name, range, saved.saved_dates.length);
  }

  const pendingDraft = pending?.status === 'queued' || pending?.status === 'running' || pending?.status === 'completed';

  return (
    <View style={workStyles.panel}>
      <Text accessibilityRole="header" style={workStyles.title}>주간 관찰일지 생성</Text>
      <View style={workStyles.row}>
        <DateArrow name="chevron-back" label="이전 주" disabled={action.busy} onPress={() => chooseWeek(shiftDate(range.from, -7))} />
        <Text accessibilityLabel="선택한 주" style={workStyles.label}>{range.from} ~ {range.to}</Text>
        <DateArrow name="chevron-forward" label="다음 주" disabled={action.busy || range.to >= todayDate()}
          onPress={() => chooseWeek(shiftDate(range.from, 7))} />
      </View>
      <DatePicker label="해당 주의 날짜 선택" value={weekOf} max={todayDate()} disabled={action.busy} onChange={chooseWeek} />
      <Text style={workStyles.label}>아동 선택</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="관찰 아동" style={workStyles.row}>
        {children.map(item => <WorkChoice key={item.child_id} label={item.name} selected={item.child_id === childId}
          disabled={action.busy} onPress={() => {
            if (childId === item.child_id) return;
            reset();
            setChildId(item.child_id);
          }} />)}
      </View>
      {!review && <WorkMessage>이 주에 저장한 메모와 반영된 녹음에서 관찰일지에 적합한 장면을 찾습니다.</WorkMessage>}
      {questions.length > 0 && <>
        <Text accessibilityRole="header" style={workStyles.title}>교사 확인이 필요한 장면</Text>
        {questions.map((item, index) => (
          <View key={index} style={workStyles.panel}>
            <Text style={workStyles.label}>{item.date}</Text>
            <Text style={workStyles.body}>{item.question}</Text>
            <WorkMessage>근거 · {item.evidence}</WorkMessage>
            <WorkField label={`답변 ${index + 1}`} value={answers[index] ?? ''} maxLength={500} multiline
              editable={!action.busy} onChangeText={value => setAnswers(previous => ({ ...previous, [index]: value }))} />
          </View>
        ))}
        <View style={workStyles.row}>
          <WorkButton label="답변 반영" busy={action.busy} disabled={!Object.keys(responses).length || pendingDraft}
            onPress={() => { void action.run(async () => {
              if (child && review) await load(await api.answerWeeklyJournal(child.child_id, review.jobId, responses));
            }); }} />
          <WorkButton label="질문 건너뛰기" secondary disabled={action.busy || pendingDraft} onPress={() => setSkip(true)} />
        </View>
      </>}
      {review && <>
        {review.result.source_dates === 0 ? <WorkMessage>이 주에 저장된 관찰 메모나 반영된 녹음이 없어요.</WorkMessage>
          : review.entries.length === 0 ? <WorkMessage>이 주에 관찰일지로 남길 장면을 확인하지 못했어요.</WorkMessage>
            : <Text accessibilityRole="header" style={workStyles.title}>저장할 장면 선택</Text>}
        {review.entries.map((entry, index) => {
          return (
            <View key={sceneKey(entry)} style={workStyles.panel}>
              <Text style={workStyles.label}>{entry.date} · {entry.area}</Text>
              <WorkMessage>근거 · {entry.evidence}</WorkMessage>
              {entry.teacher_answer && <WorkMessage>교사 확인 · {entry.teacher_answer}</WorkMessage>}
              {entry.saved ? <>
                <Text style={workStyles.body}>{entry.content}</Text>
                <WorkMessage>이 장면은 이미 저장했어요.</WorkMessage>
              </> : <>
                <WorkField label="관찰일지 초안" value={entry.content} multiline maxLength={3000}
                  editable={!action.busy && entry.selected} onChangeText={content => editEntry(index, { content })} />
                <WorkChoice label="이 장면 저장" checkbox selected={entry.selected} disabled={action.busy}
                  onPress={() => editEntry(index, { selected: !entry.selected })} />
              </>}
            </View>
          );
        })}
      </>}
      {action.error && <WorkMessage error>{action.error}</WorkMessage>}
      {action.busy && pending && <WorkMessage>관찰일지 초안을 만들고 있어요.</WorkMessage>}
      <View style={workStyles.row}>
        {pending && pendingDraft
          ? <WorkButton label="초안 다시 불러오기" busy={action.busy}
            onPress={() => { void action.run(async () => load(await api.job(pending.job_id))); }} />
          : !review ? <WorkButton label="주간 기록으로 초안 만들기" busy={action.busy} disabled={!child}
            onPress={() => { void action.run(async () => {
              if (child) await load(await api.draftWeeklyJournal(child.child_id, weekOf));
            }); }} />
            : <WorkButton label={`장면 ${selected.length}개 저장`} busy={action.busy}
              disabled={selected.length === 0 || selected.some(entry => !entry.content.trim())}
              onPress={() => { void action.run(save); }} />}
        <WorkButton label="닫기" secondary disabled={action.busy} onPress={onClose} />
      </View>
    </View>
  );
}
