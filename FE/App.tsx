import { useEffect, useMemo } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { startRequestInbox } from './src/recording/startRequest';
import { attachStartRequestSources } from './src/recording/startRequestSources';
import { useRecording } from './src/recording/useRecording';
import { PatPatAppView } from './src/ui/PatPatAppView';
import { AuthGate } from './src/auth/AuthGate';
import { OnboardingGate } from './src/auth/OnboardingGate';
import { createV2Api, type V2Api } from './src/api/v2';
import type { Account } from './src/auth/controller';

function RecordingApp({ account, api }: { account: Account; api: V2Api }) {
  const recording = useRecording(account);
  return <PatPatAppView {...recording} account={account} apiV2={api} />;
}

function SignedInApp({ account }: { account: Account }) {
  const api = useMemo(() => createV2Api(account.api.baseUrl, account.session.token, account.unauthorized),
    [account.api.baseUrl, account.session.token, account.unauthorized]);
  return (
    <OnboardingGate account={account} api={api}>
      <RecordingApp account={account} api={api} />
    </OnboardingGate>
  );
}

export default function App() {
  // Listen from app start so a side-button request is not lost while the login is restored.
  useEffect(() => attachStartRequestSources(startRequestInbox), []);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <AuthGate>{account => <SignedInApp key={account.session.teacher.teacher_id} account={account} />}</AuthGate>
    </SafeAreaProvider>
  );
}
