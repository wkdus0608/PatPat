import { RecordingLibraryError } from '../library/recordingLibrary';
import type { RecordingLibrary } from '../library/types';
import type { SavedRecording } from '../recording/storage';
import type { EditableJournal, WritingCapabilities, WritingServices, WritingState } from './types';
import { nonblank, readCandidate, readDraft, readPrepared, requireConfirmed, WritingInputError } from './validation';

export function createWritingController(files: RecordingLibrary, services: WritingServices = {}) {
  let state: WritingState = {
    route: 'editor', recordings: { status: 'idle' }, selected: [], checked: [], draft: null,
    activeRecordId: null, phase: 'idle', notice: null, guard: null,
  };
  let disposed = false;
  let operation = 0;
  let listVersion = 0;
  let abort: AbortController | null = null;
  let guardedAction: (() => void) | null = null;
  let leaveAnswer: ((answer: boolean) => void) | null = null;
  const listeners = new Set<() => void>();
  const capabilities: WritingCapabilities = {
    generation: files.available && !!services.workflow,
    revision: !!services.workflow?.revise,
    confirmation: !!services.confirmation,
    sharing: !!services.sharing,
  };
  const busy = () => state.phase !== 'idle';
  const active = () => state.draft?.records.find((row) => row.recordId === state.activeRecordId);
  function set(patch: Partial<WritingState>) {
    if (disposed) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }
  function updateRecord(recordId: string, update: (row: EditableJournal) => EditableJournal) {
    if (!state.draft) return;
    set({ draft: { ...state.draft, records: state.draft.records.map((row) => row.recordId === recordId ? update(row) : row) } });
  }
  function errorMessage(error: unknown, fallback: string) {
    // Arbitrary adapter errors can contain private inputs. Do not echo them.
    return error instanceof WritingInputError || error instanceof RecordingLibraryError ? error.message : fallback;
  }
  function cancelOperation() {
    operation++;
    abort?.abort();
    abort = null;
    set({ phase: 'idle' });
  }
  function begin(phase: WritingState['phase']) {
    const ticket = ++operation;
    abort = new AbortController();
    set({ phase, notice: null });
    return { ticket, signal: abort.signal };
  }
  const current = (ticket: number) => !disposed && ticket === operation;
  function finish(ticket: number) {
    if (current(ticket)) { abort = null; set({ phase: 'idle' }); }
  }
  function guard(kind: 'selection' | 'regenerate' | 'leave', action: () => void) {
    if (state.guard) return;
    guardedAction = action;
    set({ guard: kind === 'leave'
      ? { kind, title: '요청을 중단하고 이동할까요?', message: '현재 본문과 선택한 녹음은 유지돼요. 진행 중인 요청 결과는 적용하지 않아요.', confirmLabel: '중단하고 이동' }
      : { kind, title: kind === 'selection' ? '사용할 녹음을 바꿀까요?' : '초안을 다시 작성할까요?',
        message: '현재 초안과 수정 내용이 초기화돼요. 이미 확정해 저장한 기록은 보관함에 남아요.',
        confirmLabel: kind === 'selection' ? '바꾸기' : '다시 작성' } });
  }
  function applySelection(selected: readonly SavedRecording[]) {
    set({ selected: selected.map((row) => ({ ...row })), checked: selected.map((row) => row.uri),
      draft: null, activeRecordId: null, route: 'editor', notice: null });
  }
  function changeSelection(selected: readonly SavedRecording[]) {
    const same = state.selected.length === selected.length && state.selected.every((row) => selected.some((next) => next.uri === row.uri));
    if (same) { set({ route: 'editor', notice: null }); return; }
    if (state.draft) guard('selection', () => applySelection(selected));
    else applySelection(selected);
  }
  async function refreshRecordings() {
    if (disposed || busy() || state.guard) return;
    const version = ++listVersion;
    if (!files.available) {
      set({ recordings: { status: 'unavailable', message: '녹음 선택은 휴대전화에서 사용할 수 있어요. Expo Go에서 확인해 주세요.' } });
      return;
    }
    set({ recordings: { status: 'loading' } });
    try {
      const recordings = await files.list();
      if (!disposed && version === listVersion) set({ recordings: { status: 'ready', data: recordings } });
    } catch (error) {
      if (!disposed && version === listVersion) set({ recordings: { status: 'error', message: errorMessage(error, '녹음 목록을 불러오지 못했어요. 다시 시도해 주세요.') } });
    }
  }
  async function openPicker() {
    if (disposed || busy() || state.guard) return;
    set({ route: 'picker', checked: state.selected.map((row) => row.uri), notice: null });
    await refreshRecordings();
  }
  function cancelPicker() {
    if (busy() || state.guard) return;
    listVersion++;
    set({ route: 'editor', checked: state.selected.map((row) => row.uri), notice: null });
  }
  function toggleRecording(uri: string) {
    if (busy() || state.guard || state.route !== 'picker') return;
    if (state.checked.includes(uri)) set({ checked: state.checked.filter((value) => value !== uri) });
    else if (state.recordings.status === 'ready' && state.recordings.data.some((row) => row.uri === uri)) {
      set({ checked: [...state.checked, uri] });
    }
  }
  async function importRecordings() {
    if (disposed || busy() || state.guard || state.route !== 'picker' || state.checked.length === 0 || state.recordings.status !== 'ready') return;
    const { ticket } = begin('validating');
    try {
      const known = [...state.recordings.data, ...state.selected];
      const selected = state.checked.map((uri) => known.find((row) => row.uri === uri));
      if (selected.some((row) => !row)) throw new WritingInputError('선택한 녹음 목록을 다시 확인해 주세요.');
      const checked = selected as SavedRecording[];
      await Promise.all(checked.map((row) => files.validate(row)));
      if (current(ticket)) { finish(ticket); changeSelection(checked); }
    } catch (error) {
      if (current(ticket)) set({ notice: errorMessage(error, '선택한 녹음을 확인하지 못했어요. 목록을 다시 확인해 주세요.') });
    } finally { finish(ticket); }
  }
  function removeRecording(uri: string) {
    if (busy() || state.guard || state.route !== 'editor') return;
    changeSelection(state.selected.filter((row) => row.uri !== uri));
  }
  async function runGeneration() {
    if (disposed || busy() || state.guard) return;
    if (!capabilities.generation || !services.workflow) {
      set({ notice: '초안 작성 기능을 연결하고 있어요. 선택한 녹음은 그대로 유지돼요.' }); return;
    }
    if (state.selected.length === 0) { set({ notice: '먼저 사용할 녹음을 가져와 주세요.' }); return; }
    const selected = state.selected.map((row) => ({ ...row }));
    const { ticket, signal } = begin('generating');
    try {
      await Promise.all(selected.map((row) => files.validate(row)));
      if (!current(ticket)) return;
      const prepared = readPrepared(await services.workflow.prepare(selected, signal), selected);
      if (!current(ticket)) return;
      // Unresolved or unrelated observations must not enter the draft request.
      const context = { ...prepared, observations: prepared.observations.filter((row) =>
        row.scope !== 'unresolved' && row.child_ids.some((id) => prepared.childIds.includes(id))) };
      if (context.observations.length === 0) throw new WritingInputError('아동과 연결된 관찰이 없어요. 관찰 연결을 먼저 확인해 주세요.');
      const response = await services.workflow.generate({ record_type: '관찰일지', child_ids: [...context.childIds],
        observation_ids: context.observations.map((row) => row.observation_id) }, signal);
      if (!current(ticket)) return;
      const draft = readDraft(response, context);
      set({ draft, activeRecordId: draft.records[0]?.recordId ?? null, notice: '초안을 확인하고 선생님의 기록으로 다듬어 주세요.' });
    } catch (error) {
      if (current(ticket)) set({ notice: errorMessage(error, '초안을 작성하지 못했어요. 기존 내용은 유지돼요. 다시 시도해 주세요.') });
    } finally { finish(ticket); }
  }
  function generate() {
    if (disposed || busy() || state.guard) return;
    if (state.draft && capabilities.generation) guard('regenerate', () => { void runGeneration(); });
    else void runGeneration();
  }
  function selectRecord(recordId: string) {
    if (disposed || state.guard || state.phase === 'confirming' || state.phase === 'sharing' || state.phase === 'generating') return;
    if (!state.draft?.records.some((row) => row.recordId === recordId)) return;
    if (state.phase === 'revising') cancelOperation();
    set({ activeRecordId: recordId, notice: null });
  }
  function editText(text: string) {
    if (disposed || state.guard || (busy() && state.phase !== 'revising')) return;
    const row = active();
    if (!row || text === row.editedText) return;
    if (state.phase === 'revising') cancelOperation();
    updateRecord(row.recordId, (record) => ({ ...record, editedText: text, version: record.version + 1,
      candidate: null, confirmedText: null }));
    set({ notice: null });
  }
  function editPrompt(prompt: string) {
    if (disposed || state.guard || (busy() && state.phase !== 'revising')) return;
    const row = active();
    if (!row || prompt === row.prompt) return;
    if (state.phase === 'revising') cancelOperation();
    updateRecord(row.recordId, (record) => ({ ...record, prompt, candidate: null }));
  }
  async function revise() {
    if (disposed || busy() || state.guard) return;
    const row = active();
    if (!row) return;
    if (!services.workflow?.revise) { set({ notice: '수정 요청 기능을 연결하고 있어요. 본문은 직접 수정할 수 있어요.' }); return; }
    if (!row.prompt.trim() || !row.editedText.trim()) { set({ notice: '본문과 수정 요청을 먼저 작성해 주세요.' }); return; }
    const { ticket, signal } = begin('revising');
    try {
      const input = { recordId: row.recordId, childId: row.childId, editedText: row.editedText,
        prompt: row.prompt, observationIds: [...new Set(row.sentences.flatMap((sentence) => sentence.observationIds))] };
      const text = readCandidate(await services.workflow.revise(input, signal));
      if (!current(ticket)) return;
      const latest = active();
      if (latest?.recordId !== row.recordId || latest.version !== row.version || latest.prompt !== row.prompt) return;
      updateRecord(row.recordId, (record) => ({ ...record, candidate: { text, baseVersion: row.version } }));
      set({ notice: '수정 제안을 확인한 뒤 적용해 주세요. 아직 본문에는 반영하지 않았어요.' });
    } catch (error) {
      if (current(ticket)) set({ notice: errorMessage(error, '수정 제안을 받지 못했어요. 본문과 요청 내용은 유지돼요.') });
    } finally { finish(ticket); }
  }
  function dismissCandidate() {
    if (busy() || state.guard) return;
    const row = active();
    if (row) updateRecord(row.recordId, (record) => ({ ...record, candidate: null }));
  }
  function applyCandidate() {
    if (busy() || state.guard) return;
    const row = active();
    if (!row?.candidate || row.candidate.baseVersion !== row.version) return;
    updateRecord(row.recordId, (record) => ({ ...record, editedText: row.candidate!.text,
      version: record.version + 1, candidate: null, confirmedText: null }));
    set({ notice: '수정 제안을 본문에 적용했어요. 내용을 확인하고 확정해 주세요.' });
  }
  async function confirm() {
    if (disposed || busy() || state.guard) return;
    const row = active();
    if (!row) return;
    if (!services.confirmation) { set({ notice: '관찰일지 저장 기능을 연결하고 있어요. 아직 확정되지 않았어요.' }); return; }
    if (!row.editedText.trim()) { set({ notice: '확정할 본문을 작성해 주세요.' }); return; }
    if (row.candidate) { set({ notice: '수정 제안을 적용하거나 취소한 뒤 확정해 주세요.' }); return; }
    if (row.confirmedText === row.editedText) return;
    const { ticket } = begin('confirming');
    try {
      // This path never invokes prepare/generate/revise. Exact teacher text is authoritative.
      requireConfirmed(await services.confirmation.confirm(row.recordId, { edited_text: row.editedText }));
      if (!current(ticket)) return;
      updateRecord(row.recordId, (record) => record.version === row.version && record.editedText === row.editedText
        ? { ...record, confirmedText: row.editedText } : record);
      set({ notice: '최종 본문을 확정해 저장했어요. 이제 공유할 수 있어요.' });
    } catch (error) {
      if (current(ticket)) set({ notice: errorMessage(error, '저장하지 못했어요. 본문은 유지돼요. 다시 확정해 주세요.') });
    } finally { finish(ticket); }
  }
  async function share() {
    if (disposed || busy() || state.guard) return;
    const row = active();
    if (!row || row.confirmedText === null || row.confirmedText !== row.editedText || row.candidate) {
      set({ notice: '최종 본문을 먼저 확정해 저장해 주세요.' }); return;
    }
    if (!services.sharing) { set({ notice: '공유는 지원되는 휴대전화에서 사용할 수 있어요.' }); return; }
    const { ticket } = begin('sharing');
    try {
      const result = await services.sharing.share(nonblank(row.confirmedText));
      if (result !== 'opened' && result !== 'dismissed') throw new Error('Invalid sharing result');
      if (current(ticket)) set({ notice: result === 'dismissed' ? '공유를 취소했어요. 확정한 기록은 그대로 유지돼요.' : '공유창을 열었어요. 전달 결과는 선택한 앱에서 확인해 주세요.' });
    } catch {
      if (current(ticket)) set({ notice: '공유창을 열지 못했어요. 확정한 기록은 그대로 유지돼요.' });
    } finally { finish(ticket); }
  }
  function resolveGuard(accepted: boolean) {
    if (!state.guard) return;
    const kind = state.guard.kind;
    const action = guardedAction;
    guardedAction = null;
    set({ guard: null });
    if (kind === 'leave' && !accepted) { leaveAnswer?.(false); leaveAnswer = null; }
    if (accepted) action?.();
  }
  function leave(): Promise<boolean> {
    if (disposed || state.guard) return Promise.resolve(false);
    if (!busy()) return Promise.resolve(true); // Tab changes preserve this controller, including edits.
    if (state.phase === 'confirming' || state.phase === 'sharing') {
      set({ notice: '저장이나 공유 처리를 마친 뒤 이동해 주세요.' }); return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      leaveAnswer = resolve;
      guard('leave', () => { cancelOperation(); leaveAnswer?.(true); leaveAnswer = null; });
    });
  }
  function dispose() {
    disposed = true; operation++; listVersion++; abort?.abort(); leaveAnswer?.(false); listeners.clear();
  }
  return {
    getSnapshot: () => state, capabilities,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    openPicker, refreshRecordings, cancelPicker, toggleRecording, importRecordings, removeRecording,
    generate, selectRecord, editText, editPrompt, revise, dismissCandidate, applyCandidate, confirm, share,
    resolveGuard, leave, dispose,
  };
}

export type WritingController = ReturnType<typeof createWritingController>;
