import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSessions, pickLatestSession } from '../server/session-service.mjs';

async function touch(path, seconds) {
  const date = new Date(seconds * 1000);
  await utimes(path, date, date);
}

test('listSessions returns JSONL saves newest-first with display names and first user text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dest-poet-sessions-'));
  try {
    const older = join(dir, '2026-05-31T00-00-00_old.jsonl');
    const newer = join(dir, '2026-05-31T01-00-00_new.jsonl');
    await writeFile(older, [
      JSON.stringify({ type: 'session', id: 'old', timestamp: '2026-05-31T00:00:00.000Z', cwd: '/game' }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-05-31T00:00:01.000Z', message: { role: 'user', content: '旧存档开场' } }),
    ].join('\n') + '\n');
    await writeFile(newer, [
      JSON.stringify({ type: 'session', id: 'new', timestamp: '2026-05-31T01:00:00.000Z', cwd: '/game' }),
      JSON.stringify({ type: 'session_info', id: 'n1', parentId: null, timestamp: '2026-05-31T01:00:02.000Z', name: '北境石屋' }),
      JSON.stringify({ type: 'message', id: 'u2', parentId: 'n1', timestamp: '2026-05-31T01:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: '新存档开场' }] } }),
    ].join('\n') + '\n');
    await touch(older, 100);
    await touch(newer, 200);

    const sessions = await listSessions(dir);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].file, newer);
    assert.equal(sessions[0].name, '北境石屋');
    assert.equal(sessions[0].preview, '新存档开场');
    assert.equal(sessions[1].preview, '旧存档开场');
    assert.equal(pickLatestSession(sessions)?.file, newer);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
