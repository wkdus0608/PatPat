import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { TokenStore } from './controller';

export function createTokenStore(server: string): TokenStore {
  if (Platform.OS === 'web') {
    let token: string | null = null;
    return { async read() { return token; }, async write(value) { token = value; }, async clear() { token = null; } };
  }
  const key = 'patpat.session.' + Array.from(server.trim().replace(/\/+$/, ''))
    .map(character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    read: () => SecureStore.getItemAsync(key),
    write: token => SecureStore.setItemAsync(key, token, options),
    clear: () => SecureStore.deleteItemAsync(key),
  };
}
