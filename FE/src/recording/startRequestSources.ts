import { File, Paths } from 'expo-file-system';
import { AppState, Linking, Platform } from 'react-native';
import { isStartRequestUrl, parseRequestTimestamp, type StartRequestInbox } from './startRequest';

/** Written by the iPhone App Intent (plugins/native/StartRecordingIntent.swift) in the app's Documents folder. */
export const IOS_REQUEST_FILE = 'patpat-start-request.txt';

let initialUrlRead = false;

async function takeIosRequest(inbox: StartRequestInbox): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    const file = new File(Paths.document, IOS_REQUEST_FILE);
    if (!file.exists) return;
    const at = parseRequestTimestamp(await file.text());
    file.delete();
    if (at !== null) inbox.push(at);
  } catch {
    // A missing or unreadable request file is the same as no request.
  }
}

/**
 * Listens for start requests from outside the app until the returned function is called:
 * the Galaxy shortcut and Shortcuts "Open URL" arrive as a `patpat://record/start` link,
 * and the iPhone side-button Siri request arrives as a file written by the App Intent.
 */
export function attachStartRequestSources(inbox: StartRequestInbox): () => void {
  if (!initialUrlRead) {
    initialUrlRead = true; // The launch URL stays the same for the whole JS session; read it once.
    void Linking.getInitialURL().then((url) => { if (isStartRequestUrl(url)) inbox.push(); }).catch(() => {});
  }
  const link = Linking.addEventListener('url', ({ url }) => { if (isStartRequestUrl(url)) inbox.push(); });
  const appState = AppState.addEventListener('change', (next) => { if (next === 'active') void takeIosRequest(inbox); });
  void takeIosRequest(inbox);
  return () => { link.remove(); appState.remove(); };
}
