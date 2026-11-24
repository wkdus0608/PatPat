import { useState } from 'react';
import { Text, View } from 'react-native';
import { OBSERVATION_AREAS, type Area, type Journal, type JournalObservation, type V2Api } from '../api/v2';
import { DatePicker, todayDate } from '../ui/DatePicker';
import { WorkButton, WorkChoice, WorkField, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';
import { waitForJob } from './NoticeReview';

export function StandaloneJournalForm({ api, children, onSaved, onClose }: {
  api: V2Api;
  children: Journal['child'][];
  onSaved(childName: string, observedDate: string): void;
  onClose(): void;
}) {
  const [childId, setChildId] = useState<string | null>(children.length === 1 ? children[0].child_id : null);
  const [observedDate, setObservedDate] = useState<string | null>(todayDate);
  const [content, setContent] = useState('');
  const [originalMemo, setOriginalMemo] = useState<string | null>(null);
  const [place, setPlace] = useState('');
  const [time, setTime] = useState('');
  const [areas, setAreas] = useState<Area[]>([]);
  const [inProgress, setInProgress] = useState<'draft' | 'save' | null>(null);
  const action = useWorkAction();
  const child = children.find(item => item.child_id === childId);
  const canSubmit = !!child && !!observedDate && !!content.trim();
  const observation: JournalObservation = {
    content, areas, place: place.trim() || null, time_text: time.trim() || null,
  };

  async function makeDraft() {
    if (!child || !canSubmit) return;
    setInProgress('draft');
    try {
      const job = await waitForJob(api, await api.draftStandaloneJournal(child.child_id, observation));
      const draft = job.result?.content;
      if (!draft?.trim()) throw new Error('받은 초안이 비어 있어요. 메모를 확인해 주세요.');
      setOriginalMemo(content);
      setContent(draft);
    } finally {
      setInProgress(null);
    }
  }

  async function save() {
    if (!child || !observedDate || !canSubmit) return;
    setInProgress('save');
    try {
      await api.createJournal(child.child_id, { ...observation, observed_date: observedDate });
      onSaved(child.name, observedDate);
    } finally {
      setInProgress(null);
    }
  }

  function restoreMemo() {
    if (originalMemo === null) return;
    setContent(originalMemo);
    setOriginalMemo(null);
  }

  return (
    <View style={workStyles.panel}>
      <Text style={workStyles.title}>새 관찰일지</Text>
      <Text style={workStyles.label}>아동 선택</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="관찰 아동" style={workStyles.row}>
        {children.map(item => <WorkChoice key={item.child_id} label={item.name} selected={item.child_id === childId}
          disabled={action.busy} onPress={() => {
            if (item.child_id !== childId) restoreMemo();
            setChildId(item.child_id);
          }} />)}
      </View>
      <DatePicker label="관찰일" value={observedDate} onChange={setObservedDate} disabled={action.busy} />
      <WorkField label="관찰장소 (선택)" value={place} onChangeText={setPlace} maxLength={100} editable={!action.busy} />
      <WorkField label="관찰시간 (선택)" value={time} onChangeText={setTime} maxLength={100} editable={!action.busy} />
      <Text style={workStyles.label}>관찰영역 (선택)</Text>
      <View style={workStyles.row}>
        {OBSERVATION_AREAS.map(area => <WorkChoice key={area} label={area} checkbox selected={areas.includes(area)}
          disabled={action.busy} onPress={() => setAreas(current => current.includes(area)
            ? current.filter(item => item !== area) : [...current, area])} />)}
      </View>
      <WorkField label={originalMemo === null ? '관찰내용' : '관찰일지 초안'} value={content} onChangeText={setContent}
        multiline maxLength={10000} editable={!action.busy}
        placeholder="아동이 한 행동과 말, 당시 상황을 적어 주세요." />
      {originalMemo !== null && <WorkMessage>관찰한 내용과 맞는지 확인하고 필요한 부분을 수정해 주세요.</WorkMessage>}
      {action.error && <WorkMessage error>{action.error}</WorkMessage>}
      {inProgress === 'draft' && <WorkMessage>관찰일지 초안을 만들고 있어요.</WorkMessage>}
      <View style={workStyles.row}>
        <WorkButton label="닫기" secondary disabled={action.busy} onPress={onClose} />
        {originalMemo === null
          ? <WorkButton label="AI 초안 만들기" secondary busy={inProgress === 'draft'} disabled={!canSubmit || action.busy}
            onPress={() => { void action.run(makeDraft); }} />
          : <WorkButton label="원래 메모로 돌아가기" secondary disabled={action.busy} onPress={restoreMemo} />}
        <WorkButton label="관찰일지 저장" busy={inProgress === 'save'} disabled={!canSubmit || action.busy}
          onPress={() => { void action.run(save); }} />
      </View>
    </View>
  );
}
