import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { TokenStore } from './controller';
import { createWebTokenStore, type WebStorage } from './webTokenStore';

function tabStorage(): WebStorage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

export function createTokenStore(server: string): TokenStore {
  if (Platform.OS === 'web') return createWebTokenStore(tabStorage(), 'patpat.session'); // 새로고침해도 로그인 유지
  const key = 'patpat.session.' + Array.from(server.trim().replace(/\/+$/, ''))
    .map(character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    read: () => SecureStore.getItemAsync(key),
    write: token => SecureStore.setItemAsync(key, token, options),
    clear: () => SecureStore.deleteItemAsync(key),
  };
}
