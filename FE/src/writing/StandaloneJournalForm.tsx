import { useState } from 'react';
import { Text, View } from 'react-native';
import type { Journal, JournalObservation, V2Api } from '../api/v2';
import { DatePicker, todayDate } from '../ui/DatePicker';
import { WorkButton, WorkChoice, WorkField, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';

export function StandaloneJournalForm({ api, children, onSaved, onClose }: {
  api: V2Api;
  children: Journal['child'][];
  onSaved(childName: string, observedDate: string): void;
  onClose(): void;
}) {
  const [childId, setChildId] = useState<string | null>(children.length === 1 ? children[0].child_id : null);
  const [observedDate, setObservedDate] = useState<string | null>(todayDate);
  const [content, setContent] = useState('');
  const [place, setPlace] = useState('');
  const [time, setTime] = useState('');
  const action = useWorkAction();
  const child = children.find(item => item.child_id === childId);
  const canSubmit = !!child && !!observedDate && !!content.trim();
  const observation: JournalObservation = {
    content, areas: [], place: place.trim() || null, time_text: time.trim() || null,
  };

  async function save() {
    if (!child || !observedDate || !canSubmit) return;
    await api.createJournal(child.child_id, { ...observation, observed_date: observedDate });
    onSaved(child.name, observedDate);
  }

  return (
    <View style={workStyles.panel}>
      <Text style={workStyles.title}>새 관찰일지</Text>
      <Text style={workStyles.label}>아동 선택</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="관찰 아동" style={workStyles.row}>
        {children.map(item => <WorkChoice key={item.child_id} label={item.name} selected={item.child_id === childId}
          disabled={action.busy} onPress={() => setChildId(item.child_id)} />)}
      </View>
      <DatePicker label="관찰일" value={observedDate} onChange={setObservedDate} disabled={action.busy} />
      <WorkField label="관찰장소 (선택)" value={place} onChangeText={setPlace} maxLength={100} editable={!action.busy} />
      <WorkField label="관찰시간 (선택)" value={time} onChangeText={setTime} maxLength={100} editable={!action.busy} />
      <WorkField label="관찰내용" value={content} onChangeText={setContent}
        multiline maxLength={10000} editable={!action.busy}
        placeholder="아동이 한 행동과 말, 당시 상황을 적어 주세요." />
      {action.error && <WorkMessage error>{action.error}</WorkMessage>}
      <View style={workStyles.row}>
        <WorkButton label="닫기" secondary disabled={action.busy} onPress={onClose} />
        <WorkButton label="관찰일지 저장" busy={action.busy} disabled={!canSubmit || action.busy}
          onPress={() => { void action.run(save); }} />
      </View>
    </View>
  );
}
