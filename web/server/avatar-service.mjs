import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const AVATAR_DIR = 'images/dest-poet-web/avatars';
const MAP_FILE = 'web-avatars.json';

function sanitizeKey(value) {
  return String(value || 'character')
    .trim()
    .replace(/[\\/~]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '') || 'character';
}

function extensionFromMime(mime, sourceName = '') {
  const lower = String(sourceName).toLowerCase();
  const byName = lower.match(/\.(png|jpe?g|webp|gif|svg)$/)?.[1];
  if (byName) return byName === 'jpeg' ? 'jpg' : byName;
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('svg')) return 'svg';
  return 'png';
}

function publicUrl(file) {
  return `/user/${file.split('/').map(encodeURIComponent).join('/')}`;
}

function mapPath(userDir) {
  return join(userDir, MAP_FILE);
}

export async function readAvatarMap(userDir) {
  try {
    const raw = await readFile(mapPath(userDir), 'utf8');
    const data = JSON.parse(raw);
    if (!data.avatars || typeof data.avatars !== 'object') data.avatars = {};
    return data;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, avatars: {} };
    throw error;
  }
}

async function writeAvatarMap(userDir, map) {
  await mkdir(dirname(mapPath(userDir)), { recursive: true });
  await writeFile(mapPath(userDir), JSON.stringify(map, null, 2) + '\n');
}

function parseImageDataUrl(dataUrl, label = '图片') {
  const match = String(dataUrl || '').match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s);
  if (!match) throw new Error(`无效的${label} data URL`);
  const mime = match[1];
  if (!mime.startsWith('image/')) throw new Error(`不支持的${label} MIME 类型：${mime}`);
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new Error(`${label}文件为空`);
  return { mime, buffer };
}

async function writeAvatarFile({ userDir, characterKey, buffer, mime, sourceName = '', suffix = '' }) {
  const safeKey = sanitizeKey(characterKey);
  const ext = extensionFromMime(mime, sourceName);
  const file = `${AVATAR_DIR}/${safeKey}_${Date.now().toString(36)}${suffix}.${ext}`;
  const absolute = join(userDir, file);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, buffer);
  return file;
}

async function persistAvatar({ userDir, characterKey, buffer, mime, sourceName = '' }) {
  const file = await writeAvatarFile({ userDir, characterKey, buffer, mime, sourceName });
  const avatar = {
    characterKey: String(characterKey),
    file,
    url: publicUrl(file),
    mime,
    sourceName: sourceName || '',
    updatedAt: new Date().toISOString(),
  };
  const map = await readAvatarMap(userDir);
  map.version = 1;
  map.avatars[String(characterKey)] = avatar;
  await writeAvatarMap(userDir, map);
  return avatar;
}

export async function saveAvatarFromDataUrl({ userDir, characterKey, dataUrl, sourceName = '' }) {
  const { mime, buffer } = parseImageDataUrl(dataUrl, '头像');
  return persistAvatar({ userDir, characterKey, buffer, mime, sourceName });
}

export async function saveAvatarPairFromDataUrls({ userDir, characterKey, originalDataUrl, croppedDataUrl, sourceName = '' }) {
  const original = parseImageDataUrl(originalDataUrl, '原始头像');
  const cropped = parseImageDataUrl(croppedDataUrl, '裁剪头像');
  const file = await writeAvatarFile({ userDir, characterKey, buffer: original.buffer, mime: original.mime, sourceName, suffix: '_original' });
  const croppedFile = await writeAvatarFile({ userDir, characterKey, buffer: cropped.buffer, mime: cropped.mime, sourceName: 'cropped.png', suffix: '_crop' });
  const avatar = {
    characterKey: String(characterKey),
    file,
    url: publicUrl(file),
    mime: original.mime,
    croppedFile,
    croppedUrl: publicUrl(croppedFile),
    croppedMime: cropped.mime,
    sourceName: sourceName || '',
    updatedAt: new Date().toISOString(),
  };
  const map = await readAvatarMap(userDir);
  map.version = 1;
  map.avatars[String(characterKey)] = avatar;
  await writeAvatarMap(userDir, map);
  return avatar;
}

export async function avatarDataUrlFromUrl({ url }) {
  const target = new URL(String(url));
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('头像网址只支持 http/https');
  const response = await fetch(target, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载头像失败：HTTP ${response.status}`);
  const mime = response.headers.get('content-type') || 'image/png';
  if (!mime.startsWith('image/')) throw new Error(`网址返回的不是图片：${mime}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('下载到的头像为空');
  return {
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
    mime,
    sourceName: target.pathname.split('/').pop() || 'avatar',
  };
}

export async function saveAvatarFromUrl({ userDir, characterKey, url, sourceName = '' }) {
  const data = await avatarDataUrlFromUrl({ url });
  const match = data.dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s);
  const buffer = Buffer.from(match[2], 'base64');
  return persistAvatar({ userDir, characterKey, buffer, mime: data.mime, sourceName: sourceName || data.sourceName });
}
