import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import React from 'react';
import type {
  EditableJournal, WritingActions, WritingCapabilities, WritingState, WritingViewProps,
} from '../src/writing/types';

// Server markup checks screen isolation and disabled actions. It does not test
// browser layout, keyboard behavior, native touch targets, or OS sharing.
const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup(node: React.ReactNode): string;
};
let temporaryDirectory: string;
let WritingView: React.ComponentType<WritingViewProps>;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'patpat-writing-view-'));
  const output = path.join(temporaryDirectory, 'writing-view.cjs');
  const esbuild = require(require.resolve('esbuild', { paths: [path.dirname(require.resolve('tsx'))] }));
  await esbuild.build({
    entryPoints: [path.resolve('src/writing/WritingView.tsx')], outfile: output,
    bundle: true, platform: 'node', jsx: 'automatic', logLevel: 'silent',
    plugins: [{
      name: 'markup-test-adapters',
      setup(build: {
        onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => object): void;
        onLoad(options: { filter: RegExp; namespace: string }, callback: () => object): void;
      }) {
        // Absolute external paths allow the temporary bundle to reuse this
        // project's React instance without creating generated workspace files.
        build.onResolve({ filter: /^(react(?:\/jsx-runtime)?|react-native(?:-web)?)$/ }, (args) => ({
          path: require.resolve(args.path === 'react-native' ? 'react-native-web' : args.path), external: true,
        }));
        build.onResolve({ filter: /^@expo\/vector-icons$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({
          contents: 'exports.Ionicons = function(){ return null; };', loader: 'js',
        }));
      },
    }],
  });
  WritingView = require(output).WritingView;
});

after(async () => {
  if (temporaryDirectory) {
    const target = path.resolve(temporaryDirectory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('patpat-writing-view-'));
    await rm(target, { recursive: true, force: true });
  }
});

const noop = () => {};
const actions: WritingActions = {
  next: noop, openEditor: noop, openRevision: noop, back: noop,
  openPicker: noop, refreshRecordings: noop, toggleRecording: noop, cancelPicker: noop,
  importRecordings: noop, removeRecording: noop, generate: noop, selectRecord: noop,
  editText: noop, editPrompt: noop, revise: noop, dismissCandidate: noop,
  applyCandidate: noop, confirm: noop, share: noop, resolveGuard: noop,
};
const capabilities: WritingCapabilities = { generation: true, revision: true, confirmation: true, sharing: true };
const file = {
  uri: 'file:///documents/recordings/2026-11-04/2026-11-04_09-10.m4a',
  fileName: '2026-11-04_09-10.m4a', dateKey: '2026-11-04', startTime: '09:10',
};
const record: EditableJournal = {
  recordId: 'J1', childId: 'C01',
  sentences: [{ text: '가상 아동이 블록 두 개를 쌓았다.', observationIds: ['O1'], contentKind: '관찰' }],
  missingEvidence: false, initialText: '가상 아동이 블록 두 개를 쌓았다.',
  editedText: '가상 아동이 블록 두 개를 쌓았다.', prompt: '문장을 간결하게 수정해 줘.',
  version: 1, candidate: null, confirmedText: null,
};
function state(route: WritingState['route'], changed: Partial<EditableJournal> = {}): WritingState {
  return {
    route, recordings: { status: 'ready', data: [file] }, selected: [file], checked: [file.uri],
    activeRecordId: 'J1', phase: 'idle', notice: null, guard: null,
    draft: {
      commonText: '가상 공통 활동', records: [{ ...record, ...changed }],
      context: {
        recordingUris: [file.uri], childIds: ['C01'], privacyVerified: true,
        observations: [{
          observation_id: 'O1', child_ids: ['C01'], activity: '가상 블록 놀이',
          text: '가상 아동이 블록 두 개를 쌓음', observation_type: ['행동'], scope: 'individual', sensitive: false,
        }],
      },
    },
  };
}
function render(input: WritingState, caps = capabilities) {
  return renderToStaticMarkup(React.createElement(WritingView, { state: input, capabilities: caps, actions }));
}
function tag(html: string, id: string) {
  const match = html.match(new RegExp('<[^>]+data-testid="' + id + '"[^>]*>'));
  assert.ok(match, 'Expected visible control: ' + id);
  return match[0];
}
function disabled(html: string, id: string) { return /aria-disabled="true"/.test(tag(html, id)); }
function absent(html: string, ...ids: string[]) {
  for (const id of ids) assert.ok(!html.includes('data-testid="' + id + '"'), 'Unexpected control: ' + id);
}

test('selection displays the recording list and Next without later writing steps', () => {
  const html = render({ ...state('picker'), draft: null, activeRecordId: null });
  assert.ok(html.includes(file.fileName));
  assert.ok(html.includes('aria-checked="true"'));
  assert.equal(disabled(html, 'writing-next'), false);
  absent(html, 'writing-body', 'writing-prompt', 'writing-open-editor', 'writing-confirm', 'writing-share');
});

test('review displays readonly prose and three branches without prompt or sharing', () => {
  const html = render(state('review'));
  assert.ok(html.includes(record.editedText));
  assert.ok(!html.includes('<textarea'));
  for (const id of ['writing-open-editor', 'writing-open-revision', 'writing-confirm']) {
    assert.equal(disabled(html, id), false);
  }
  absent(html, 'writing-prompt', 'writing-next', 'writing-share');
});

test('manual edit is a dedicated editable body with Complete', () => {
  const html = render(state('edit'));
  assert.ok(tag(html, 'writing-body').startsWith('<textarea'));
  assert.ok(html.includes(record.editedText));
  assert.equal(disabled(html, 'writing-confirm'), false);
  absent(html, 'writing-prompt', 'writing-open-editor', 'writing-open-revision', 'writing-revise', 'writing-share');
});

test('AI revision shows only prompt input and Revise among writing actions', () => {
  const html = render(state('revision'));
  assert.ok(tag(html, 'writing-prompt').startsWith('<textarea'));
  assert.ok(html.includes(record.prompt));
  assert.equal(disabled(html, 'writing-revise'), false);
  absent(html, 'writing-body', 'writing-confirm', 'writing-share', 'writing-open-editor');
});

test('complete displays confirmed readonly prose and sharing only', () => {
  const html = render(state('complete', { confirmedText: record.editedText }));
  assert.ok(html.includes(record.editedText));
  assert.ok(!html.includes('<textarea'));
  assert.equal(disabled(html, 'writing-share'), false);
  absent(html, 'writing-confirm', 'writing-prompt', 'writing-open-editor', 'writing-open-revision', 'writing-next');
});

test('a pending AI candidate preserves original prose and blocks all three branches', () => {
  const html = render(state('review', { candidate: { text: '가상 수정 후보 본문', baseVersion: 1 } }));
  assert.ok(html.includes('가상 수정 후보 본문'));
  assert.ok(html.includes(record.editedText));
  for (const id of ['writing-open-editor', 'writing-open-revision', 'writing-confirm']) assert.ok(disabled(html, id));
  assert.equal(disabled(html, 'writing-candidate-apply'), false);
  assert.equal(disabled(html, 'writing-candidate-cancel'), false);
});

test('empty or unavailable inputs and disconnected services cannot execute actions', () => {
  assert.ok(disabled(render({ ...state('picker'), checked: [] }), 'writing-next'));
  assert.ok(disabled(render({ ...state('picker'), recordings: { status: 'loading' } }), 'writing-next'));
  const disconnected = render(state('picker'), { ...capabilities, generation: false });
  assert.ok(disabled(disconnected, 'writing-next'));
  assert.ok(disconnected.includes('연결 준비 중'));
  assert.ok(disabled(render(state('revision', { prompt: ' \n' })), 'writing-revise'));
  assert.ok(disabled(render(state('revision'), { ...capabilities, revision: false }), 'writing-revise'));
  assert.ok(disabled(render(state('edit', { editedText: ' \n' })), 'writing-confirm'));
  assert.ok(disabled(render(state('review'), { ...capabilities, confirmation: false }), 'writing-confirm'));
  assert.ok(disabled(render(state('complete')), 'writing-share'));
});

test('processing disables navigation branches and duplicate submit or sharing', () => {
  const saving = render({ ...state('review'), phase: 'confirming' });
  for (const id of ['writing-open-editor', 'writing-open-revision', 'writing-confirm']) assert.ok(disabled(saving, id));
  assert.ok(disabled(render({ ...state('picker'), phase: 'generating' }), 'writing-next'));
  assert.ok(disabled(render({ ...state('revision'), phase: 'revising' }), 'writing-revise'));
  assert.ok(disabled(render({ ...state('complete', { confirmedText: record.editedText }), phase: 'sharing' }), 'writing-share'));
});
