import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';
import { ApiError } from '../api/client';

export async function copyRecord(text: string) {
  if (Platform.OS === 'web' && typeof document !== 'undefined' && !navigator.clipboard) {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;font-size:16px';
    document.body.appendChild(field);
    try {
      field.select();
      field.setSelectionRange(0, text.length);
      if (document.execCommand('copy')) return;
    } finally {
      field.remove();
    }
  } else if (await Clipboard.setStringAsync(text, { android: { isSensitive: true } }).catch(() => false)) {
    return;
  }
  throw new ApiError(0, 'COPY_FAILED', '복사하지 못했어요. 본문을 선택해서 복사해 주세요.');
}
