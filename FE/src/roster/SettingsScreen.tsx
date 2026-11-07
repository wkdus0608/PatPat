import { Ionicons } from '@expo/vector-icons';
import { forwardRef, useEffect, useImperativeHandle, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Child } from '../api/client';
import type { Account } from '../auth/controller';
import type { V2Api } from '../api/v2';
import { colors } from '../ui/theme';
import { WritingPreferencesEditor } from '../writing/WritingPreferences';
import {
  getCharacteristicsEntry, getTeacherDocumentEntry, hasUnsavedTeacherDocuments,
  isCharacteristicsDirty, isTeacherDocumentDirty,
  type CharacteristicsEntry, type DialogAction, type RosterController, type RosterState,
} from './controller';
import { TEACHER_DOCUMENTS, type TeacherDocumentKind } from './teacherDocuments';

export interface SettingsHandle { back(): void }
export interface SettingsViewProps {
  account: Account; state: RosterState; name: string;
  onNameChange(name: string): void;
  onBack(): void; onAdd(): void; onRefresh(): void; onSelect(): void; onCancelSelection(): void;
  onToggle(id: string): void; onRequestDelete(): void; onCancelDelete(): void; onDelete(): void; onLogout(): void;
  onOpenCharacteristics(id: string): void; onCharacteristicsChange(id: string, text: string): void;
  onSaveCharacteristics(): void; onResolveDialog(action: DialogAction): void;
  onOpenTeacherDocument(kind: TeacherDocumentKind): void;
  onTeacherDocumentChange(kind: TeacherDocumentKind, text: string): void;
  onSaveTeacherDocument(): void;
  onOpenWritingPreferences?(): void;
}

function ChildRow({ child, selecting, selected, disabled, onToggle, onOpenCharacteristics }: {
  child: Child; selecting: boolean; selected: boolean; disabled: boolean;
  onToggle(): void; onOpenCharacteristics(): void;
}) {
  const content = <>
    <View style={styles.avatar}><Ionicons name="person-outline" size={22} color={colors.ink} /></View>
    <Text style={styles.childName} testID={'settings-child-name-' + child.child_id}>{child.name}</Text>
    {selecting ? <Ionicons name={selected ? 'checkbox' : 'square-outline'} size={24} color={selected ? colors.ink : colors.muted} />
      : <Pressable accessibilityRole="button" accessibilityLabel={child.name + ' 특성 작성'}
        accessibilityState={{ disabled }} disabled={disabled} onPress={onOpenCharacteristics}
        style={({ pressed }) => [styles.characteristicsAction, disabled && styles.disabled, pressed && styles.pressed]}
        testID={'settings-child-characteristics-' + child.child_id}>
        <Text style={styles.characteristicsActionText}>특성 작성</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.ink} />
      </Pressable>}
  </>;
  return selecting ? <Pressable accessibilityRole="checkbox" accessibilityLabel={child.name + ' 선택'}
    accessibilityState={{ checked: selected, disabled }} aria-checked={selected} disabled={disabled} onPress={onToggle}
    style={({ pressed }) => [styles.child, selected && styles.selectedChild, pressed && styles.pressed]}
    testID={'settings-child-row-' + child.child_id}>{content}</Pressable>
    : <View style={styles.child} testID={'settings-child-row-' + child.child_id}>{content}</View>;
}

/** Display sorting never changes the controller's server roster order. */
export function SettingsView(props: SettingsViewProps) {
  const showingDialog = props.state.dialog !== null;
  return <View style={styles.screen}>
    <View style={styles.screen} pointerEvents={showingDialog ? 'none' : 'auto'}
      accessibilityElementsHidden={showingDialog} importantForAccessibility={showingDialog ? 'no-hide-descendants' : 'auto'}
      aria-hidden={showingDialog} testID="settings-content">
      <SettingsContent {...props} />
    </View>
    {showingDialog && <SettingsDialogView {...props} />}
  </View>;
}

function SettingsDialogView({ state, account, onResolveDialog }: SettingsViewProps) {
  const dialog = state.dialog;
  if (!dialog) return null;
  const disabled = state.saving || account.busy;
  const teacherKind = 'teacherKind' in dialog ? dialog.teacherKind : undefined;
  const teacherDataInvolved = teacherKind !== undefined || hasUnsavedTeacherDocuments(state);
  const message = dialog.kind === 'saved' ? teacherKind !== undefined
    ? TEACHER_DOCUMENTS[teacherKind].successMessage : '아동 특성을 저장했어요.'
    : dialog.kind === 'saveFailed' ? dialog.unavailable
      ? '아직 저장 기능이 연결되지 않았어요. 입력한 내용은 유지돼요.'
      : '저장하지 못했어요. 입력한 내용은 유지돼요. 다시 시도해 주세요.'
    : dialog.kind === 'leave' ? '아직 저장하지 않은 내용이 있어요. 입력한 내용은 이번 로그인 동안 유지돼요.'
      : teacherDataInvolved ? '로그아웃하면 저장하지 않은 내용이 사라져요.'
        : '로그아웃하면 저장하지 않은 아동 특성이 사라져요.';
  const actions: { action: DialogAction; label: string; primary?: boolean }[] = dialog.kind === 'saved'
    || (dialog.kind === 'saveFailed' && dialog.unavailable) ? [{ action: 'dismiss', label: '확인', primary: true }]
    : dialog.kind === 'saveFailed' ? [{ action: 'dismiss', label: '확인' }, { action: 'retry', label: '다시 시도', primary: true }]
      : dialog.kind === 'leave' ? [{ action: 'stay', label: '계속 작성' }, { action: 'leave', label: '나가기', primary: true }]
        : [{ action: 'stay', label: '취소' }, { action: 'logout', label: '로그아웃', primary: true }];
  return <View style={styles.dialogOverlay} testID="settings-dialog-overlay">
    <ScrollView style={styles.dialogScroll} contentContainerStyle={styles.dialogCard} keyboardShouldPersistTaps="handled"
      accessibilityViewIsModal aria-modal accessibilityRole="alert" testID="settings-dialog">
      <Text style={styles.subtitle}>{dialog.kind === 'saved' ? '저장 완료' : dialog.kind === 'saveFailed' ? '저장 확인' : '잠깐 확인해 주세요'}</Text>
      <Text style={styles.dialogMessage}>{message}</Text>
      <View style={styles.dialogActions}>
        {actions.map(({ action, label, primary }) => <Pressable key={action} accessibilityRole="button" accessibilityLabel={label}
          accessibilityState={{ disabled }} disabled={disabled} onPress={() => onResolveDialog(action)}
          style={[styles.dialogButton, primary ? styles.button : styles.smallButton, disabled && styles.disabled]}
          testID={'settings-dialog-' + action}><Text style={styles.label}>{label}</Text></Pressable>)}
      </View>
    </ScrollView>
  </View>;
}

interface ReferenceEditorProps {
  title: string; prompt: string; hint: string; placeholder: string;
  prefix: string; inputKey: string; subjectName?: string;
  hideSaveHints?: boolean;
  backLabel: string; loadingLabel: string; loadError: string;
  entry: Readonly<CharacteristicsEntry>; text: string; dirty: boolean;
  busy: boolean; navigationBlocked: boolean;
  onBack(): void; onChange(text: string): void; onSave(): void;
}

function ReferenceEditor(props: ReferenceEditorProps) {
  const { entry, prefix, dirty } = props;
  const canSave = !props.busy && dirty && (entry.loadState === 'ready' || entry.loadState === 'unavailable');
  const status = entry.saveState === 'error' ? '저장하지 못했어요.'
    : entry.saveState === 'unavailable' ? '아직 저장되지 않았어요.'
      : dirty ? props.hideSaveHints ? null : '아직 저장하지 않은 내용이 있어요.'
        : entry.loadState === 'ready' && entry.savedText !== null ? '저장됨' : null;
  return <>
    <View style={[styles.header, styles.characteristicsHeader]}>
      <Pressable accessibilityRole="button" accessibilityLabel={props.backLabel} disabled={props.navigationBlocked}
        accessibilityState={{ disabled: props.navigationBlocked }} onPress={props.onBack}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]} testID={prefix + '-back'}>
        <Ionicons name="chevron-back" size={20} color={colors.ink} />
        <Text style={styles.label}>뒤로</Text>
      </Pressable>
      <Text style={[styles.title, styles.characteristicsTitle]}>{props.title}</Text>
    </View>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {props.subjectName !== undefined && <Text style={styles.subtitle} testID={prefix + '-child-name'}>{props.subjectName}</Text>}
      <View style={styles.card} testID={prefix + '-card'}>
        <Text style={styles.subtitle}>{props.prompt}</Text>
        <Text style={styles.hint}>{props.hint}</Text>
        <TextInput key={props.inputKey} accessibilityLabel={props.title}
          accessibilityState={{ disabled: props.busy }} aria-disabled={props.busy} placeholder={props.placeholder}
          placeholderTextColor={colors.muted} multiline textAlignVertical="top" editable={!props.busy}
          value={props.text} onChangeText={props.onChange} style={[styles.input, styles.characteristicsInput]}
          testID={prefix + '-input'} />
        <Pressable accessibilityRole="button" accessibilityLabel={props.title + ' 저장하기'} disabled={!canSave}
          accessibilityState={{ disabled: !canSave, busy: entry.saveState === 'saving' }} onPress={props.onSave}
          style={[styles.button, !canSave && styles.disabled]} testID={prefix + '-save'}>
          {entry.saveState === 'saving' && <ActivityIndicator color={colors.ink} />}
          <Text style={styles.label}>{entry.saveState === 'saving' ? '저장 중…' : '저장하기'}</Text>
        </Pressable>
        {!props.hideSaveHints && <Text style={styles.hint}>작성한 뒤 저장하기를 눌러주세요.</Text>}
        {entry.loadState === 'loading' && <ActivityIndicator color={colors.ink} accessibilityLabel={props.loadingLabel} />}
        {entry.loadState === 'error' && <Text accessibilityRole="alert" style={styles.danger}>{props.loadError}</Text>}
        {status && <Text accessibilityLiveRegion="polite" style={entry.saveState === 'error' ? styles.danger : styles.hint}
          testID={prefix + '-status'}>{status}</Text>}
      </View>
    </ScrollView>
  </>;
}

function SettingsContent(props: SettingsViewProps) {
  const { account, state } = props;
  const busy = state.saving || state.loading || account.busy || state.dialog !== null;
  const navigationBlocked = state.saving || account.busy || state.dialog !== null;
  const teacherKind = state.teacherDocumentKind;
  if (teacherKind !== null) {
    const definition = TEACHER_DOCUMENTS[teacherKind];
    const entry = getTeacherDocumentEntry(state, teacherKind);
    return <ReferenceEditor {...definition} prefix={'settings-teacher-' + teacherKind} inputKey={'teacher-' + teacherKind}
      backLabel="교사 설정으로 돌아가기" loadingLabel={definition.title + ' 불러오는 중'}
      loadError="저장한 내용을 불러오지 못했어요. 화면에 다시 들어와 확인해 주세요."
      entry={entry} text={state.teacherDocumentDrafts.get(teacherKind) ?? entry.savedText ?? ''}
      dirty={isTeacherDocumentDirty(state, teacherKind)} busy={busy} navigationBlocked={navigationBlocked}
      onBack={props.onBack} onChange={text => props.onTeacherDocumentChange(teacherKind, text)}
      onSave={props.onSaveTeacherDocument} />;
  }
  const characteristicsChild = state.items.find(child => child.child_id === state.characteristicsChildId);
  if (characteristicsChild) {
    const entry = getCharacteristicsEntry(state, characteristicsChild.child_id);
    return <ReferenceEditor title="아동 특성" prompt="아동에 대해 알려주세요."
      hint="좋아하는 놀이, 평소 표현 방식, 도움이 필요한 상황을 자유롭게 적어주세요."
      placeholder="아동의 특성을 자유롭게 적어주세요." prefix="settings-characteristics"
      hideSaveHints
      inputKey={'child-' + characteristicsChild.child_id} subjectName={characteristicsChild.name}
      backLabel="아동 명단으로 돌아가기" loadingLabel="아동 특성 불러오는 중"
      loadError="저장한 특성을 불러오지 못했어요. 화면에 다시 들어와 확인해 주세요."
      entry={entry} text={state.characteristicsDrafts.get(characteristicsChild.child_id) ?? entry.savedText ?? ''}
      dirty={isCharacteristicsDirty(state, characteristicsChild.child_id)} busy={busy} navigationBlocked={navigationBlocked}
      onBack={props.onBack} onChange={text => props.onCharacteristicsChange(characteristicsChild.child_id, text)}
      onSave={props.onSaveCharacteristics} />;
  }
  const sorted = [...state.items].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const selected = new Set(state.selectedIds);
  const selectedChildren = sorted.filter(child => selected.has(child.child_id));
  const canAdd = !busy && state.loaded && !state.selecting && !!props.name.trim();
  return <>
    <View style={styles.header}>
      <Text style={styles.title}>설정</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="설정 닫기" disabled={navigationBlocked}
        accessibilityState={{ disabled: navigationBlocked }} style={styles.smallButton} onPress={props.onBack}
        testID="settings-close"><Text style={styles.label}>닫기</Text></Pressable>
    </View>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.label} testID="settings-teacher-name">{account.session.teacher.display_name} 선생님</Text>
        {(['writing_examples', 'record_format'] as const).map(kind => <Pressable key={kind}
          accessibilityRole="button" accessibilityLabel={TEACHER_DOCUMENTS[kind].title}
          accessibilityState={{ disabled: busy || state.selecting }} disabled={busy || state.selecting}
          onPress={() => props.onOpenTeacherDocument(kind)}
          style={({ pressed }) => [styles.teacherAction, (busy || state.selecting) && styles.disabled, pressed && styles.pressed]}
          testID={'settings-teacher-open-' + kind}>
          <Text style={[styles.label, styles.teacherActionLabel]}>{TEACHER_DOCUMENTS[kind].title}</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.ink} />
        </Pressable>)}
        {props.onOpenWritingPreferences && <Pressable accessibilityRole="button" accessibilityLabel="자주 쓰는 장소·시간"
          disabled={busy || state.selecting} onPress={props.onOpenWritingPreferences}
          style={[styles.teacherAction, (busy || state.selecting) && styles.disabled]}>
          <Text style={[styles.label, styles.teacherActionLabel]}>자주 쓰는 장소·시간</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.ink} />
        </Pressable>}
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
          selected={selected.has(child.child_id)} disabled={busy || !state.loaded} onToggle={() => props.onToggle(child.child_id)}
          onOpenCharacteristics={() => props.onOpenCharacteristics(child.child_id)} />)}
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
  account: Account; controller: RosterController; apiV2?: V2Api; onClose(): void; onSavingChange(saving: boolean): void;
}>(function SettingsScreen({ account, controller, apiV2, onClose, onSavingChange }, ref) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [name, setName] = useState('');
  const [showPreferences, setShowPreferences] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const insets = useSafeAreaInsets();
  useEffect(() => { void controller.refresh(); }, [controller]);
  useEffect(() => { onSavingChange(state.saving || savingPreferences); return () => onSavingChange(false); },
    [state.saving, savingPreferences, onSavingChange]);
  function back() {
    if (account.busy) return;
    Keyboard.dismiss();
    if (showPreferences) {
      if (!savingPreferences) setShowPreferences(false);
      return;
    }
    if (controller.back()) onClose();
  }
  function resolveDialog(action: DialogAction) {
    if (account.busy) return;
    Keyboard.dismiss();
    const destination = controller.resolveDialog(action);
    if (destination === 'close') onClose();
    else if (destination === 'logout') void account.logout();
  }
  useImperativeHandle(ref, () => ({ back }), [controller, account.busy, onClose, showPreferences, savingPreferences]);
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
    style={[styles.page, { paddingTop: insets.top + 12, paddingBottom: insets.bottom }]}>
    {showPreferences && apiV2 ? <WritingPreferencesEditor api={apiV2} onBack={() => setShowPreferences(false)}
      onBusy={setSavingPreferences} /> :
    <SettingsView account={account} state={state} name={name} onNameChange={setName} onBack={back}
      onAdd={() => { void controller.create(name).then(saved => { if (saved) setName(''); }); }}
      onRefresh={() => { void controller.refresh(); }} onSelect={controller.beginSelection}
      onCancelSelection={controller.cancelSelection} onToggle={controller.toggleSelection}
      onRequestDelete={controller.requestDelete} onCancelDelete={controller.cancelDelete}
      onDelete={() => { void controller.deleteSelected(); }}
      onOpenCharacteristics={id => { if (!account.busy) { Keyboard.dismiss(); void controller.openCharacteristics(id); } }}
      onCharacteristicsChange={(id, text) => { if (!account.busy) controller.changeCharacteristics(id, text); }}
      onSaveCharacteristics={() => { if (!account.busy) { Keyboard.dismiss(); void controller.saveCharacteristics(); } }}
      onOpenTeacherDocument={kind => { if (!account.busy) { Keyboard.dismiss(); void controller.openTeacherDocument(kind); } }}
      onTeacherDocumentChange={(kind, text) => { if (!account.busy) controller.changeTeacherDocument(kind, text); }}
      onSaveTeacherDocument={() => { if (!account.busy) { Keyboard.dismiss(); void controller.saveTeacherDocument(); } }}
      onOpenWritingPreferences={apiV2 ? () => { Keyboard.dismiss(); setShowPreferences(true); } : undefined}
      onResolveDialog={resolveDialog}
      onLogout={() => { if (!account.busy && controller.requestLogout()) { Keyboard.dismiss(); void account.logout(); } }} />}
  </KeyboardAvoidingView>;
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
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
  childName: { flex: 1, minWidth: 0, color: colors.ink, fontWeight: '600', fontSize: 15, lineHeight: 23 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.yellowLight, alignItems: 'center', justifyContent: 'center' },
  selectedChild: { backgroundColor: '#FFF9E8' }, pressed: { opacity: 0.6 },
  confirm: { backgroundColor: colors.yellowLight, padding: 16, borderRadius: 12, gap: 12 },
  footer: { width: '100%', maxWidth: 540, alignSelf: 'center', padding: 20, gap: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white },
  deleteButton: { flex: 1 },
  characteristicsAction: { minHeight: 44, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.yellowLight, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0 },
  characteristicsActionText: { color: colors.ink, fontWeight: '600', fontSize: 13 },
  teacherAction: { minHeight: 48, padding: 14, borderRadius: 12, backgroundColor: colors.yellowLight, flexDirection: 'row', alignItems: 'center', gap: 12 },
  teacherActionLabel: { flex: 1, flexShrink: 1 },
  characteristicsHeader: { justifyContent: 'flex-start', gap: 16 },
  characteristicsTitle: { flexShrink: 1 },
  backButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 2 },
  characteristicsInput: { minHeight: 240, fontSize: 15, lineHeight: 24 },
  dialogOverlay: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: '#49372C66', padding: 24, justifyContent: 'center', alignItems: 'center' },
  dialogScroll: { width: '100%', maxWidth: 440, maxHeight: '90%', flexGrow: 0, borderRadius: 20, backgroundColor: colors.white },
  dialogCard: { padding: 24, gap: 18 },
  dialogMessage: { color: colors.ink, fontSize: 15, lineHeight: 24 },
  dialogActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10 },
  dialogButton: { minWidth: 88 },
});
