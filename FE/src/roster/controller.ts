import { ApiError, errorMessage, type Api, type Child } from '../api/client';

export interface RosterState {
  items: Child[];
  loading: boolean;
  saving: boolean;
  loaded: boolean;
  notice: string | null;
  selecting: boolean;
  selectedIds: string[];
  confirming: boolean;
  // UI-only drafts live for one open settings screen, never on the server Child.
  characteristicsChildId: string | null;
  characteristicsDrafts: ReadonlyMap<string, string>;
}

export function createRosterController(api: Api, token: string, unauthorized: (error: unknown) => void) {
  let state: RosterState = {
    items: [], loading: false, saving: false, loaded: false, notice: null,
    selecting: false, selectedIds: [], confirming: false,
    characteristicsChildId: null, characteristicsDrafts: new Map(),
  };
  let epoch = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const current = (ticket: number) => !disposed && epoch === ticket;
  const set = (update: Partial<RosterState>) => {
    if (!disposed) { state = { ...state, ...update }; listeners.forEach(fn => fn()); }
  };
  const blocked = () => disposed || state.saving || state.loading;
  const emptyCharacteristics = () => ({ characteristicsChildId: null, characteristicsDrafts: new Map<string, string>() });
  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) set(emptyCharacteristics());
    unauthorized(error);
  }

  async function refresh() {
    if (disposed) { disposed = false; set({ saving: false, loading: false }); }
    if (state.saving) return;
    const ticket = ++epoch;
    set({ loading: true, notice: null });
    try {
      const items = await api.listChildren(token);
      if (!current(ticket)) return;
      const selectedIds = state.selectedIds.filter(id => items.some(child => child.child_id === id));
      const removedTargets = selectedIds.length !== state.selectedIds.length;
      const ids = new Set(items.map(child => child.child_id));
      set({ items, loaded: true, loading: false, selectedIds,
        characteristicsChildId: state.characteristicsChildId !== null && ids.has(state.characteristicsChildId)
          ? state.characteristicsChildId : null,
        characteristicsDrafts: new Map([...state.characteristicsDrafts].filter(([id]) => ids.has(id))),
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
  function openCharacteristics(id: string) {
    if (blocked() || state.selecting || !state.loaded || !state.items.some(child => child.child_id === id)) return;
    set({ characteristicsChildId: id });
  }
  function changeCharacteristics(id: string, text: string) {
    if (blocked() || state.characteristicsChildId !== id || !state.items.some(child => child.child_id === id)) return;
    const characteristicsDrafts = new Map(state.characteristicsDrafts);
    characteristicsDrafts.set(id, text);
    set({ characteristicsDrafts });
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
    if (blocked() || !state.selecting || state.confirming || !state.items.some(child => child.child_id === id)) return;
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
        const characteristicsDrafts = new Map(state.characteristicsDrafts);
        characteristicsDrafts.delete(id);
        set({ items: state.items.filter(child => child.child_id !== id),
          characteristicsDrafts,
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
  // True allows the hosting modal to close; false consumes back within this screen.
  function back(): boolean {
    if (disposed || state.saving) return false;
    if (state.characteristicsChildId !== null) { set({ characteristicsChildId: null }); return false; }
    if (state.confirming) { cancelDelete(); return false; }
    if (state.selecting) { cancelSelection(); return false; }
    set(emptyCharacteristics());
    return true;
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh, openCharacteristics, changeCharacteristics,
    beginSelection, cancelSelection, toggleSelection, requestDelete, cancelDelete, deleteSelected, back,
    create(name: string) { return name.trim() ? save(() => api.createChild(token, name), true) : Promise.resolve(false); },
    rename(id: string, name: string) { return name.trim() ? save(() => api.renameChild(token, id, name)) : Promise.resolve(false); },
    dispose() { state = { ...state, ...emptyCharacteristics() }; disposed = true; epoch++; listeners.clear(); },
  };
}

export type RosterController = ReturnType<typeof createRosterController>;
