import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useRecording } from './src/recording/useRecording';
import { PatPatAppView } from './src/ui/PatPatAppView';

function RecordingApp() {
  const recording = useRecording();
  return <PatPatAppView {...recording} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <RecordingApp />
    </SafeAreaProvider>
  );
}
