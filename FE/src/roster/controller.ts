import { ApiError, errorMessage, type Api, type Child } from '../api/client';
import {
  emptyCharacteristicsEntry, unavailableCharacteristicsSource,
  type CharacteristicsEntry, type ChildCharacteristicsSource,
} from './characteristics';

export type { CharacteristicsEntry, ChildCharacteristicsSource } from './characteristics';
export type SettingsDialog =
  | { kind: 'saved'; childId: string }
  | { kind: 'saveFailed'; childId: string; unavailable: boolean }
  | { kind: 'leave'; childId: string; destination: 'roster' | 'close' }
  | { kind: 'logout'; childId: string };
export type DialogAction = 'dismiss' | 'retry' | 'stay' | 'leave' | 'logout';

export interface RosterState {
  items: Child[];
  loading: boolean;
  saving: boolean;
  loaded: boolean;
  notice: string | null;
  selecting: boolean;
  selectedIds: string[];
  confirming: boolean;
  // These maps belong to the authenticated app, never to the server Child.
  characteristicsChildId: string | null;
  characteristicsDrafts: ReadonlyMap<string, string>;
  characteristicsEntries: ReadonlyMap<string, CharacteristicsEntry>;
  dialog: SettingsDialog | null;
}

export function getCharacteristicsEntry(state: RosterState, id: string): Readonly<CharacteristicsEntry> {
  return state.characteristicsEntries.get(id) ?? emptyCharacteristicsEntry;
}
export function isCharacteristicsDirty(state: RosterState, id: string): boolean {
  return state.characteristicsDrafts.has(id)
    && (getCharacteristicsEntry(state, id).pendingEdit === true
      || state.characteristicsDrafts.get(id) !== (getCharacteristicsEntry(state, id).savedText ?? ''));
}
export function hasUnsavedCharacteristics(state: RosterState): boolean {
  return [...state.characteristicsDrafts.keys()].some(id => isCharacteristicsDirty(state, id));
}

export function createRosterController(
  api: Api, token: string, unauthorized: (error: unknown) => void,
  source: ChildCharacteristicsSource = unavailableCharacteristicsSource,
) {
  const emptyCharacteristics = () => ({
    characteristicsChildId: null,
    characteristicsDrafts: new Map<string, string>(),
    characteristicsEntries: new Map<string, CharacteristicsEntry>(),
    dialog: null,
  });
  let state: RosterState = {
    items: [], loading: false, saving: false, loaded: false, notice: null,
    selecting: false, selectedIds: [], confirming: false, ...emptyCharacteristics(),
  };
  let epoch = 0;
  let sessionEpoch = 0;
  let disposed = false;
  let expired = false;
  let readSequence = 0;
  const reads = new Map<string, number>();
  const edits = new Map<string, number>();
  const listeners = new Set<() => void>();
  const current = (ticket: number) => !disposed && !expired && epoch === ticket;
  const set = (update: Partial<RosterState>) => {
    if (!disposed) { state = { ...state, ...update }; listeners.forEach(fn => fn()); }
  };
  const blocked = () => disposed || expired || state.saving || state.loading || state.dialog !== null;
  const exists = (id: string) => state.items.some(child => child.child_id === id);
  function setEntry(id: string, update: Partial<CharacteristicsEntry>) {
    const characteristicsEntries = new Map(state.characteristicsEntries);
    characteristicsEntries.set(id, { ...getCharacteristicsEntry(state, id), ...update });
    return characteristicsEntries;
  }
  function invalidateReads() {
    reads.clear();
    const characteristicsEntries = new Map([...state.characteristicsEntries].map(([id, entry]) =>
      [id, entry.loadState === 'loading' ? { ...entry, loadState: 'idle' as const } : entry] as const));
    return characteristicsEntries;
  }
  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      expired = true; sessionEpoch++; reads.clear(); edits.clear();
      set({ ...emptyCharacteristics(), saving: false, loading: false });
    }
    unauthorized(error);
  }
  function withoutChildren(ids: Set<string>) {
    for (const id of reads.keys()) if (!ids.has(id)) reads.delete(id);
    for (const id of edits.keys()) if (!ids.has(id)) edits.delete(id);
    return {
      characteristicsChildId: state.characteristicsChildId !== null && ids.has(state.characteristicsChildId)
        ? state.characteristicsChildId : null,
      characteristicsDrafts: new Map([...state.characteristicsDrafts].filter(([id]) => ids.has(id))),
      characteristicsEntries: new Map([...state.characteristicsEntries].filter(([id]) => ids.has(id))),
      dialog: state.dialog && ids.has(state.dialog.childId) ? state.dialog : null,
    };
  }

  async function refresh() {
    if (disposed) { disposed = false; set({ saving: false, loading: false }); }
    if (expired || state.saving || state.dialog) return;
    const ticket = ++epoch;
    set({ loading: true, notice: null });
    try {
      const items = await api.listChildren(token);
      if (!current(ticket)) return;
      const selectedIds = state.selectedIds.filter(id => items.some(child => child.child_id === id));
      const removedTargets = selectedIds.length !== state.selectedIds.length;
      set({ items, loaded: true, loading: false, selectedIds,
        ...withoutChildren(new Set(items.map(child => child.child_id))),
        selecting: state.selecting && items.length > 0 && (!removedTargets || selectedIds.length > 0),
        confirming: state.confirming && !removedTargets });
    } catch (error) {
      if (current(ticket)) { set({ loading: false, notice: errorMessage(error) }); handleError(error); }
    }
  }
  async function save(operation: () => Promise<Child>, creating = false): Promise<boolean> {
    if (blocked() || state.selecting || state.characteristicsChildId !== null || !state.loaded) return false;
    const ticket = ++epoch;
    set({ saving: true, notice: null });
    try {
      const child = await operation();
      if (!current(ticket)) return false;
      const items = creating ? [...state.items, child] : state.items.map(item => item.child_id === child.child_id ? child : item);
      set({ items, saving: false, notice: '명단을 저장했어요.' });
      return true;
    } catch (error) {
      if (current(ticket)) { set({ saving: false, notice: errorMessage(error) }); handleError(error); }
      return false;
    }
  }

  async function loadCharacteristics(id: string): Promise<void> {
    const ticket = ++readSequence;
    const session = sessionEpoch;
    const editVersion = edits.get(id) ?? 0;
    reads.set(id, ticket);
    set({ characteristicsEntries: setEntry(id, { loadState: 'loading' }) });
    const active = () => !disposed && !expired && sessionEpoch === session
      && reads.get(id) === ticket && exists(id);
    try {
      const text = await source.load(id);
      if (!active()) return;
      if (text !== null && typeof text !== 'string') throw new Error('Invalid characteristics response');
      const characteristicsDrafts = new Map(state.characteristicsDrafts);
      // A user clearing the field during load is an edit even if its value is empty.
      if (!isCharacteristicsDirty(state, id) && (edits.get(id) ?? 0) === editVersion) {
        characteristicsDrafts.set(id, text ?? '');
      }
      set({ characteristicsDrafts, characteristicsEntries: setEntry(id, {
        savedText: text, loadState: 'ready', pendingEdit: false,
      }) });
    } catch (error) {
      if (!active()) return;
      const unavailable = error instanceof ApiError && error.status === 501;
      set({ characteristicsEntries: setEntry(id, { loadState: unavailable ? 'unavailable' : 'error' }) });
      if (error instanceof ApiError && error.status === 401) handleError(error);
    } finally {
      if (reads.get(id) === ticket) reads.delete(id);
    }
  }
  async function openCharacteristics(id: string): Promise<void> {
    if (blocked() || state.selecting || !state.loaded || !exists(id)) return;
    // Navigation is explicit; changing child cannot bypass an unsaved-exit dialog.
    if (state.characteristicsChildId !== null && state.characteristicsChildId !== id
      && isCharacteristicsDirty(state, state.characteristicsChildId)) return;
    set({ characteristicsChildId: id });
    await loadCharacteristics(id);
  }
  function changeCharacteristics(id: string, text: string) {
    if (blocked() || state.characteristicsChildId !== id || !exists(id)) return;
    edits.set(id, (edits.get(id) ?? 0) + 1);
    const characteristicsDrafts = new Map(state.characteristicsDrafts);
    characteristicsDrafts.set(id, text);
    const entry = getCharacteristicsEntry(state, id);
    set({ characteristicsDrafts, characteristicsEntries: setEntry(id, {
      saveState: entry.savedText !== null && text === entry.savedText ? 'saved' : 'idle',
      pendingEdit: entry.savedText === null && entry.loadState !== 'ready',
    }) });
  }
  async function saveCharacteristics(): Promise<boolean> {
    const id = state.characteristicsChildId;
    if (blocked() || id === null || !exists(id) || !isCharacteristicsDirty(state, id)) return false;
    const entry = getCharacteristicsEntry(state, id);
    if (entry.loadState !== 'ready' && entry.loadState !== 'unavailable') return false;
    const text = state.characteristicsDrafts.get(id)!;
    const session = sessionEpoch;
    const ticket = ++epoch;
    // A previous read for this child cannot change the baseline while saving.
    reads.delete(id);
    set({ saving: true, characteristicsEntries: setEntry(id, { saveState: 'saving' }) });
    try {
      await source.save(id, text);
      if (!current(ticket) || sessionEpoch !== session || !exists(id)) return false;
      set({ saving: false, characteristicsEntries: setEntry(id, {
        savedText: text, loadState: 'ready', saveState: 'saved', pendingEdit: false,
      }), dialog: { kind: 'saved', childId: id } });
      return true;
    } catch (error) {
      if (!current(ticket) || sessionEpoch !== session || !exists(id)) return false;
      const unavailable = error instanceof ApiError && error.status === 501;
      set({ saving: false, characteristicsEntries: setEntry(id, { saveState: unavailable ? 'unavailable' : 'error' }),
        dialog: { kind: 'saveFailed', childId: id, unavailable } });
      if (error instanceof ApiError && error.status === 401) handleError(error);
      return false;
    }
  }

  function beginSelection() {
    if (blocked() || state.selecting || state.characteristicsChildId !== null || !state.loaded || state.items.length === 0) return;
    set({ selecting: true, selectedIds: [], confirming: false, notice: null });
  }
  function cancelSelection() {
    if (blocked()) return;
    set({ selecting: false, selectedIds: [], confirming: false });
  }
  function toggleSelection(id: string) {
    if (blocked() || !state.selecting || state.confirming || !exists(id)) return;
    set({ selectedIds: state.selectedIds.includes(id)
      ? state.selectedIds.filter(selected => selected !== id) : [...state.selectedIds, id] });
  }
  function requestDelete() {
    if (blocked() || !state.selecting || state.selectedIds.length === 0) return;
    set({ confirming: true, notice: null });
  }
  function cancelDelete() { if (!blocked()) set({ confirming: false }); }

  async function deleteSelected(): Promise<boolean> {
    if (blocked() || !state.confirming || state.selectedIds.length === 0) return false;
    const targets = [...state.selectedIds];
    const ticket = ++epoch;
    let deleted = 0;
    let unavailable: string | null = null;
    set({ saving: true, notice: null });
    for (const id of targets) {
      if (!current(ticket)) return false;
      try {
        await api.deleteChild(token, id);
        if (!current(ticket)) return false;
        deleted++;
        const items = state.items.filter(child => child.child_id !== id);
        set({ items, ...withoutChildren(new Set(items.map(child => child.child_id))),
          selectedIds: state.selectedIds.filter(selected => selected !== id) });
      } catch (error) {
        if (!current(ticket)) return false;
        if (error instanceof ApiError && error.status === 401) { handleError(error); break; }
        if (error instanceof ApiError && error.status === 501) { unavailable = errorMessage(error); break; }
      }
    }
    if (!current(ticket)) return false;
    const remaining = state.selectedIds.length;
    set({ saving: false, confirming: false, selecting: remaining > 0,
      notice: remaining > 0 ? `${deleted}명 삭제, ${remaining}명은 삭제하지 못했어요. ${unavailable ?? '선택한 아동을 확인하고 다시 시도해 주세요.'}`
        : `${deleted}명의 아동을 명단에서 삭제했어요.` });
    return remaining === 0;
  }
  function closeSettings() {
    epoch++;
    set({ loading: false, characteristicsChildId: null, dialog: null,
      characteristicsEntries: invalidateReads() });
  }
  function firstUnsaved() {
    return [...state.characteristicsDrafts.keys()].find(id => isCharacteristicsDirty(state, id));
  }
  function resolveDialog(action: DialogAction): 'close' | 'logout' | null {
    const dialog = state.dialog;
    if (!dialog || disposed || state.saving) return null;
    if (dialog.kind === 'saved' || dialog.kind === 'saveFailed') {
      if (action !== 'dismiss' && action !== 'stay' && action !== 'retry') return null;
      set({ dialog: null });
      if (dialog.kind === 'saveFailed' && action === 'retry') void saveCharacteristics();
      return null;
    }
    if (dialog.kind === 'logout') {
      if (action === 'logout') { set({ dialog: null }); return 'logout'; }
      if (action === 'stay' || action === 'dismiss') set({ dialog: null });
      return null;
    }
    if (action === 'stay' || action === 'dismiss') {
      set({ dialog: null, characteristicsChildId: dialog.childId });
    } else if (action === 'leave') {
      if (dialog.destination === 'close') { closeSettings(); return 'close'; }
      set({ dialog: null, characteristicsChildId: null });
    }
    return null;
  }
  // True allows the hosting modal to close; false consumes back within settings.
  function back(): boolean {
    if (disposed || state.saving) return false;
    if (state.dialog) { resolveDialog('stay'); return false; }
    const id = state.characteristicsChildId;
    if (id !== null) {
      if (isCharacteristicsDirty(state, id)) set({ dialog: { kind: 'leave', childId: id, destination: 'roster' } });
      else set({ characteristicsChildId: null });
      return false;
    }
    if (state.confirming) { cancelDelete(); return false; }
    if (state.selecting) { cancelSelection(); return false; }
    const unsaved = firstUnsaved();
    if (unsaved !== undefined) {
      set({ dialog: { kind: 'leave', childId: unsaved, destination: 'close' } });
      return false;
    }
    closeSettings();
    return true;
  }
  function requestLogout(): boolean {
    if (blocked()) return false;
    const id = firstUnsaved();
    if (id !== undefined) { set({ dialog: { kind: 'logout', childId: id } }); return false; }
    return true;
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh, openCharacteristics, changeCharacteristics, saveCharacteristics, resolveDialog, requestLogout,
    beginSelection, cancelSelection, toggleSelection, requestDelete, cancelDelete, deleteSelected, back,
    create(name: string) { return name.trim() ? save(() => api.createChild(token, name), true) : Promise.resolve(false); },
    rename(id: string, name: string) { return name.trim() ? save(() => api.renameChild(token, id, name)) : Promise.resolve(false); },
    dispose() {
      state = { ...state, ...emptyCharacteristics() };
      disposed = true; epoch++; sessionEpoch++; reads.clear(); edits.clear(); listeners.clear();
    },
  };
}

export type RosterController = ReturnType<typeof createRosterController>;
