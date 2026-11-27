import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createApi, errorMessage } from '../api/client';
import { createV2Api } from '../api/v2';
import { colors, layout } from '../ui/theme';
import { WorkButton, WorkField, WorkMessage, workStyles } from '../ui/WorkFields';
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
  const submitLabel = signingUp ? '계정 만들기' : '로그인';
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
      <ScrollView style={styles.scroll} contentContainerStyle={styles.centered} keyboardShouldPersistTaps="handled">
        <View style={[workStyles.panel, styles.card]}>
          <Text style={workStyles.title}>PatPat</Text>
          <Text accessibilityRole="header" style={workStyles.heading}>{signingUp ? '교사 계정 만들기' : '교사 로그인'}</Text>
          {state.phase === 'restoring' ? <ActivityIndicator color={colors.ink} accessibilityLabel="로그인 확인 중" /> :
            state.phase === 'unavailable' ? <>
              <WorkMessage error>{state.notice}</WorkMessage>
              <WorkButton label="다시 시도" disabled={state.busy} onPress={() => { void controller.restore(); }} />
              <WorkButton label="다른 계정으로 로그인" secondary disabled={state.busy} onPress={() => { void controller.logout(); }} />
            </> : <>
              {signingUp && <WorkField label="선생님 이름" value={displayName} onChangeText={setDisplayName}
                maxLength={60} editable={!busy} />}
              <WorkField label="계정 ID" autoCapitalize="none" autoCorrect={false} autoComplete="username"
                value={loginId} onChangeText={setLoginId} editable={!busy} />
              <WorkField label="비밀번호" secureTextEntry autoCapitalize="none" autoCorrect={false}
                autoComplete={signingUp ? 'new-password' : 'current-password'} value={password} onChangeText={setPassword}
                editable={!busy} onSubmitEditing={signingUp ? undefined : () => { void submit(); }} />
              {signingUp && <WorkField label="비밀번호 확인" secureTextEntry autoCapitalize="none" autoCorrect={false}
                value={confirmation} onChangeText={setConfirmation} editable={!busy} onSubmitEditing={() => { void submit(); }} />}
              {(signingUp ? signupError : state.notice) && <WorkMessage error>{signingUp ? signupError : state.notice}</WorkMessage>}
              <View style={styles.actions}>
                <WorkButton label={submitLabel} busy={busy} disabled={!signingUp && (!loginId.trim() || !password)}
                  onPress={() => { void submit(); }} />
                <WorkButton label={signingUp ? '로그인으로 돌아가기' : '회원가입'} secondary disabled={busy} onPress={changeMode} />
              </View>
            </>}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: layout.gutter, backgroundColor: colors.background },
  scroll: { width: '100%' },
  centered: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  card: { width: '100%', maxWidth: 440, padding: 24, gap: 16 },
  actions: { gap: 8, marginTop: 4 },
});
