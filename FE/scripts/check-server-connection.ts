/** Exercise the actual FE client/controllers against FastAPI + temporary SQLite. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi, ApiError } from '../src/api/client';
import { createAuthController, type TokenStore } from '../src/auth/controller';
import { createRosterController } from '../src/roster/controller';

const backend = resolve(process.cwd(), '../BE');
const python = process.env.PATPAT_TEST_PYTHON ?? join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
async function main() {
  const temporary = await mkdtemp(join(tmpdir(), 'patpat-connection-'));
  const script = `
  import os, socket, sys
  os.environ['PATPAT_DATABASE_PATH'] = sys.argv[1]
  os.environ['PATPAT_AUDIO_PATH'] = os.path.join(os.path.dirname(sys.argv[1]), 'audio')
  from app.main import create_app
  from app.manage import create_teacher
  import uvicorn
  app = create_app()
  if sys.argv[3] == 'seed':
      create_teacher(app.state.database, 'fictional-one', '가상 교사 1', 'fictional-password-one')
      create_teacher(app.state.database, 'fictional-two', '가상 교사 2', 'fictional-password-two')
  sock = socket.socket()
  sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
  sock.bind(('127.0.0.1', int(sys.argv[2])))
  sock.listen(128)
  print(sock.getsockname()[1], flush=True)
  uvicorn.Server(uvicorn.Config(app, log_level='error')).run(sockets=[sock])
  `;
  let child: ReturnType<typeof spawn> | null = null;
  async function stop() {
    if (!child) return;
    const processToStop = child;
    child = null;
    if (processToStop.exitCode === null) {
      const closed = once(processToStop, 'exit');
      processToStop.kill('SIGTERM');
      const timer = setTimeout(() => processToStop.kill('SIGKILL'), 5000);
      try { await closed; } finally { clearTimeout(timer); }
    }
  }
  async function start(port = 0) {
    child = spawn(python, ['-u', '-c', script, join(temporary, 'integration.sqlite3'), String(port), port ? 'reuse' : 'seed'],
      { cwd: backend, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let failure = '';
    child.stdout?.on('data', value => { output += String(value); });
    child.stderr?.on('data', value => { failure += String(value); });
    let spawnError: Error | null = null;
    child.on('error', error => { spawnError = error; });
    for (let tries = 0; tries < 100; tries++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('Backend startup failed: ' + failure);
      const line = output.split('\n')[0];
      if (/^\d+$/.test(line)) {
        const base = 'http://127.0.0.1:' + line;
        try { if ((await fetch(base + '/health')).ok) return { base, port: Number(line) }; } catch { /* Startup in progress. */ }
      }
      await delay(100);
    }
    throw new Error('Backend startup timed out');
  }

  try {
    const server = await start();
    const api = createApi(server.base);
    let stored: string | null = null;
    const store: TokenStore = { async read() { return stored; }, async write(token) { stored = token; }, async clear() { stored = null; } };
    const auth = createAuthController(api, store);
    await auth.restore();
    await auth.login('fictional-one', 'fictional-password-one');
    assert.equal(auth.getSnapshot().phase, 'signedIn');
    const token = auth.getSnapshot().session!.token;
    const roster = createRosterController(api, token, error => { void auth.unauthorized(error, token); });
    await roster.refresh();
    assert.equal(await roster.create('가상 아동'), true);
    const id = roster.getSnapshot().items[0].child_id;
    assert.equal(await roster.rename(id, '  가상 새 이름  '), true);
    assert.equal(await roster.create('가상 아동'), true);
    const second = await api.login('fictional-two', 'fictional-password-two');
    assert.deepEqual(await api.listChildren(second.access_token, true), []);
    await assert.rejects(api.renameChild(second.access_token, id, '다른 교사 수정'), (error: ApiError) => error.status === 404);
    // Real multipart audio, then the FE client reads the persisted recording.
    const audio = new Uint8Array(1644);
    const view = new DataView(audio.buffer);
    const ascii = (at: number, value: string) => { for (let i = 0; i < value.length; i++) audio[at + i] = value.charCodeAt(i); };
    ascii(0, 'RIFF'); view.setUint32(4, 1636, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, 1600, true);
    async function uploadAudio() {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'synthetic.wav');
      form.append('title', '가상 녹음'); form.append('recorded_at', '2026-11-04T09:10:11+09:00'); form.append('duration_seconds', '0.1');
      const response = await fetch(server.base + '/api/v1/recordings', { method: 'POST', body: form,
        headers: { Authorization: 'Bearer ' + token, 'Idempotency-Key': 'persistent-integration-upload' } });
      assert.equal(response.status, 201); return await response.json() as { recording_id: string };
    }
    const uploaded = await uploadAudio();
    assert.equal((await uploadAudio()).recording_id, uploaded.recording_id);
    assert.equal((await api.listRecordings(token)).total, 1);
    assert.equal((await api.listRecordings(second.access_token)).total, 0);
    await assert.rejects(api.getRecording(second.access_token, uploaded.recording_id), (error: ApiError) => error.status === 404);
    await stop();
    await assert.rejects(api.listRecordings(token), (error: ApiError) => error.status === 0);
    await start(server.port);
    assert.equal((await api.getRecording(token, uploaded.recording_id)).size_bytes, audio.byteLength);
    const playback = await fetch(server.base + '/api/v1/recordings/' + uploaded.recording_id + '/audio',
      { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(playback.status, 200);
    assert.deepEqual(new Uint8Array(await playback.arrayBuffer()), audio);
    await api.deleteRecording(token, uploaded.recording_id);
    assert.equal((await api.listRecordings(token)).total, 0);
    await assert.rejects(api.getRecording(token, uploaded.recording_id), (error: ApiError) => error.status === 404);
    const restored = createAuthController(api, store);
    await restored.restore();
    assert.equal(restored.getSnapshot().phase, 'signedIn');
    const rows = await api.listChildren(token, true);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].child_id, id);
    assert.equal(rows[0].name, '  가상 새 이름  ');
    // Legacy server contract coverage; the settings UI uses a separate,
    // currently unconnected deleteChild port instead of deactivation.
    const deactivated = await api.deactivateChild(token, id);
    assert.equal(deactivated.is_active, false);
    assert.equal((await api.listChildren(token, false)).length, 1);
    assert.equal((await api.listChildren(token, true))[0].is_active, false);
    await restored.logout();
    assert.equal(await store.read(), null);
    await assert.rejects(api.me(token), (error: ApiError) => error.status === 401);
    assert.equal((await api.me(second.access_token)).teacher_id, second.teacher.teacher_id);
    roster.dispose(); auth.dispose(); restored.dispose();
    console.log('통합 검사 통과: FE 로그인·명단·녹음 업로드/재전송·인증 재생·삭제·교사 분리·서버 재시작·세션 복원·로그아웃');
  } finally {
    await stop();
    await rm(temporary, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
