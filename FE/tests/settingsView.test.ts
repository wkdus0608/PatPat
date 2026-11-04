import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import React from 'react';
import type { Account } from '../src/auth/controller';
import type { SettingsViewProps } from '../src/roster/SettingsScreen';
import type { RosterState } from '../src/roster/controller';

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
};
const account = {
  session: { token: 'fictional-token', teacher: { teacher_id: 'teacher-demo', display_name: '가상 교사' } },
  busy: false, notice: null,
} as Account;
function render(patch: Partial<RosterState> = {}, name = '새 가상 아동') {
  return renderToStaticMarkup(React.createElement(SettingsView, {
    state: { ...state, ...patch }, account, name, onNameChange: noop, onBack: noop, onAdd: noop,
    onRefresh: noop, onSelect: noop, onCancelSelection: noop, onToggle: noop, onRequestDelete: noop,
    onCancelDelete: noop, onDelete: noop, onLogout: noop,
  }));
}
function tag(html: string, id: string) {
  const match = html.match(new RegExp('<[^>]+data-testid="' + id + '"[^>]*>'));
  assert.ok(match, 'Missing control ' + id); return match[0];
}
function disabled(html: string, id: string) { return /aria-disabled="true"/.test(tag(html, id)); }

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
