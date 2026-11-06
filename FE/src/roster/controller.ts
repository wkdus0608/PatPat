import { ApiError, errorMessage, type Api, type Child } from '../api/client';
import {
  emptyCharacteristicsEntry, unavailableCharacteristicsSource,
  type CharacteristicsEntry, type ChildCharacteristicsSource,
} from './characteristics';
import {
  TEACHER_DOCUMENT_KINDS, unavailableTeacherDocumentSource,
  type TeacherDocumentKind, type TeacherDocumentSource,
} from './teacherDocuments';

export type { CharacteristicsEntry, ChildCharacteristicsSource } from './characteristics';
export type { TeacherDocumentKind, TeacherDocumentSource } from './teacherDocuments';
type EditorTarget = { childId: string } | { teacherKind: TeacherDocumentKind };
export type SettingsDialog = EditorTarget & (
  | { kind: 'saved' }
  | { kind: 'saveFailed'; unavailable: boolean }
  | { kind: 'leave'; destination: 'roster' | 'close' }
  | { kind: 'logout' }
);
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
  // These maps belong to the authenticated app, never to server API models.
  characteristicsChildId: string | null;
  characteristicsDrafts: ReadonlyMap<string, string>;
  characteristicsEntries: ReadonlyMap<string, CharacteristicsEntry>;
  teacherDocumentKind: TeacherDocumentKind | null;
  teacherDocumentDrafts: ReadonlyMap<TeacherDocumentKind, string>;
  teacherDocumentEntries: ReadonlyMap<TeacherDocumentKind, CharacteristicsEntry>;
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
export function getTeacherDocumentEntry(state: RosterState, kind: TeacherDocumentKind): Readonly<CharacteristicsEntry> {
  return state.teacherDocumentEntries.get(kind) ?? emptyCharacteristicsEntry;
}
export function isTeacherDocumentDirty(state: RosterState, kind: TeacherDocumentKind): boolean {
  return state.teacherDocumentDrafts.has(kind)
    && (getTeacherDocumentEntry(state, kind).pendingEdit === true
      || state.teacherDocumentDrafts.get(kind) !== (getTeacherDocumentEntry(state, kind).savedText ?? ''));
}
export function hasUnsavedTeacherDocuments(state: RosterState): boolean {
  return [...state.teacherDocumentDrafts.keys()].some(kind => isTeacherDocumentDirty(state, kind));
}

export function createRosterController(
  api: Api, token: string, unauthorized: (error: unknown) => void,
  source: ChildCharacteristicsSource = unavailableCharacteristicsSource,
  teacherSource: TeacherDocumentSource = unavailableTeacherDocumentSource,
) {
  const emptyEditors = () => ({
    characteristicsChildId: null,
    characteristicsDrafts: new Map<string, string>(),
    characteristicsEntries: new Map<string, CharacteristicsEntry>(),
    teacherDocumentKind: null,
    teacherDocumentDrafts: new Map<TeacherDocumentKind, string>(),
    teacherDocumentEntries: new Map<TeacherDocumentKind, CharacteristicsEntry>(),
    dialog: null,
  });
  let state: RosterState = {
    items: [], loading: false, saving: false, loaded: false, notice: null,
    selecting: false, selectedIds: [], confirming: false, ...emptyEditors(),
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
  const childExists = (id: string) => state.items.some(child => child.child_id === id);
  const teacherTarget = (target: EditorTarget): target is { teacherKind: TeacherDocumentKind } => 'teacherKind' in target;
  const key = (target: EditorTarget) => teacherTarget(target) ? 'teacher/' + target.teacherKind : 'child/' + target.childId;
  const targetExists = (target: EditorTarget) => teacherTarget(target)
    ? TEACHER_DOCUMENT_KINDS.includes(target.teacherKind) : childExists(target.childId);
  const entryFor = (target: EditorTarget) => teacherTarget(target)
    ? getTeacherDocumentEntry(state, target.teacherKind) : getCharacteristicsEntry(state, target.childId);
  const dirty = (target: EditorTarget) => teacherTarget(target)
    ? isTeacherDocumentDirty(state, target.teacherKind) : isCharacteristicsDirty(state, target.childId);
  const draftFor = (target: EditorTarget) => teacherTarget(target)
    ? state.teacherDocumentDrafts.get(target.teacherKind) : state.characteristicsDrafts.get(target.childId);
  function activeTarget(): EditorTarget | null {
    if (state.characteristicsChildId !== null) return { childId: state.characteristicsChildId };
    return state.teacherDocumentKind === null ? null : { teacherKind: state.teacherDocumentKind };
  }
  function navigation(target: EditorTarget | null): Partial<RosterState> {
    return {
      characteristicsChildId: target && !teacherTarget(target) ? target.childId : null,
      teacherDocumentKind: target && teacherTarget(target) ? target.teacherKind : null,
    };
  }
  function setEntry(target: EditorTarget, update: Partial<CharacteristicsEntry>): Partial<RosterState> {
    const entry = { ...entryFor(target), ...update };
    if (teacherTarget(target)) {
      const teacherDocumentEntries = new Map(state.teacherDocumentEntries);
      teacherDocumentEntries.set(target.teacherKind, entry);
      return { teacherDocumentEntries };
    }
    const characteristicsEntries = new Map(state.characteristicsEntries);
    characteristicsEntries.set(target.childId, entry);
    return { characteristicsEntries };
  }
  function setDraft(target: EditorTarget, text: string): Partial<RosterState> {
    if (teacherTarget(target)) {
      const teacherDocumentDrafts = new Map(state.teacherDocumentDrafts);
      teacherDocumentDrafts.set(target.teacherKind, text);
      return { teacherDocumentDrafts };
    }
    const characteristicsDrafts = new Map(state.characteristicsDrafts);
    characteristicsDrafts.set(target.childId, text);
    return { characteristicsDrafts };
  }
  function invalidateReads(): Partial<RosterState> {
    reads.clear();
    const idle = (entry: CharacteristicsEntry): CharacteristicsEntry =>
      entry.loadState === 'loading' ? { ...entry, loadState: 'idle' } : entry;
    return {
      characteristicsEntries: new Map([...state.characteristicsEntries].map(([id, entry]) => [id, idle(entry)])),
      teacherDocumentEntries: new Map([...state.teacherDocumentEntries].map(([kind, entry]) => [kind, idle(entry)])),
    };
  }
  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      expired = true; sessionEpoch++; reads.clear(); edits.clear();
      set({ ...emptyEditors(), saving: false, loading: false });
    }
    unauthorized(error);
  }
  function withoutChildren(ids: Set<string>) {
    for (const child of state.items) if (!ids.has(child.child_id)) {
      reads.delete(key({ childId: child.child_id }));
      edits.delete(key({ childId: child.child_id }));
    }
    return {
      characteristicsChildId: state.characteristicsChildId !== null && ids.has(state.characteristicsChildId)
        ? state.characteristicsChildId : null,
      characteristicsDrafts: new Map([...state.characteristicsDrafts].filter(([id]) => ids.has(id))),
      characteristicsEntries: new Map([...state.characteristicsEntries].filter(([id]) => ids.has(id))),
      dialog: state.dialog && (teacherTarget(state.dialog) || ids.has(state.dialog.childId)) ? state.dialog : null,
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
    if (blocked() || state.selecting || activeTarget() !== null || !state.loaded) return false;
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

  // Both editor types share the same explicit-save and failure-retention rules.
  async function loadEditor(target: EditorTarget): Promise<void> {
    const targetKey = key(target);
    const ticket = ++readSequence;
    const session = sessionEpoch;
    const editVersion = edits.get(targetKey) ?? 0;
    reads.set(targetKey, ticket);
    set(setEntry(target, { loadState: 'loading' }));
    const active = () => !disposed && !expired && sessionEpoch === session
      && reads.get(targetKey) === ticket && targetExists(target);
    try {
      const text = await (teacherTarget(target) ? teacherSource.load(target.teacherKind) : source.load(target.childId));
      if (!active()) return;
      if (text !== null && typeof text !== 'string') throw new Error('Invalid editor response');
      // An explicit empty edit must survive initial lookup and later reentry.
      const draft = !dirty(target) && (edits.get(targetKey) ?? 0) === editVersion ? setDraft(target, text ?? '') : {};
      set({ ...draft, ...setEntry(target, { savedText: text, loadState: 'ready', pendingEdit: false }) });
    } catch (error) {
      if (!active()) return;
      const unavailable = error instanceof ApiError && error.status === 501;
      set(setEntry(target, { loadState: unavailable ? 'unavailable' : 'error' }));
      if (error instanceof ApiError && error.status === 401) handleError(error);
    } finally {
      if (reads.get(targetKey) === ticket) reads.delete(targetKey);
    }
  }
  async function openEditor(target: EditorTarget): Promise<void> {
    if (blocked() || state.selecting || !targetExists(target)) return;
    if (!teacherTarget(target) && !state.loaded) return;
    const previous = activeTarget();
    if (previous && key(previous) !== key(target) && dirty(previous)) return;
    set(navigation(target));
    await loadEditor(target);
  }
  function changeEditor(target: EditorTarget, text: string) {
    const active = activeTarget();
    if (blocked() || !active || key(active) !== key(target) || !targetExists(target)) return;
    const targetKey = key(target);
    edits.set(targetKey, (edits.get(targetKey) ?? 0) + 1);
    const entry = entryFor(target);
    set({ ...setDraft(target, text), ...setEntry(target, {
      saveState: entry.savedText !== null && text === entry.savedText ? 'saved' : 'idle',
      pendingEdit: entry.savedText === null && entry.loadState !== 'ready',
    }) });
  }
  async function saveEditor(target: EditorTarget): Promise<boolean> {
    const active = activeTarget();
    if (blocked() || !active || key(active) !== key(target) || !targetExists(target) || !dirty(target)) return false;
    const entry = entryFor(target);
    if (entry.loadState !== 'ready' && entry.loadState !== 'unavailable') return false;
    const text = draftFor(target)!;
    const session = sessionEpoch;
    const ticket = ++epoch;
    reads.delete(key(target));
    set({ saving: true, ...setEntry(target, { saveState: 'saving' }) });
    try {
      await (teacherTarget(target) ? teacherSource.save(target.teacherKind, text) : source.save(target.childId, text));
      if (!current(ticket) || sessionEpoch !== session || !targetExists(target)) return false;
      set({ saving: false, ...setEntry(target, {
        savedText: text, loadState: 'ready', saveState: 'saved', pendingEdit: false,
      }), dialog: { kind: 'saved', ...target } });
      return true;
    } catch (error) {
      if (!current(ticket) || sessionEpoch !== session || !targetExists(target)) return false;
      const unavailable = error instanceof ApiError && error.status === 501;
      set({ saving: false, ...setEntry(target, { saveState: unavailable ? 'unavailable' : 'error' }),
        dialog: { kind: 'saveFailed', ...target, unavailable } });
      if (error instanceof ApiError && error.status === 401) handleError(error);
      return false;
    }
  }
  const openCharacteristics = (id: string) => openEditor({ childId: id });
  const changeCharacteristics = (id: string, text: string) => changeEditor({ childId: id }, text);
  const saveCharacteristics = () => state.characteristicsChildId === null
    ? Promise.resolve(false) : saveEditor({ childId: state.characteristicsChildId });
  const openTeacherDocument = (kind: TeacherDocumentKind) => openEditor({ teacherKind: kind });
  const changeTeacherDocument = (kind: TeacherDocumentKind, text: string) => changeEditor({ teacherKind: kind }, text);
  const saveTeacherDocument = () => state.teacherDocumentKind === null
    ? Promise.resolve(false) : saveEditor({ teacherKind: state.teacherDocumentKind });

  function beginSelection() {
    if (blocked() || state.selecting || activeTarget() !== null || !state.loaded || state.items.length === 0) return;
    set({ selecting: true, selectedIds: [], confirming: false, notice: null });
  }
  function cancelSelection() {
    if (blocked()) return;
    set({ selecting: false, selectedIds: [], confirming: false });
  }
  function toggleSelection(id: string) {
    if (blocked() || !state.selecting || state.confirming || !childExists(id)) return;
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
    set({ loading: false, ...navigation(null), dialog: null, ...invalidateReads() });
  }
  function firstUnsaved(): EditorTarget | undefined {
    const childId = [...state.characteristicsDrafts.keys()].find(id => isCharacteristicsDirty(state, id));
    if (childId !== undefined) return { childId };
    const teacherKind = [...state.teacherDocumentDrafts.keys()].find(kind => isTeacherDocumentDirty(state, kind));
    return teacherKind === undefined ? undefined : { teacherKind };
  }
  function resolveDialog(action: DialogAction): 'close' | 'logout' | null {
    const dialog = state.dialog;
    if (!dialog || disposed || state.saving) return null;
    const target: EditorTarget = teacherTarget(dialog) ? { teacherKind: dialog.teacherKind } : { childId: dialog.childId };
    if (dialog.kind === 'saved' || dialog.kind === 'saveFailed') {
      if (action !== 'dismiss' && action !== 'stay' && action !== 'retry') return null;
      set({ dialog: null });
      if (dialog.kind === 'saveFailed' && action === 'retry') void saveEditor(target);
      return null;
    }
    if (dialog.kind === 'logout') {
      if (action === 'logout') { set({ dialog: null }); return 'logout'; }
      if (action === 'stay' || action === 'dismiss') set({ dialog: null });
      return null;
    }
    if (action === 'stay' || action === 'dismiss') {
      set({ dialog: null, ...navigation(target) });
    } else if (action === 'leave') {
      if (dialog.destination === 'close') { closeSettings(); return 'close'; }
      set({ dialog: null, ...navigation(null) });
    }
    return null;
  }
  // True allows the hosting modal to close; false consumes back within settings.
  function back(): boolean {
    if (disposed || state.saving) return false;
    if (state.dialog) { resolveDialog('stay'); return false; }
    const target = activeTarget();
    if (target) {
      if (dirty(target)) set({ dialog: { kind: 'leave', ...target, destination: 'roster' } });
      else set(navigation(null));
      return false;
    }
    if (state.confirming) { cancelDelete(); return false; }
    if (state.selecting) { cancelSelection(); return false; }
    const unsaved = firstUnsaved();
    if (unsaved) {
      set({ dialog: { kind: 'leave', ...unsaved, destination: 'close' } });
      return false;
    }
    closeSettings();
    return true;
  }
  function requestLogout(): boolean {
    if (blocked()) return false;
    const target = firstUnsaved();
    if (target) { set({ dialog: { kind: 'logout', ...target } }); return false; }
    return true;
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh, openCharacteristics, changeCharacteristics, saveCharacteristics,
    openTeacherDocument, changeTeacherDocument, saveTeacherDocument, resolveDialog, requestLogout,
    beginSelection, cancelSelection, toggleSelection, requestDelete, cancelDelete, deleteSelected, back,
    create(name: string) { return name.trim() ? save(() => api.createChild(token, name), true) : Promise.resolve(false); },
    rename(id: string, name: string) { return name.trim() ? save(() => api.renameChild(token, id, name)) : Promise.resolve(false); },
    dispose() {
      state = { ...state, ...emptyEditors() };
      disposed = true; epoch++; sessionEpoch++; reads.clear(); edits.clear(); listeners.clear();
    },
  };
}

export type RosterController = ReturnType<typeof createRosterController>;
