import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useRecording } from './src/recording/useRecording';
import { PatPatAppView } from './src/ui/PatPatAppView';
import { AuthGate } from './src/auth/AuthGate';
import type { Account } from './src/auth/controller';

function RecordingApp({ account }: { account: Account }) {
  const recording = useRecording();
  return <PatPatAppView {...recording} account={account} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <AuthGate>{account => <RecordingApp account={account} />}</AuthGate>
    </SafeAreaProvider>
  );
}
