import { useEffect, useState, type ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { errorMessage, type Child } from '../api/client';
import type { ChildDetails, Classroom, OnboardingStep, V2Api, WritingPreferences } from '../api/v2';
import { DatePicker, todayDate } from '../ui/DatePicker';
import { colors } from '../ui/theme';
import { WorkButton, WorkChoice, WorkField, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';
import type { Account } from './controller';
import { emptyPresetLines, parsePreferenceLines, PreferenceFields, preferenceLines } from '../writing/WritingPreferences';

const titles = ['반 정보', '아동 명단', '아이별 특성', '내 말투 알려주기'];
type Profile = ChildDetails & { characteristics: string };
type SetupData = {
  classroom?: Classroom;
  children?: Child[];
  profiles?: Record<string, Profile>;
  example?: string;
  preferences?: WritingPreferences;
};

function SetupFrame({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.page}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
        <View style={[styles.frame, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>{children}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function OnboardingGate({ account, api, children }: { account: Account; api: V2Api; children: ReactNode }) {
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    void api.onboarding().then(progress => {
      if (current) setStep(progress.step);
    }).catch(failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [api, attempt]);

  if (step === 5) return children;
  if (step !== null) return <SetupStep key={step} step={step} account={account} api={api} onAdvance={setStep} />;
  return (
    <SetupFrame>
      <Text style={workStyles.heading}>첫 설정</Text>
      {error ? <>
        <WorkMessage error>{error}</WorkMessage>
        <WorkButton label="다시 시도" onPress={() => setAttempt(value => value + 1)} />
        <WorkButton label="로그아웃" secondary onPress={() => { void account.logout(); }} />
      </> : <ActivityIndicator color={colors.ink} accessibilityLabel="첫 설정 확인 중" />}
    </SetupFrame>
  );
}

function SetupStep({ step, account, api, onAdvance }: {
  step: Exclude<OnboardingStep, 5>; account: Account; api: V2Api; onAdvance(step: OnboardingStep): void;
}) {
  const [baseline, setBaseline] = useState<SetupData | null>(null);
  const [room, setRoom] = useState<Classroom | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [name, setName] = useState('');
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [example, setExample] = useState('');
  const [exampleExpanded, setExampleExpanded] = useState(false);
  const [preferences, setPreferences] = useState(emptyPresetLines);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const action = useWorkAction();
  const token = account.session.token;
  const legacy = account.api;
  const unauthorized = account.unauthorized;
  const { height } = useWindowDimensions();

  useEffect(() => {
    let current = true;
    setLoadError(null);
    async function load(): Promise<SetupData> {
      if (step === 1) {
        const [classrooms, preferences] = await Promise.all([api.classrooms(), api.writingPreferences()]);
        return { classroom: classrooms[0], preferences };
      }
      if (step === 4) return { example: await api.teacherDocument('writing_examples') ?? '' };
      const children = await legacy.listChildren(token);
      if (step === 2) return { children };
      const entries = await Promise.all(children.map(async child => {
        const [details, characteristics] = await Promise.all([
          api.childDetails(child.child_id), api.characteristics(child.child_id),
        ]);
        return [child.child_id, { ...details, characteristics: characteristics ?? '' }] as const;
      }));
      return { children, profiles: Object.fromEntries(entries) };
    }
    void load().then(data => {
      if (!current) return;
      setBaseline(data);
      setRoom(data.classroom ?? null);
      setChildren(data.children ?? []);
      setProfiles(data.profiles ?? {});
      setExample(data.example ?? '');
      setPreferences(data.preferences ? preferenceLines(data.preferences) : emptyPresetLines);
    }).catch(error => {
      if (!current) return;
      unauthorized(error);
      setLoadError(errorMessage(error));
    });
    return () => { current = false; };
  }, [step, api, legacy, token, unauthorized, attempt]);

  async function addChild() {
    if (!name.trim()) return false;
    const child = await legacy.createChild(token, name.trim()).catch(error => {
      unauthorized(error);
      throw error;
    });
    setChildren(items => [...items, child]);
    setName('');
    return true;
  }

  async function advance(skip = false) {
    if (!skip) {
      if (step === 1) {
        if (!room?.name.trim()) {
          action.setError('반 이름을 입력해 주세요.');
          return;
        }
        await api.saveWritingPreferences(parsePreferenceLines(preferences));
        await api.saveClassroom({ classroom_id: room.classroom_id, name: room.name.trim() });
      }
      if (step === 2) {
        if (!await addChild() && children.length === 0) {
          action.setError('아동을 한 명 이상 등록해 주세요.');
          return;
        }
      }
      if (step === 3) {
        for (const child of children) {
          const value = profiles[child.child_id];
          const before = baseline?.profiles?.[child.child_id];
          const gender = value.gender?.trim() || null;
          const birth_date = value.birth_date?.trim() || null;
          if (gender !== before?.gender || birth_date !== before?.birth_date) {
            await api.saveChildDetails(child.child_id, { gender, birth_date });
          }
          if (value.characteristics !== before?.characteristics) {
            await api.saveCharacteristics(child.child_id, value.characteristics);
          }
        }
      }
      if (step === 4 && example !== baseline?.example) await api.saveTeacherDocument('writing_examples', example);
    }
    onAdvance((await api.saveOnboarding((step + 1) as OnboardingStep)).step);
  }

  function changeProfile(childId: string, change: Partial<Profile>) {
    setProfiles(values => ({ ...values, [childId]: { ...values[childId], ...change } }));
  }

  return (
    <SetupFrame>
      <View style={workStyles.between}>
        <Text style={styles.brand}>PatPat</Text>
        <WorkButton label="로그아웃" secondary disabled={action.busy || account.busy}
          onPress={() => { void account.logout(); }} />
      </View>
      <Text style={workStyles.hint}>첫 설정 {step}/4</Text>
      <Text style={workStyles.heading}>{titles[step - 1]}</Text>
      {loadError ? <>
        <WorkMessage error>{loadError}</WorkMessage>
        <WorkButton label="다시 시도" onPress={() => setAttempt(value => value + 1)} />
      </> : !baseline ? <ActivityIndicator color={colors.ink} accessibilityLabel="설정 불러오는 중" /> : <>
        {step === 1 && room && <View style={workStyles.panel}>
          <WorkField label="반 이름" value={room.name} maxLength={100} editable={!action.busy}
            onChangeText={value => setRoom({ ...room, name: value })} />
          <Text style={workStyles.title}>자주 쓰는 장소·시간</Text>
          <PreferenceFields value={preferences} onChange={setPreferences} disabled={action.busy} />
        </View>}
        {step === 2 && <View style={workStyles.panel}>
          <WorkMessage>알림장과 관찰일지를 작성할 아이를 등록해 주세요.</WorkMessage>
          {children.map(child => <Text key={child.child_id} style={workStyles.body}>{child.name}</Text>)}
          <WorkField label="아동 이름" value={name} maxLength={80} editable={!action.busy}
            onChangeText={setName} onSubmitEditing={() => { void action.run(async () => { await addChild(); }); }} />
          <WorkButton label="아동 추가" secondary disabled={action.busy || !name.trim()}
            onPress={() => { void action.run(async () => { await addChild(); }); }} />
        </View>}
        {step === 3 && <>
          <WorkMessage>기록에 참고할 특성이 있다면 알려주세요. 비워 두어도 됩니다.</WorkMessage>
          {children.map(child => {
            const value = profiles[child.child_id];
            return <View key={child.child_id} style={workStyles.panel}>
              <Text style={workStyles.title}>{child.name}</Text>
              <Text style={workStyles.label}>성별</Text>
              <View accessibilityRole="radiogroup" accessibilityLabel={child.name + ' 성별'} style={workStyles.row}>
                {(['남', '여'] as const).map(gender => <WorkChoice key={gender} label={gender}
                  selected={value.gender === gender} disabled={action.busy}
                  onPress={() => changeProfile(child.child_id, { gender: value.gender === gender ? null : gender })} />)}
              </View>
              <DatePicker label={child.name + ' 생년월일'} value={value.birth_date} max={todayDate()} years
                disabled={action.busy} onChange={birth_date => changeProfile(child.child_id, { birth_date })} />
              <WorkField label={child.name + ' 특성'} value={value.characteristics} multiline maxLength={20000}
                editable={!action.busy} onChangeText={characteristics => changeProfile(child.child_id, { characteristics })} />
            </View>;
          })}
        </>}
        {step === 4 && <View style={workStyles.panel}>
          <WorkMessage>선생님이 직접 쓴 문장을 넣으면 말투를 참고해요.</WorkMessage>
          <WorkField label="알림장 예시" value={example} onChangeText={setExample} multiline maxLength={20000}
            style={[styles.exampleInput, { height: exampleExpanded ? Math.max(200, height - 200) : 90 }]}
            inputAccessory={<Pressable accessibilityRole="button" accessibilityLabel={exampleExpanded ? '원래 크기' : '전체화면'}
              accessibilityState={{ expanded: exampleExpanded, disabled: action.busy }} disabled={action.busy}
              onPress={() => setExampleExpanded(value => !value)}
              style={({ pressed }) => [styles.exampleControl, action.busy && workStyles.disabled, pressed && workStyles.pressed]}>
              <Ionicons accessible={false} name={exampleExpanded ? 'contract-outline' : 'resize-outline'}
                size={21} color={colors.ink} />
            </Pressable>}
            editable={!action.busy} placeholder="이전에 작성한 알림장 문장을 붙여 넣어주세요." />
        </View>}
        {action.error && <WorkMessage error>{action.error}</WorkMessage>}
        <WorkButton label={step === 4 ? '일지 작성 시작' : '다음'} busy={action.busy}
          disabled={account.busy} onPress={() => { void action.run(() => advance()); }} />
        {step >= 3 && <WorkButton label="건너뛰기" secondary disabled={action.busy || account.busy}
          onPress={() => { void action.run(() => advance(true)); }} />}
      </>}
    </SetupFrame>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  scroll: { alignItems: 'center', flexGrow: 1 },
  frame: { maxWidth: 540, width: '100%', paddingHorizontal: 22, gap: 14 },
  brand: { color: colors.ink, fontSize: 24, fontWeight: '800' },
  exampleInput: { paddingRight: 55 },
  exampleControl: { position: 'absolute', top: 3, right: 3, width: 44, height: 44, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center' },
});
