import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { errorMessage } from '../api/client';
import type { V2Api, WritingPreferences } from '../api/v2';
import { colors } from '../ui/theme';
import { WorkButton, WorkField, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';

export type PresetLines = { places: string; times: string };
export const emptyPresetLines: PresetLines = { places: '', times: '' };

export function preferenceLines(value: WritingPreferences): PresetLines {
  return { places: value.places.join('\n'), times: value.times.join('\n') };
}

export function parsePreferenceLines(value: PresetLines): WritingPreferences {
  function lines(text: string) {
    return [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  }
  return { places: lines(value.places), times: lines(value.times) };
}

export function PreferenceFields({ value, onChange, disabled }: {
  value: PresetLines; onChange(next: PresetLines): void; disabled?: boolean;
}) {
  return <>
    <WorkMessage>한 줄에 하나씩 적어 두면 작성 화면에서 바로 고를 수 있어요.</WorkMessage>
    <WorkField label="자주 쓰는 장소" multiline value={value.places} editable={!disabled}
      placeholder={'예: 유희실\n바깥놀이터'} onChangeText={places => onChange({ ...value, places })} />
    <WorkField label="자주 쓰는 시간" multiline value={value.times} editable={!disabled}
      placeholder={'예: 오전 자유놀이\n10:00~10:30'} onChangeText={times => onChange({ ...value, times })} />
  </>;
}

type PresetLabel = '장소' | '시간';

export function usePresetMenu(active: boolean) {
  const [selection, open] = useState<{ groupId: string; label: PresetLabel } | null>(null);
  const close = useCallback((groupId: string, label: PresetLabel) => {
    open(value => value?.groupId === groupId && value.label === label ? null : value);
  }, []);
  useEffect(() => { if (!active) open(null); }, [active]);
  return { selection, open, close };
}

export type PresetMenu = ReturnType<typeof usePresetMenu>;

export function PresetField({ label, fieldId, groupId, menu, value, options, disabled, onChange }: {
  label: PresetLabel; fieldId: string; groupId: string; menu: PresetMenu;
  value: string; options: string[]; disabled: boolean; onChange(value: string): void;
}) {
  const { selection, open, close } = menu;
  const [filter, setFilter] = useState('');
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    clearTimeout(blurTimer.current);
    close(groupId, label);
  }, [close, groupId, label]);
  const matches = options.filter(option => option.toLowerCase().includes(filter.trim().toLowerCase()));
  const showList = selection?.groupId === groupId && selection.label === label && !disabled && matches.length > 0;
  return <View style={[styles.presetField, showList && workStyles.raised]}>
    <WorkField label={label} accessibilityLabel={fieldId} placeholder="(선택사항)" value={value} editable={!disabled}
      maxLength={100} onFocus={() => { clearTimeout(blurTimer.current); setFilter(''); open({ groupId, label }); }}
      onBlur={() => { blurTimer.current = setTimeout(() => close(groupId, label), 140); }}
      onChangeText={text => { onChange(text); setFilter(text); open({ groupId, label }); }} />
    {showList && <View accessibilityLabel={fieldId + ' 목록'} style={styles.presetList}>
      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={styles.presetScroll}>
        {matches.map(option => <Pressable key={option} accessibilityRole="button" accessibilityLabel={option}
          onPressIn={() => clearTimeout(blurTimer.current)}
          onPress={() => { onChange(option); close(groupId, label); Keyboard.dismiss(); }} style={styles.presetOption}>
          <Text style={workStyles.body}>{option}</Text>
        </Pressable>)}
      </ScrollView>
    </View>}
  </View>;
}

export function WritingPreferencesEditor({ api, onBack, onBusy }: {
  api: V2Api; onBack(): void; onBusy(busy: boolean): void;
}) {
  const [draft, setDraft] = useState<PresetLines | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const action = useWorkAction();
  useEffect(() => {
    let current = true;
    setError(null);
    void api.writingPreferences().then(value => { if (current) setDraft(preferenceLines(value)); })
      .catch(failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [api, attempt]);
  useEffect(() => { onBusy(action.busy); return () => onBusy(false); }, [action.busy, onBusy]);
  return <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1, width: '100%', maxWidth: 540, alignSelf: 'center' }}
    contentContainerStyle={workStyles.content}>
    <View style={workStyles.between}>
      <Text style={workStyles.heading}>자주 쓰는 장소·시간</Text>
      <WorkButton label="뒤로" secondary disabled={action.busy} onPress={onBack} />
    </View>
    {error ? <>
      <WorkMessage error>{error}</WorkMessage>
      <WorkButton label="다시 불러오기" secondary onPress={() => setAttempt(value => value + 1)} />
    </> : draft === null ? <ActivityIndicator color={colors.ink} /> : <View style={workStyles.panel}>
      <PreferenceFields value={draft} onChange={setDraft} disabled={action.busy} />
      {action.error && <WorkMessage error>{action.error}</WorkMessage>}
      <WorkButton label="저장하기" busy={action.busy} onPress={() => { void action.run(async () => {
        await api.saveWritingPreferences(parsePreferenceLines(draft));
        onBack();
      }); }} />
    </View>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  presetField: { flex: 1, minWidth: 115, position: 'relative' },
  presetList: { position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, borderWidth: 1,
    borderColor: colors.line, borderRadius: 10, backgroundColor: colors.white },
  presetScroll: { maxHeight: 152, borderRadius: 9 },
  presetOption: { minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' },
});
