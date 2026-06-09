#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { PiRpcClient } from './pi-rpc-client.mjs';
import { BridgeClient } from './bridge-client.mjs';
import { listSessions, pickLatestSession } from './session-service.mjs';
import { decorateTools } from './tool-template.mjs';
import { avatarDataUrlFromUrl, readAvatarMap, saveAvatarFromDataUrl, saveAvatarFromUrl, saveAvatarPairFromDataUrls } from './avatar-service.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const frontendRoot = resolve(process.env.DEST_POET_FRONTEND_ROOT || resolve(__dirname, '../..'));
const gameRoot = resolve(process.env.DEST_POET_GAME_DIR || frontendRoot);
const gameExtension = resolve(process.env.DEST_POET_GAME_EXTENSION || join(gameRoot, 'extensions/extension.ts'));
const bridgeExtension = resolve(process.env.DEST_POET_WEB_BRIDGE_EXTENSION || join(gameRoot, '.fated_poem_pi_frontend/web-bridge.ts'));
const clientRoot = join(frontendRoot, 'web/client');
const sessionsDir = join(gameRoot, 'sessions');
const userDir = join(frontendRoot, 'user');
const httpPort = Number(process.env.DEST_POET_WEB_PORT || process.env.PORT || 8787);
const httpHost = process.env.DEST_POET_WEB_HOST || '';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 25_000_000) {
        reject(new Error('request body too large (max 25MB)'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
    server.on('error', reject);
  });
}

function sendSse(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

await mkdir(sessionsDir, { recursive: true });
const bridgePort = await getFreePort();
const bridge = new BridgeClient(bridgePort);
const initialSessions = await listSessions(sessionsDir);
const latest = pickLatestSession(initialSessions);

const rpc = new PiRpcClient({
  cwd: gameRoot,
  bridgePort,
  sessionFile: latest?.file,
  gameExtension,
  bridgeExtension,
  sessionDir: sessionsDir,
  env: {
    PI_CODING_AGENT_DIR: join(gameRoot, '.pi/agent'),
  },
});

const sseClients = new Set();
function broadcast(eventName, data) {
  for (const res of sseClients) sendSse(res, eventName, data);
}

rpc.on('event', (event) => broadcast('pi', event));
rpc.on('stderr', (text) => broadcast('stderr', { text }));
rpc.on('exit', (info) => broadcast('server', { type: 'pi_exit', ...info }));
rpc.on('protocol_error', (event) => broadcast('server', { type: 'protocol_error', ...event }));
rpc.start();

async function serveStatic(req, res, pathname) {
  let root = clientRoot;
  let target;
  if (pathname.startsWith('/user/')) {
    root = userDir;
    target = resolve(userDir, decodeURIComponent(pathname.slice('/user/'.length)));
    if (!target.startsWith(userDir)) return json(res, 403, { ok: false, error: 'forbidden' });
    try { await access(target, constants.R_OK); }
    catch { return json(res, 404, { ok: false, error: 'not_found' }); }
  } else {
    target = pathname === '/' ? join(clientRoot, 'index.html') : join(clientRoot, decodeURIComponent(pathname));
    target = resolve(target);
    if (!target.startsWith(root)) return json(res, 403, { ok: false, error: 'forbidden' });
    try { await access(target, constants.R_OK); }
    catch { target = join(clientRoot, 'index.html'); }
  }
  const type = mime[extname(target)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(target).pipe(res);
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    sseClients.add(res);
    sendSse(res, 'server', { type: 'connected', bridgePort, defaultSession: latest?.file || null });
    const heartbeat = setInterval(() => sendSse(res, 'ping', { time: Date.now() }), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    let bridgeHealth = null;
    try { bridgeHealth = await bridge.health(); } catch (error) { bridgeHealth = { ok: false, error: error.message }; }
    return json(res, 200, { ok: true, frontendRoot, gameRoot, sessionsDir, userDir, gameExtension, bridgeExtension, bridgePort, bridge: bridgeHealth });
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return json(res, 200, { ok: true, sessions: await listSessions(sessionsDir), currentDefault: latest?.file || null });
  }

  if (req.method === 'GET' && url.pathname === '/api/messages') {
    const data = await rpc.request({ type: 'get_messages' }, { timeoutMs: 30_000 });
    return json(res, 200, { ok: true, ...data });
  }

  if (req.method === 'GET' && url.pathname === '/api/rpc-state') {
    const data = await rpc.request({ type: 'get_state' }, { timeoutMs: 30_000 });
    return json(res, 200, { ok: true, data });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const data = await bridge.state();
    return json(res, 200, data);
  }

  if (req.method === 'GET' && url.pathname === '/api/characters') {
    const data = await bridge.characters();
    return json(res, 200, data);
  }

  if (req.method === 'GET' && url.pathname === '/api/tools') {
    const data = await bridge.tools();
    return json(res, 200, { ok: true, tools: decorateTools(data.tools || []) });
  }

  if (req.method === 'GET' && url.pathname === '/api/commands') {
    const data = await rpc.request({ type: 'get_commands' }, { timeoutMs: 30_000 });
    return json(res, 200, { ok: true, ...(data || {}) });
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    const [models, rpcState] = await Promise.all([
      rpc.request({ type: 'get_available_models' }, { timeoutMs: 30_000 }),
      rpc.request({ type: 'get_state' }, { timeoutMs: 30_000 }),
    ]);
    return json(res, 200, { ok: true, models: models.models || [], state: rpcState });
  }

  if (req.method === 'POST' && url.pathname === '/api/model') {
    const body = await readBody(req);
    const provider = String(body.provider || '');
    const modelId = String(body.modelId || body.id || '');
    if (!provider || !modelId) return json(res, 400, { ok: false, error: '缺少 provider/modelId' });
    const data = await rpc.request({ type: 'set_model', provider, modelId }, { timeoutMs: 30_000 });
    broadcast('server', { type: 'model_changed', provider, modelId });
    return json(res, 200, { ok: true, data });
  }

  if (req.method === 'POST' && url.pathname === '/api/model/cycle') {
    const data = await rpc.request({ type: 'cycle_model' }, { timeoutMs: 30_000 });
    broadcast('server', { type: 'model_changed', data });
    return json(res, 200, { ok: true, data });
  }

  if (req.method === 'POST' && url.pathname === '/api/thinking') {
    const body = await readBody(req);
    const level = String(body.level || 'off');
    const data = await rpc.request({ type: 'set_thinking_level', level }, { timeoutMs: 30_000 });
    broadcast('server', { type: 'thinking_changed', level });
    return json(res, 200, { ok: true, data });
  }

  if (req.method === 'GET' && url.pathname === '/api/avatars') {
    const data = await readAvatarMap(userDir);
    return json(res, 200, { ok: true, avatars: data.avatars || {} });
  }

  if (req.method === 'POST' && url.pathname === '/api/avatar') {
    const body = await readBody(req);
    if (!body.characterKey) return json(res, 400, { ok: false, error: '缺少 characterKey' });
    const avatar = body.originalDataUrl && body.dataUrl
      ? await saveAvatarPairFromDataUrls({ userDir, characterKey: body.characterKey, originalDataUrl: body.originalDataUrl, croppedDataUrl: body.dataUrl, sourceName: body.sourceName || '' })
      : body.url
        ? await saveAvatarFromUrl({ userDir, characterKey: body.characterKey, url: body.url, sourceName: body.sourceName || '' })
        : await saveAvatarFromDataUrl({ userDir, characterKey: body.characterKey, dataUrl: body.dataUrl, sourceName: body.sourceName || '' });
    broadcast('server', { type: 'avatar_changed', characterKey: body.characterKey, avatar });
    return json(res, 200, { ok: true, avatar });
  }

  if (req.method === 'POST' && url.pathname === '/api/avatar/fetch-url') {
    const body = await readBody(req);
    if (!body.url) return json(res, 400, { ok: false, error: '缺少 url' });
    const data = await avatarDataUrlFromUrl({ url: body.url });
    return json(res, 200, { ok: true, ...data });
  }

  if (req.method === 'POST' && url.pathname === '/api/prompt') {
    const body = await readBody(req);
    const command = { type: 'prompt', message: String(body.message || '') };
    if (body.streamingBehavior) command.streamingBehavior = body.streamingBehavior;
    if (Array.isArray(body.images)) command.images = body.images;
    const data = await rpc.request(command, { timeoutMs: 30_000 });
    return json(res, 200, { ok: true, data });
  }

  if (req.method === 'POST' && url.pathname === '/api/abort') {
    const data = await rpc.request({ type: 'abort' }, { timeoutMs: 10_000 });
    return json(res, 200, { ok: true, data });
  }

  if (req.method === 'POST' && url.pathname === '/api/session/switch') {
    const body = await readBody(req);
    const file = resolve(String(body.file || ''));
    if (relative(sessionsDir, file).startsWith('..')) return json(res, 403, { ok: false, error: 'session outside sessions dir' });
    const data = await rpc.request({ type: 'switch_session', sessionPath: file }, { timeoutMs: 60_000 });
    broadcast('server', { type: 'session_switched', file });
    return json(res, 200, { ok: true, data });
  }

  if (req.method === 'POST' && url.pathname === '/api/session/new') {
    const data = await rpc.request({ type: 'new_session' }, { timeoutMs: 60_000 });
    broadcast('server', { type: 'session_new' });
    return json(res, 200, { ok: true, data });
  }

  if (req.method === 'POST' && url.pathname === '/api/action') {
    const body = await readBody(req);
    const data = await bridge.action(body);
    broadcast('server', { type: 'state_changed', action: body.type });
    return json(res, 200, data);
  }

  if (req.method === 'POST' && url.pathname === '/api/safe-tool') {
    const body = await readBody(req);
    const data = await bridge.safeTool(body.name, body.args || {});
    return json(res, 200, data);
  }

  return json(res, 404, { ok: false, error: 'not_found' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = Number(error?.status || 500);
    return json(res, status, { ok: false, error: error instanceof Error ? error.message : String(error), details: error?.data || undefined });
  }
});

const onListen = () => {
  const address = server.address();
  const bound = typeof address === 'object' && address ? `${address.address}:${address.port}` : String(address || httpPort);
  console.log(`命定之诗 Web 前端已启动： http://localhost:${httpPort}`);
  console.log(`监听地址：${bound}（默认同时兼容 localhost 的 IPv4/IPv6 解析）`);
  console.log(`前端目录：${frontendRoot}`);
  console.log(`游戏目录：${gameRoot}`);
  console.log(`健康检查： http://localhost:${httpPort}/api/health`);
  console.log(`默认存档：${latest?.basename || '新会话'}`);
};
if (httpHost) server.listen(httpPort, httpHost, onListen);
else server.listen(httpPort, onListen);

async function shutdown() {
  console.log('\n正在关闭 Web 前端...');
  server.close();
  await rpc.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
