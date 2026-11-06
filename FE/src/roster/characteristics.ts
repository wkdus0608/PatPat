import { ApiError } from '../api/client';

// FE connection boundary only. The BE has no characteristics contract yet.
export interface ChildCharacteristicsSource {
  load(childId: string): Promise<string | null>;
  save(childId: string, text: string): Promise<void>;
}

export interface CharacteristicsEntry {
  savedText: string | null;
  loadState: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  saveState: 'idle' | 'saving' | 'saved' | 'error' | 'unavailable';
  // Includes an explicit empty edit made before the first baseline is known.
  pendingEdit?: boolean;
}

export const emptyCharacteristicsEntry: Readonly<CharacteristicsEntry> = {
  savedText: null, loadState: 'idle', saveState: 'idle',
};

function unavailable(): never {
  throw new ApiError(501, 'NOT_IMPLEMENTED', '아직 저장 기능이 연결되지 않았어요. 입력한 내용은 유지돼요.');
}

export const unavailableCharacteristicsSource: ChildCharacteristicsSource = {
  async load() { return unavailable(); },
  async save() { unavailable(); },
};
