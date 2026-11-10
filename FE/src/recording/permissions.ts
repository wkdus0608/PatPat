import { RecordingStorageError } from './storage';

interface MicrophonePermission { granted: boolean; canAskAgain: boolean }
interface PermissionPort {
  read(): Promise<MicrophonePermission>;
  request(): Promise<MicrophonePermission>;
}

/** Ask only after the teacher presses record, and never after a permanent denial. */
export async function ensureMicrophonePermission(port: PermissionPort): Promise<boolean> {
  let permission = await port.read();
  if (!permission.granted && permission.canAskAgain) permission = await port.request();
  if (!permission.granted) {
    throw new RecordingStorageError('PERMISSION', '마이크 사용 권한이 필요해요. 휴대전화 설정에서 이 앱의 마이크를 허용한 뒤 다시 눌러 주세요.');
  }
  return true;
}
