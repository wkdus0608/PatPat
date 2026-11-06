import { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { startRequestInbox } from './src/recording/startRequest';
import { attachStartRequestSources } from './src/recording/startRequestSources';
import { useRecording } from './src/recording/useRecording';
import { PatPatAppView } from './src/ui/PatPatAppView';
import { AuthGate } from './src/auth/AuthGate';
import type { Account } from './src/auth/controller';

function RecordingApp({ account }: { account: Account }) {
  const recording = useRecording(account);
  return <PatPatAppView {...recording} account={account} />;
}

export default function App() {
  // Listen from app start so a side-button request is not lost while the login is restored.
  useEffect(() => attachStartRequestSources(startRequestInbox), []);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <AuthGate>{account => <RecordingApp account={account} />}</AuthGate>
    </SafeAreaProvider>
  );
}
