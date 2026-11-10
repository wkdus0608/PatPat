import Constants, { ExecutionEnvironment } from 'expo-constants';

/**
 * Recording that survives screen-off/app-switch needs native settings (iOS `audio` background mode,
 * Android microphone foreground service) built into the app binary by the expo-audio config plugin.
 * Expo Go cannot provide them, so it keeps the previous behavior: recording stops when the app leaves the screen.
 */
export const backgroundRecordingSupported = Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
