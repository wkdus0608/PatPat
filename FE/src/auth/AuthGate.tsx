import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createApi } from '../api/client';
import { colors } from '../ui/theme';
import { createAuthController, type Account } from './controller';
import { createTokenStore } from './tokenStore';

const server = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

export function AuthGate({ children }: { children(account: Account): ReactNode }) {
  const api = useMemo(() => createApi(server), []);
  const controller = useMemo(() => createAuthController(api, createTokenStore(server)), [api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const insets = useSafeAreaInsets();
  useEffect(() => { void controller.restore(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { if (state.phase === 'signedIn') setPassword(''); }, [state.phase]);
  if (state.phase === 'signedIn' && state.session) {
    const token = state.session.token;
    return children({ api, session: state.session, logout: controller.logout, busy: state.busy, notice: state.notice,
      unauthorized: error => { void controller.unauthorized(error, token); } });
  }
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.page, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <ScrollView style={{ width: '100%' }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center' }} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.brand}>PatPat</Text>
        <Text style={styles.title}>선생님, 안녕하세요</Text>
        <Text style={styles.hint}>준비된 테스트 계정으로 로그인해 주세요.</Text>
        {state.phase === 'restoring' ? <ActivityIndicator color={colors.ink} accessibilityLabel="로그인 확인 중" /> :
          state.phase === 'unavailable' ? <>
            <Text accessibilityRole="alert" style={styles.notice}>{state.notice}</Text>
            <Pressable style={styles.button} disabled={state.busy} onPress={() => { void controller.restore(); }}><Text>다시 시도</Text></Pressable>
            <Pressable style={styles.link} disabled={state.busy} onPress={() => { void controller.logout(); }}><Text>다른 계정으로 로그인</Text></Pressable>
          </> : <>
            <Text style={styles.label}>계정 ID</Text>
            <TextInput accessibilityLabel="계정 ID" autoCapitalize="none" autoCorrect={false} autoComplete="username"
              value={loginId} onChangeText={setLoginId} editable={!state.busy} style={styles.input} />
            <Text style={styles.label}>비밀번호</Text>
            <TextInput accessibilityLabel="비밀번호" secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password"
              value={password} onChangeText={setPassword} editable={!state.busy} style={styles.input}
              onSubmitEditing={() => { void controller.login(loginId, password); }} />
            {state.notice && <Text accessibilityRole="alert" style={styles.notice}>{state.notice}</Text>}
            <Pressable accessibilityRole="button" accessibilityLabel="로그인" disabled={state.busy || !loginId.trim() || !password}
              style={[styles.button, (state.busy || !loginId.trim() || !password) && styles.disabled]}
              onPress={() => { void controller.login(loginId, password); }}>
              {state.busy ? <ActivityIndicator color={colors.ink} /> : <Text style={styles.buttonText}>로그인</Text>}
            </Pressable>
          </>}
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, backgroundColor: colors.background },
  card: { width: '100%', maxWidth: 440, backgroundColor: colors.white, borderRadius: 24, padding: 24, gap: 12 },
  brand: { color: colors.ink, fontSize: 30, fontWeight: '800' },
  title: { color: colors.ink, fontSize: 22, fontWeight: '700' },
  hint: { color: colors.muted, lineHeight: 22, marginBottom: 12 },
  label: { color: colors.ink, fontWeight: '600' },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 12, color: colors.ink, backgroundColor: colors.background },
  notice: { color: colors.rose, lineHeight: 22 },
  button: { minHeight: 50, backgroundColor: colors.yellow, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  disabled: { opacity: 0.5 }, buttonText: { color: colors.ink, fontWeight: '700', fontSize: 16 },
  link: { padding: 12, alignItems: 'center' },
});
