import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createApi, errorMessage } from '../api/client';
import { createV2Api } from '../api/v2';
import { colors } from '../ui/theme';
import { createAuthController, type Account } from './controller';
import { createTokenStore } from './tokenStore';

const server = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

export function AuthGate({ children }: { children(account: Account): ReactNode }) {
  const api = useMemo(() => createApi(server), []);
  const controller = useMemo(() => createAuthController(api, createTokenStore(server)), [api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [signupError, setSignupError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const insets = useSafeAreaInsets();
  const token = state.session?.token;
  const unauthorized = useCallback((error: unknown) => {
    if (token) void controller.unauthorized(error, token);
  }, [controller, token]);
  useEffect(() => { void controller.restore(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { if (state.phase === 'signedIn') setPassword(''); }, [state.phase]);
  if (state.phase === 'signedIn' && state.session) {
    return children({ api, session: state.session, logout: controller.logout, busy: state.busy, notice: state.notice, unauthorized });
  }
  const signingUp = mode === 'signup';
  const busy = state.busy || creating;
  function changeMode() {
    setMode(signingUp ? 'login' : 'signup');
    setPassword('');
    setConfirmation('');
    setSignupError(null);
  }
  async function submit() {
    if (state.busy || creatingRef.current) return;
    if (!signingUp) {
      await controller.login(loginId, password);
      return;
    }
    if (!displayName.trim()) { setSignupError('선생님 이름을 입력해 주세요.'); return; }
    if (!loginId.trim()) { setSignupError('계정 ID를 입력해 주세요.'); return; }
    if (!password) { setSignupError('비밀번호를 입력해 주세요.'); return; }
    if (password !== confirmation) { setSignupError('비밀번호가 일치하지 않아요.'); return; }
    creatingRef.current = true;
    setCreating(true);
    setSignupError(null);
    try {
      await createV2Api(api.baseUrl, null).signup(loginId.trim(), displayName.trim(), password);
      setMode('login');
      setConfirmation('');
      await controller.login(loginId.trim(), password);
    } catch (error) {
      setSignupError(errorMessage(error));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.page, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <ScrollView style={{ width: '100%' }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center' }} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.brand}>PatPat</Text>
        <Text style={styles.title}>{signingUp ? '교사 계정 만들기' : '선생님, 안녕하세요'}</Text>
        <Text style={styles.hint}>{signingUp ? '계정을 만들고 우리 반을 설정해 보세요.' : '교사 계정으로 로그인해 주세요.'}</Text>
        {state.phase === 'restoring' ? <ActivityIndicator color={colors.ink} accessibilityLabel="로그인 확인 중" /> :
          state.phase === 'unavailable' ? <>
            <Text accessibilityRole="alert" style={styles.notice}>{state.notice}</Text>
            <Pressable style={styles.button} disabled={state.busy} onPress={() => { void controller.restore(); }}><Text>다시 시도</Text></Pressable>
            <Pressable style={styles.link} disabled={state.busy} onPress={() => { void controller.logout(); }}><Text>다른 계정으로 로그인</Text></Pressable>
          </> : <>
            {signingUp && <>
              <Text style={styles.label}>선생님 이름</Text>
              <TextInput accessibilityLabel="선생님 이름" value={displayName} onChangeText={setDisplayName}
                maxLength={60} editable={!busy} style={styles.input} />
            </>}
            <Text style={styles.label}>계정 ID</Text>
            <TextInput accessibilityLabel="계정 ID" autoCapitalize="none" autoCorrect={false} autoComplete="username"
              value={loginId} onChangeText={setLoginId} editable={!busy} style={styles.input} />
            <Text style={styles.label}>비밀번호</Text>
            <TextInput accessibilityLabel="비밀번호" secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password"
              value={password} onChangeText={setPassword} editable={!busy} style={styles.input}
              onSubmitEditing={signingUp ? undefined : () => { void submit(); }} />
            {signingUp && <>
              <Text style={styles.label}>비밀번호 확인</Text>
              <TextInput accessibilityLabel="비밀번호 확인" secureTextEntry autoCapitalize="none" autoCorrect={false}
                value={confirmation} onChangeText={setConfirmation} editable={!busy} style={styles.input}
                onSubmitEditing={() => { void submit(); }} />
            </>}
            {(signingUp ? signupError : state.notice) && <Text accessibilityRole="alert" style={styles.notice}>
              {signingUp ? signupError : state.notice}
            </Text>}
            <Pressable accessibilityRole="button" accessibilityLabel={signingUp ? '계정 만들기' : '로그인'}
              disabled={busy || (!signingUp && (!loginId.trim() || !password))}
              style={[styles.button, (busy || (!signingUp && (!loginId.trim() || !password))) && styles.disabled]}
              onPress={() => { void submit(); }}>
              {busy ? <ActivityIndicator color={colors.ink} /> : <Text style={styles.buttonText}>{signingUp ? '계정 만들기' : '로그인'}</Text>}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={signingUp ? '로그인으로 돌아가기' : '회원가입'}
              disabled={busy} style={styles.link} onPress={changeMode}>
              <Text style={styles.buttonText}>{signingUp ? '로그인으로 돌아가기' : '회원가입'}</Text>
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
