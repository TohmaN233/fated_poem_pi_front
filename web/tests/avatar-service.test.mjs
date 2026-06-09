import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAvatarMap, saveAvatarFromDataUrl } from '../server/avatar-service.mjs';

test('saveAvatarFromDataUrl stores a local avatar and records a public user URL', async () => {
  const userDir = await mkdtemp(join(tmpdir(), 'dest-poet-user-'));
  try {
    const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
    const avatar = await saveAvatarFromDataUrl({ userDir, characterKey: '赫利俄丝', dataUrl: png1x1, sourceName: 'helios.png' });

    assert.equal(avatar.characterKey, '赫利俄丝');
    assert.match(decodeURIComponent(avatar.url), /^\/user\/images\/dest-poet-web\/avatars\/赫利俄丝_/);
    assert.match(avatar.url, /\.png$/);

    const map = await readAvatarMap(userDir);
    assert.equal(map.avatars['赫利俄丝'].url, avatar.url);

    const stored = await readFile(join(userDir, avatar.file));
    assert.ok(stored.length > 0);
  } finally {
    await rm(userDir, { recursive: true, force: true });
  }
});
