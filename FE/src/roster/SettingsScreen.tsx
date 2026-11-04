import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Child } from '../api/client';
import type { Account } from '../auth/controller';
import { colors } from '../ui/theme';
import { createRosterController } from './controller';

function ChildRow({ child, disabled, rename, deactivate }: {
  child: Child; disabled: boolean; rename(name: string): Promise<boolean>; deactivate(): void;
}) {
  const [name, setName] = useState(child.name);
  useEffect(() => setName(child.name), [child.name]);
  return <View style={styles.child}>
    <Text style={styles.label}>{child.name}{child.is_active ? '' : ' · 비활성'}</Text>
    <TextInput accessibilityLabel={child.name + ' 이름'} value={name} onChangeText={setName} editable={!disabled} style={styles.input} />
    <View style={styles.row}>
      <Pressable accessibilityRole="button" disabled={disabled || !name.trim() || name === child.name}
        style={[styles.smallButton, (disabled || !name.trim() || name === child.name) && styles.disabled]}
        onPress={() => { void rename(name); }}><Text style={styles.label}>이름 저장</Text></Pressable>
      {child.is_active && <Pressable accessibilityRole="button" disabled={disabled} style={styles.smallButton} onPress={deactivate}>
        <Text style={styles.danger}>비활성화</Text></Pressable>}
    </View>
  </View>;
}

export function SettingsScreen({ account, onClose, onSavingChange }: { account: Account; onClose(): void; onSavingChange(saving: boolean): void }) {
  const controller = useMemo(() => createRosterController(account.api, account.session.token, account.unauthorized),
    [account.api, account.session.token]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<Child | null>(null);
  const insets = useSafeAreaInsets();
  const busy = state.saving || state.loading || account.busy;
  useEffect(() => { void controller.refresh(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { onSavingChange(state.saving); return () => onSavingChange(false); }, [state.saving, onSavingChange]);
  return <View style={[styles.page, { paddingTop: insets.top + 12, paddingBottom: insets.bottom }]}>
    <View style={styles.header}>
      <Text style={styles.title}>설정</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="설정 닫기" disabled={state.saving || account.busy}
        style={styles.smallButton} onPress={onClose}><Text style={styles.label}>닫기</Text></Pressable>
    </View>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.card}><Text style={styles.label}>{account.session.teacher.display_name} 선생님</Text>
        <Pressable accessibilityRole="button" disabled={busy} style={styles.smallButton} onPress={() => { void account.logout(); }}>
          <Text style={styles.danger}>{account.busy ? '로그아웃 중…' : '로그아웃'}</Text></Pressable>
        {account.notice && <Text accessibilityRole="alert" style={styles.danger}>{account.notice}</Text>}
      </View>
      <View style={styles.card}>
        <Text style={styles.subtitle}>아동 명단</Text>
        <Text style={styles.hint}>등록한 전체 활성 명단을 관찰일지 작성에 사용해요.</Text>
        <TextInput accessibilityLabel="새 아동 이름" placeholder="아동 이름" value={name} onChangeText={setName} editable={!busy} style={styles.input} />
        <Pressable accessibilityRole="button" disabled={busy || !state.loaded || !name.trim()}
          style={[styles.button, (busy || !state.loaded || !name.trim()) && styles.disabled]}
          onPress={async () => { if (await controller.create(name)) setName(''); }}><Text style={styles.label}>아동 추가</Text></Pressable>
        <View style={styles.row}><Text style={styles.hint}>비활성 아동도 보기</Text>
          <Switch accessibilityLabel="비활성 아동도 보기" value={state.includeInactive} disabled={busy}
            onValueChange={value => { setConfirm(null); void controller.refresh(value); }} /></View>
        <Pressable accessibilityRole="button" disabled={busy} style={styles.smallButton} onPress={() => { void controller.refresh(); }}>
          <Text style={styles.label}>새로고침</Text></Pressable>
        {state.loading && <ActivityIndicator color={colors.ink} accessibilityLabel="명단 불러오는 중" />}
        {state.notice && <Text accessibilityRole="alert" style={styles.hint}>{state.notice}</Text>}
        {state.loaded && !state.loading && state.items.length === 0 && <Text style={styles.hint}>등록된 아동이 없어요.</Text>}
        {state.items.map(child => <ChildRow key={child.child_id} child={child} disabled={busy || confirm !== null}
          rename={value => controller.rename(child.child_id, value)} deactivate={() => setConfirm(child)} />)}
        {confirm && <View style={styles.confirm} accessibilityRole="alert">
          <Text style={styles.label}>{confirm.name} 아동을 비활성화할까요?</Text>
          <Text style={styles.hint}>명단에서 제외되며 아동 ID와 과거 기록은 유지돼요.</Text>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" style={styles.smallButton} disabled={busy} onPress={() => setConfirm(null)}><Text>취소</Text></Pressable>
            <Pressable accessibilityRole="button" style={styles.smallButton} disabled={busy}
              onPress={async () => { if (await controller.deactivate(confirm.child_id)) setConfirm(null); }}><Text style={styles.danger}>비활성화 확인</Text></Pressable>
          </View>
        </View>}
      </View>
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  header: { width: '100%', maxWidth: 540, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24 },
  scroll: { flex: 1, width: '100%', maxWidth: 540, alignSelf: 'center' },
  title: { color: colors.ink, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.ink, fontSize: 19, fontWeight: '700' },
  content: { padding: 24, gap: 18, paddingBottom: 40 },
  card: { backgroundColor: colors.white, padding: 20, borderRadius: 20, gap: 14 },
  label: { color: colors.ink, fontWeight: '600', fontSize: 15 },
  hint: { color: colors.muted, lineHeight: 21 }, danger: { color: colors.rose, lineHeight: 21 },
  input: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 12, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  button: { backgroundColor: colors.yellow, padding: 14, alignItems: 'center', borderRadius: 12, minHeight: 48 },
  smallButton: { padding: 12, minHeight: 44, justifyContent: 'center' }, disabled: { opacity: 0.45 },
  child: { borderTopWidth: 1, borderColor: colors.line, paddingTop: 16, gap: 10 },
  confirm: { backgroundColor: colors.yellowLight, padding: 16, borderRadius: 12, gap: 12 },
});
