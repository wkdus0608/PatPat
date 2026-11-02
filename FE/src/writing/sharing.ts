import { Platform, Share } from 'react-native';
import type { TextSharing } from './types';

export function createTextSharing(): TextSharing | undefined {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return undefined;
  return {
    async share(text) {
      const result = await Share.share({ message: text });
      // Android reports sharedAction on closing the chooser, even without delivery.
      return result.action === Share.dismissedAction ? 'dismissed' : 'opened';
    },
  };
}
