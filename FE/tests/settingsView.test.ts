import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import React from 'react';
import type { Account } from '../src/auth/controller';
import type { SettingsViewProps } from '../src/roster/SettingsScreen';
import type { CharacteristicsEntry, RosterState } from '../src/roster/controller';

// Static markup validates fields/actions, not native layout, keyboard or touch.
const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require('react-dom/server');
let directory: string;
let SettingsView: React.ComponentType<SettingsViewProps>;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'patpat-settings-view-'));
  const output = path.join(directory, 'settings-view.cjs');
  const esbuild = require(require.resolve('esbuild', { paths: [path.dirname(require.resolve('tsx'))] }));
  await esbuild.build({
    entryPoints: [path.resolve('src/roster/SettingsScreen.tsx')], outfile: output,
    bundle: true, platform: 'node', jsx: 'automatic', logLevel: 'silent',
    plugins: [{ name: 'markup-adapters', setup(build: {
      onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => object): void;
      onLoad(options: { filter: RegExp; namespace: string }, callback: () => object): void;
    }) {
      build.onResolve({ filter: /^(react(?:\/jsx-runtime)?|react-native(?:-web)?)$/ }, args => ({
        path: require.resolve(args.path === 'react-native' ? 'react-native-web' : args.path), external: true,
      }));
      build.onResolve({ filter: /^@expo\/vector-icons$/ }, () => ({ path: 'icons', namespace: 'stub' }));
      build.onLoad({ filter: /icons/, namespace: 'stub' }, () => ({ contents: 'exports.Ionicons = function(){return null;};' }));
      build.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({ path: 'safe-area', namespace: 'stub' }));
      build.onLoad({ filter: /safe-area/, namespace: 'stub' }, () => ({ contents: 'exports.useSafeAreaInsets = () => ({top:0,bottom:0,left:0,right:0});' }));
    } }],
  });
  SettingsView = require(output).SettingsView;
});
after(async () => {
  if (!directory) return;
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), path.resolve(tmpdir()));
  assert.ok(path.basename(target).startsWith('patpat-settings-view-'));
  await rm(target, { recursive: true, force: true });
});
const noop = () => {};
const state: RosterState = {
  items: [{ child_id: 'Z', name: '하늘가상', is_active: true },
    { child_id: 'A', name: '가람가상', is_active: true }, { child_id: 'B', name: '가람가상', is_active: false }],
  loading: false, saving: false, loaded: true, notice: null, selecting: false, selectedIds: [], confirming: false,
  characteristicsChildId: null, characteristicsDrafts: new Map(),
  characteristicsEntries: new Map(), dialog: null,
};
const account = {
  session: { token: 'fictional-token', teacher: { teacher_id: 'teacher-demo', display_name: '가상 교사' } },
  busy: false, notice: null,
} as Account;
function render(patch: Partial<RosterState> = {}, name = '새 가상 아동', accountPatch: Partial<Account> = {}) {
  return renderToStaticMarkup(React.createElement(SettingsView, {
    state: { ...state, ...patch }, account: { ...account, ...accountPatch }, name, onNameChange: noop, onBack: noop, onAdd: noop,
    onRefresh: noop, onSelect: noop, onCancelSelection: noop, onToggle: noop, onRequestDelete: noop,
    onCancelDelete: noop, onDelete: noop, onLogout: noop, onOpenCharacteristics: noop, onCharacteristicsChange: noop,
    onSaveCharacteristics: noop, onResolveDialog: noop,
  }));
}
function tag(html: string, id: string) {
  const match = html.match(new RegExp('<[^>]+data-testid="' + id + '"[^>]*>'));
  assert.ok(match, 'Missing control ' + id); return match[0];
}
function disabled(html: string, id: string) { return /aria-disabled="true"/.test(tag(html, id)); }
function entry(patch: Partial<CharacteristicsEntry> = {}): CharacteristicsEntry {
  return { savedText: null, loadState: 'ready', saveState: 'idle', ...patch };
}

test('all server children render once per row without inline editing or activity controls', () => {
  const html = render();
  assert.equal((html.match(/<input/g) || []).length, 1); // New-child input only.
  assert.equal((html.match(/>가람가상<\/div>/g) || []).length, 2); // Homonyms are two children.
  for (const id of ['A', 'B', 'Z']) tag(html, 'settings-child-row-' + id);
  assert.ok(html.indexOf('settings-child-row-A') < html.indexOf('settings-child-row-Z'));
  assert.ok(html.includes('가상 교사 선생님') && html.includes('로그아웃'));
  assert.ok(!html.includes('비활성') && !html.includes('이름 저장') && !html.includes('role="switch"'));
  assert.ok(!html.includes('settings-delete-actions'));
  assert.deepEqual(state.items.map(child => child.child_id), ['Z', 'A', 'B']);
});

test('selection identifies children by ID, disables adding, and permits refreshing', () => {
  const html = render({ selecting: true, selectedIds: ['A'] });
  assert.ok(/aria-checked="true"/.test(tag(html, 'settings-child-row-A')));
  assert.ok(/aria-checked="false"/.test(tag(html, 'settings-child-row-B')));
  assert.ok(disabled(html, 'settings-child-add'));
  assert.equal(disabled(html, 'settings-child-refresh'), false);
  assert.equal(disabled(html, 'settings-delete-selected'), false);
  assert.ok(disabled(render({ selecting: true }), 'settings-delete-selected'));
});

test('confirmation shows target names and count with record preservation before deletion', () => {
  const html = render({ selecting: true, selectedIds: ['A', 'Z'], confirming: true });
  assert.ok(html.includes('선택한 아동 2명을 명단에서 삭제할까요?'));
  assert.ok(html.includes('기존 관찰일지는 유지돼요.'));
  assert.ok(html.includes('가람가상') && html.includes('하늘가상'));
  assert.equal(disabled(html, 'settings-delete-confirm'), false);
  assert.equal(disabled(html, 'settings-child-refresh'), false);
});

test('saving locks confirmation cancellation, closing, refresh and logout for the entire batch', () => {
  const saving = render({ selecting: true, selectedIds: ['A'], confirming: true, saving: true });
  for (const id of ['settings-delete-confirm', 'settings-delete-cancel', 'settings-close', 'settings-logout', 'settings-child-refresh']) {
    assert.ok(disabled(saving, id));
  }
});

test('failed load differs from empty roster and blank new names cannot submit', () => {
  const failed = render({ items: [], loaded: false, notice: '명단 연결에 실패했어요.' });
  assert.ok(failed.includes('명단 연결에 실패했어요.'));
  assert.ok(!failed.includes('등록된 아동이 없어요.'));
  assert.equal(disabled(failed, 'settings-child-refresh'), false);
  assert.ok(disabled(failed, 'settings-child-add'));
  assert.ok(render({ items: [] }).includes('등록된 아동이 없어요.'));
  assert.ok(disabled(render({}, ' \n'), 'settings-child-add'));
});

test('each normal child row has a characteristics action hidden during deletion selection', () => {
  const html = render();
  for (const id of ['A', 'B', 'Z']) {
    assert.equal(disabled(html, 'settings-child-characteristics-' + id), false);
  }
  assert.ok(tag(html, 'settings-child-characteristics-A').includes('aria-label="가람가상 특성 작성"'));
  assert.ok(!render({ selecting: true, selectedIds: ['A'] }).includes('settings-child-characteristics-'));
  assert.ok(!render({ selecting: true, selectedIds: ['A'], confirming: true }).includes('settings-child-characteristics-'));
  for (const patch of [{ loading: true }, { saving: true }, { loaded: false }]) {
    assert.ok(disabled(render(patch), 'settings-child-characteristics-A'));
  }
  assert.ok(disabled(render({}, '', { busy: true }), 'settings-child-characteristics-A'));
});

test('characteristics screen shows the named child, exact multiline draft, and explicit save action', () => {
  const draft = '  가상 아동의 블록 놀이 메모\n도움이 필요하면 이야기해요.  ';
  const html = render({ characteristicsChildId: 'B', characteristicsDrafts: new Map([
    ['A', '다른 아동만의 가상 메모'], ['B', draft],
  ]), characteristicsEntries: new Map([['B', entry()]]) });
  tag(html, 'settings-characteristics-back');
  tag(html, 'settings-characteristics-child-name');
  assert.ok(html.includes('아동 특성') && html.includes('가람가상'));
  assert.ok(html.includes('아동에 대해 알려주세요.'));
  assert.ok(html.includes('좋아하는 놀이, 평소 표현 방식, 도움이 필요한 상황을 자유롭게 적어주세요.'));
  assert.ok(html.includes('작성한 뒤 저장하기를 눌러주세요.'));
  assert.ok(html.includes('아직 저장하지 않은 내용이 있어요.'));
  assert.equal(disabled(html, 'settings-characteristics-save'), false);
  assert.ok(html.indexOf('settings-characteristics-input') < html.indexOf('settings-characteristics-save'));
  const input = tag(html, 'settings-characteristics-input');
  assert.ok(input.startsWith('<textarea'));
  assert.ok(input.includes('aria-label="아동 특성"'));
  assert.ok(input.includes('placeholder="아동의 특성을 자유롭게 적어주세요."'));
  assert.ok(html.includes(draft));
  assert.ok(!html.includes('다른 아동만의 가상 메모'));
  for (const control of ['settings-child-add', 'settings-child-select', 'settings-delete-actions', 'settings-close', 'settings-logout']) {
    assert.ok(!html.includes(control));
  }
  assert.ok(!html.includes('설정을 닫으면 사라져요.') && !html.includes('settings-child-characteristics-'));
  assert.ok(!html.includes('저장됨') && !html.includes('settings-dialog'));
});

test('characteristics accepts an empty draft and displays a long child name without truncating its text', () => {
  const name = '가상 아동의 아주 긴 이름'.repeat(4);
  const html = render({ items: [{ child_id: 'LONG', name, is_active: true }], characteristicsChildId: 'LONG' });
  assert.ok(html.includes(name));
  assert.ok(html.includes('</textarea>'));
  assert.ok(!/\brequired(?:=|\s|>)/.test(tag(html, 'settings-characteristics-input')));
  assert.equal(disabled(html, 'settings-characteristics-input'), false);
  assert.equal(disabled(html, 'settings-characteristics-back'), false);
});

test('characteristics editing is locked while loading, saving or logging out', () => {
  for (const patch of [{ loading: true }, { saving: true }]) {
    assert.ok(disabled(render({ ...patch, characteristicsChildId: 'A' }), 'settings-characteristics-input'));
  }
  const logout = render({ characteristicsChildId: 'A' }, '', { busy: true });
  assert.ok(disabled(logout, 'settings-characteristics-input'));
  assert.ok(disabled(logout, 'settings-characteristics-back'));
  assert.ok(disabled(render({ characteristicsChildId: 'A', saving: true }), 'settings-characteristics-back'));
});

test('saving shows progress and blocks editing, saving again, back and roster logout', () => {
  const html = render({ characteristicsChildId: 'A', saving: true, characteristicsDrafts: new Map([['A', '가상 입력']]),
    characteristicsEntries: new Map([['A', entry({ saveState: 'saving' })]]) });
  assert.ok(html.includes('저장 중…'));
  for (const id of ['settings-characteristics-input', 'settings-characteristics-save', 'settings-characteristics-back']) {
    assert.ok(disabled(html, id));
  }
  assert.ok(disabled(render({ saving: true }), 'settings-logout'));
});

test('save enablement requires a changed draft and a checked or unavailable baseline', () => {
  for (const loadState of ['idle', 'loading', 'error'] as const) {
    const html = render({ characteristicsChildId: 'A', characteristicsDrafts: new Map([['A', '가상 변경']]),
      characteristicsEntries: new Map([['A', entry({ loadState })]]) });
    assert.ok(disabled(html, 'settings-characteristics-save'));
    if (loadState === 'error') assert.ok(html.includes('저장한 특성을 불러오지 못했어요.'));
  }
  for (const loadState of ['ready', 'unavailable'] as const) {
    assert.equal(disabled(render({ characteristicsChildId: 'A', characteristicsDrafts: new Map([['A', '가상 변경']]),
      characteristicsEntries: new Map([['A', entry({ loadState })]]) }), 'settings-characteristics-save'), false);
  }
  assert.ok(disabled(render({ characteristicsChildId: 'A', characteristicsDrafts: new Map([['A', '기존 가상 입력']]),
    characteristicsEntries: new Map([['A', entry({ savedText: '기존 가상 입력' })]]) }), 'settings-characteristics-save'));
  assert.equal(disabled(render({ characteristicsChildId: 'A', characteristicsDrafts: new Map([['A', '']]),
    characteristicsEntries: new Map([['A', entry({ savedText: '지울 가상 입력' })]]) }), 'settings-characteristics-save'), false);
});

test('confirmed success shows the saved status and acknowledgement while masking background controls', () => {
  const html = render({ characteristicsChildId: 'A', characteristicsDrafts: new Map([['A', '저장된 가상 입력']]),
    characteristicsEntries: new Map([['A', entry({ savedText: '저장된 가상 입력', saveState: 'saved' })]]),
    dialog: { kind: 'saved', childId: 'A' } });
  assert.ok(html.includes('아동 특성을 저장했어요.') && html.includes('저장됨'));
  assert.ok(tag(html, 'settings-content').includes('aria-hidden="true"'));
  assert.ok(tag(html, 'settings-dialog').includes('aria-modal="true"'));
  assert.ok(disabled(html, 'settings-characteristics-input'));
  assert.ok(disabled(html, 'settings-characteristics-back'));
  assert.equal(disabled(html, 'settings-dialog-dismiss'), false);
  assert.ok(!html.includes('settings-dialog-retry'));
});

test('failed save exposes retry and retains the exact input without claiming success', () => {
  const draft = '  실패 후 남겨둘 가상 입력\n줄바꿈  ';
  const html = render({ characteristicsChildId: 'A', characteristicsDrafts: new Map([['A', draft]]),
    characteristicsEntries: new Map([['A', entry({ savedText: '이전 가상 저장본', saveState: 'error' })]]),
    dialog: { kind: 'saveFailed', childId: 'A', unavailable: false } });
  assert.ok(html.includes(draft));
  assert.ok(html.includes('저장하지 못했어요. 입력한 내용은 유지돼요. 다시 시도해 주세요.'));
  tag(html, 'settings-dialog-retry'); tag(html, 'settings-dialog-dismiss');
  assert.ok(!html.includes('저장됨') && !html.includes('아동 특성을 저장했어요.'));
});

test('unconnected save has a clear acknowledgement without false success or automatic retry', () => {
  const html = render({ characteristicsChildId: 'A', characteristicsDrafts: new Map([['A', '가상 입력']]),
    characteristicsEntries: new Map([['A', entry({ loadState: 'unavailable', saveState: 'unavailable' })]]),
    dialog: { kind: 'saveFailed', childId: 'A', unavailable: true } });
  assert.ok(html.includes('아직 저장 기능이 연결되지 않았어요. 입력한 내용은 유지돼요.'));
  assert.ok(html.includes('아직 저장되지 않았어요.'));
  tag(html, 'settings-dialog-dismiss');
  assert.ok(!html.includes('settings-dialog-retry') && !html.includes('저장됨'));
});

test('unsaved leave and logout dialogs offer explicit navigation or cancellation actions', () => {
  const leave = render({ dialog: { kind: 'leave', childId: 'A', destination: 'close' } });
  assert.ok(leave.includes('아직 저장하지 않은 내용이 있어요. 입력한 내용은 이번 로그인 동안 유지돼요.'));
  tag(leave, 'settings-dialog-stay'); tag(leave, 'settings-dialog-leave');
  assert.ok(disabled(leave, 'settings-close') && disabled(leave, 'settings-logout'));
  assert.ok(tag(leave, 'settings-content').includes('aria-hidden="true"'));
  const logout = render({ dialog: { kind: 'logout', childId: 'A' } });
  assert.ok(logout.includes('로그아웃하면 저장하지 않은 아동 특성이 사라져요.'));
  tag(logout, 'settings-dialog-stay'); tag(logout, 'settings-dialog-logout');
});
