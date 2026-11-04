import { errorMessage, type Api, type Child } from '../api/client';

export interface RosterState {
  items: Child[]; includeInactive: boolean; loading: boolean; saving: boolean; loaded: boolean; notice: string | null;
}
export function createRosterController(api: Api, token: string, unauthorized: (error: unknown) => void) {
  let state: RosterState = { items: [], includeInactive: false, loading: false, saving: false, loaded: false, notice: null };
  let epoch = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const set = (update: Partial<RosterState>) => { if (!disposed) { state = { ...state, ...update }; listeners.forEach(fn => fn()); } };
  async function refresh(includeInactive = state.includeInactive) {
    if (disposed) { disposed = false; set({ saving: false, loading: false }); }
    if (state.saving) return;
    const ticket = ++epoch;
    set({ includeInactive, loading: true, notice: null });
    try {
      const items = await api.listChildren(token, includeInactive);
      if (!disposed && epoch === ticket) set({ items, loaded: true, loading: false });
    } catch (error) {
      if (!disposed && epoch === ticket) { set({ loading: false, notice: errorMessage(error) }); unauthorized(error); }
    }
  }
  async function save(operation: () => Promise<Child>, creating = false): Promise<boolean> {
    if (disposed || state.saving || state.loading || !state.loaded) return false;
    const ticket = ++epoch;
    set({ saving: true, notice: null });
    try {
      const child = await operation();
      if (disposed || epoch !== ticket) return false;
      const items = creating ? [...state.items, child] : state.items.map(item => item.child_id === child.child_id ? child : item);
      set({ items: items.filter(item => state.includeInactive || item.is_active), saving: false, notice: '명단을 저장했어요.' });
      return true;
    } catch (error) {
      if (!disposed && epoch === ticket) { set({ saving: false, notice: errorMessage(error) }); unauthorized(error); }
      return false;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh,
    create(name: string) { return name.trim() ? save(() => api.createChild(token, name), true) : Promise.resolve(false); },
    rename(id: string, name: string) { return name.trim() ? save(() => api.renameChild(token, id, name)) : Promise.resolve(false); },
    deactivate(id: string) { return save(() => api.deactivateChild(token, id)); },
    dispose() { disposed = true; epoch++; listeners.clear(); },
  };
}
