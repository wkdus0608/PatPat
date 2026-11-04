import { Ionicons } from '@expo/vector-icons';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Child } from '../api/client';
import type { Account } from '../auth/controller';
import { colors } from '../ui/theme';
import { createRosterController, type RosterState } from './controller';

export interface SettingsHandle { back(): void }
export interface SettingsViewProps {
  account: Account; state: RosterState; name: string;
  onNameChange(name: string): void;
  onBack(): void; onAdd(): void; onRefresh(): void; onSelect(): void; onCancelSelection(): void;
  onToggle(id: string): void; onRequestDelete(): void; onCancelDelete(): void; onDelete(): void; onLogout(): void;
}

function ChildRow({ child, selecting, selected, disabled, onToggle }: {
  child: Child; selecting: boolean; selected: boolean; disabled: boolean; onToggle(): void;
}) {
  const content = <>
    <View style={styles.avatar}><Ionicons name="person-outline" size={22} color={colors.ink} /></View>
    <Text style={styles.childName} testID={'settings-child-name-' + child.child_id}>{child.name}</Text>
    {selecting && <Ionicons name={selected ? 'checkbox' : 'square-outline'} size={24} color={selected ? colors.ink : colors.muted} />}
  </>;
  return selecting ? <Pressable accessibilityRole="checkbox" accessibilityLabel={child.name + ' 선택'}
    accessibilityState={{ checked: selected, disabled }} aria-checked={selected} disabled={disabled} onPress={onToggle}
    style={({ pressed }) => [styles.child, selected && styles.selectedChild, pressed && styles.pressed]}
    testID={'settings-child-row-' + child.child_id}>{content}</Pressable>
    : <View style={styles.child} testID={'settings-child-row-' + child.child_id}>{content}</View>;
}

/** Display sorting never changes the controller's server roster order. */
export function SettingsView(props: SettingsViewProps) {
  const { account, state } = props;
  const busy = state.saving || state.loading || account.busy;
  const sorted = [...state.items].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const selected = new Set(state.selectedIds);
  const selectedChildren = sorted.filter(child => selected.has(child.child_id));
  const canAdd = !busy && state.loaded && !state.selecting && !!props.name.trim();
  return <>
    <View style={styles.header}>
      <Text style={styles.title}>설정</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="설정 닫기" disabled={state.saving || account.busy}
        accessibilityState={{ disabled: state.saving || account.busy }} style={styles.smallButton} onPress={props.onBack}
        testID="settings-close"><Text style={styles.label}>닫기</Text></Pressable>
    </View>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.label}>{account.session.teacher.display_name} 선생님</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="로그아웃" disabled={busy}
          accessibilityState={{ disabled: busy }} style={styles.smallButton} onPress={props.onLogout} testID="settings-logout">
          <Text style={styles.danger}>{account.busy ? '로그아웃 중…' : '로그아웃'}</Text>
        </Pressable>
        {account.notice && <Text accessibilityRole="alert" style={styles.danger}>{account.notice}</Text>}
      </View>
      <View style={styles.card}>
        <Text style={styles.subtitle}>아동 명단</Text>
        <Text style={styles.hint}>등록한 아동의 명단으로 관찰일지를 작성해요.</Text>
        <TextInput accessibilityLabel="새 아동 이름" placeholder="아동 이름" value={props.name}
          onChangeText={props.onNameChange} editable={!busy && !state.selecting} style={styles.input}
          onSubmitEditing={() => { if (canAdd) props.onAdd(); }} testID="settings-child-input" />
        <Pressable accessibilityRole="button" accessibilityLabel="아동 추가" disabled={!canAdd}
          accessibilityState={{ disabled: !canAdd }} style={[styles.button, !canAdd && styles.disabled]}
          onPress={props.onAdd} testID="settings-child-add"><Text style={styles.label}>아동 추가</Text></Pressable>
        <View style={styles.row}>
          <Text style={styles.count}>아동 {state.items.length}명</Text>
          <View style={styles.tools}>
            {!state.confirming && <Pressable accessibilityRole="button" accessibilityLabel={state.selecting ? '선택 취소' : '아동 선택'}
              disabled={busy || !state.loaded || state.items.length === 0}
              accessibilityState={{ disabled: busy || !state.loaded || state.items.length === 0 }}
              style={styles.smallButton} onPress={state.selecting ? props.onCancelSelection : props.onSelect}
              testID="settings-child-select"><Text style={styles.label}>{state.selecting ? '취소' : '선택'}</Text></Pressable>}
            <Pressable accessibilityRole="button" accessibilityLabel="명단 새로고침" disabled={busy}
              accessibilityState={{ disabled: busy }} style={styles.smallButton} onPress={props.onRefresh}
              testID="settings-child-refresh"><Ionicons name="refresh-outline" size={21} color={colors.muted} /></Pressable>
          </View>
        </View>
        {state.loading && <ActivityIndicator color={colors.ink} accessibilityLabel="명단 불러오는 중" />}
        {state.notice && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.hint}>{state.notice}</Text>}
        {state.loaded && !state.loading && state.items.length === 0 && <Text style={styles.hint}>등록된 아동이 없어요.</Text>}
        {state.confirming ? <View style={styles.confirm} accessibilityRole="alert" testID="settings-delete-confirmation">
          <Text style={styles.label}>선택한 아동 {selectedChildren.length}명을 명단에서 삭제할까요?</Text>
          {selectedChildren.map(child => <Text key={child.child_id} style={styles.label}>{child.name}</Text>)}
          <Text style={styles.hint}>기존 관찰일지는 유지돼요.</Text>
        </View> : sorted.map(child => <ChildRow key={child.child_id} child={child} selecting={state.selecting}
          selected={selected.has(child.child_id)} disabled={busy} onToggle={() => props.onToggle(child.child_id)} />)}
      </View>
    </ScrollView>
    {state.selecting && <View style={styles.footer} testID="settings-delete-actions">
      {state.confirming ? <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="삭제 취소" disabled={busy}
          accessibilityState={{ disabled: busy }} style={styles.smallButton} onPress={props.onCancelDelete}
          testID="settings-delete-cancel"><Text style={styles.label}>취소</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="삭제 확인" disabled={busy}
          accessibilityState={{ disabled: busy, busy: state.saving }} style={[styles.button, styles.deleteButton, busy && styles.disabled]}
          onPress={props.onDelete} testID="settings-delete-confirm">
          {state.saving ? <ActivityIndicator color={colors.ink} /> : <Text style={styles.danger}>삭제</Text>}
        </Pressable>
      </View> : <>
        <Text style={styles.hint}>{state.selectedIds.length}명 선택</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="선택한 아동 삭제" disabled={busy || state.selectedIds.length === 0}
          accessibilityState={{ disabled: busy || state.selectedIds.length === 0 }}
          style={[styles.button, (busy || state.selectedIds.length === 0) && styles.disabled]}
          onPress={props.onRequestDelete} testID="settings-delete-selected"><Text style={styles.danger}>선택한 아동 삭제</Text></Pressable>
      </>}
    </View>}
  </>;
}

export const SettingsScreen = forwardRef<SettingsHandle, {
  account: Account; onClose(): void; onSavingChange(saving: boolean): void;
}>(function SettingsScreen({ account, onClose, onSavingChange }, ref) {
  const controller = useMemo(() => createRosterController(account.api, account.session.token, account.unauthorized),
    [account.api, account.session.token]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [name, setName] = useState('');
  const insets = useSafeAreaInsets();
  useEffect(() => { void controller.refresh(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { onSavingChange(state.saving); return () => onSavingChange(false); }, [state.saving, onSavingChange]);
  function back() { if (!account.busy && controller.back()) onClose(); }
  useImperativeHandle(ref, () => ({ back }), [controller, account.busy, onClose]);
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
    style={[styles.page, { paddingTop: insets.top + 12, paddingBottom: insets.bottom }]}>
    <SettingsView account={account} state={state} name={name} onNameChange={setName} onBack={back}
      onAdd={() => { void controller.create(name).then(saved => { if (saved) setName(''); }); }}
      onRefresh={() => { void controller.refresh(); }} onSelect={controller.beginSelection}
      onCancelSelection={controller.cancelSelection} onToggle={controller.toggleSelection}
      onRequestDelete={controller.requestDelete} onCancelDelete={controller.cancelDelete}
      onDelete={() => { void controller.deleteSelected(); }}
      onLogout={() => { if (!controller.getSnapshot().saving) void account.logout(); }} />
  </KeyboardAvoidingView>;
});

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  header: { width: '100%', maxWidth: 540, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24 },
  scroll: { flex: 1, width: '100%', maxWidth: 540, alignSelf: 'center' },
  title: { color: colors.ink, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.ink, fontSize: 19, fontWeight: '700' },
  content: { padding: 24, gap: 18, paddingBottom: 24 },
  card: { backgroundColor: colors.white, padding: 20, borderRadius: 20, gap: 14 },
  label: { color: colors.ink, fontWeight: '600', fontSize: 15 },
  hint: { color: colors.muted, lineHeight: 21 }, danger: { color: colors.rose, lineHeight: 21 },
  input: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 12, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  tools: { flexDirection: 'row', alignItems: 'center' }, count: { color: colors.muted, fontSize: 13 },
  button: { backgroundColor: colors.yellow, padding: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 12, minHeight: 48 },
  smallButton: { padding: 12, minHeight: 44, justifyContent: 'center' }, disabled: { opacity: 0.45 },
  child: { borderTopWidth: 1, borderColor: colors.line, paddingVertical: 14, flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 64 },
  childName: { flex: 1, color: colors.ink, fontWeight: '600', fontSize: 15, lineHeight: 23 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.yellowLight, alignItems: 'center', justifyContent: 'center' },
  selectedChild: { backgroundColor: '#FFF9E8' }, pressed: { opacity: 0.6 },
  confirm: { backgroundColor: colors.yellowLight, padding: 16, borderRadius: 12, gap: 12 },
  footer: { width: '100%', maxWidth: 540, alignSelf: 'center', padding: 20, gap: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white },
  deleteButton: { flex: 1 },
});
