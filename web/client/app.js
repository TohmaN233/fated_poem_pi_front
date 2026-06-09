import { trustedRender } from './renderer.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const EQUIPMENT_SLOTS = ['主手', '副手', '头部', '身体', '手部', '腿部', '足部', '饰品1', '饰品2', '饰品3'];
const BASIC_ACTIONS = ['普通攻击', '防御', '闪避'];

const state = {
  messages: [],
  messageNodes: new Map(),
  currentAssistant: null,
  streamingText: '',
  characters: [],
  gameState: null,
  tools: [],
  avatarMap: {},
  models: [],
  currentModel: null,
  thinkingLevel: 'off',
  backendLogs: [],
  selectedChar: null,
  selectedTab: 'basic',
  detailsTab: 'player',
  selectedSkills: {},
  selectedBasicActions: {},
  crop: {
    char: null,
    sourceName: '',
    naturalW: 0,
    naturalH: 0,
    baseScale: 1,
    zoom: 1,
    x: 0,
    y: 0,
    dragging: false,
    lastX: 0,
    lastY: 0,
    dataUrl: '',
  },
};

function toast(message, type = '') {
  const host = $('#toastHost');
  const node = el('div', `toast ${type}`, message);
  host.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || response.statusText);
  return data;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n');
  return '';
}

function messageText(message) {
  if (!message) return '';
  if (message.role === 'assistant') return contentText(message.content);
  if (message.role === 'user') return contentText(message.content);
  if (message.role === 'custom' && message.display) return contentText(message.content);
  return '';
}

function appendMessage({ id = `local-${Date.now()}-${Math.random()}`, role, text, final = true }) {
  if (!text && role !== 'assistant') return null;
  const list = $('#messageList');
  let wrapper = state.messageNodes.get(id);
  if (!wrapper) {
    wrapper = el('article', `message ${role}`);
    wrapper.dataset.id = id;
    const meta = el('div', 'meta', role === 'user' ? '你' : role === 'assistant' ? 'GM' : '系统');
    const bubble = el('div', 'bubble');
    wrapper.append(meta, bubble);
    list.appendChild(wrapper);
    state.messageNodes.set(id, wrapper);
  }
  const bubble = wrapper.querySelector('.bubble');
  trustedRender(bubble, text, { final, messageId: id });
  list.scrollTop = list.scrollHeight;
  return wrapper;
}

function renderLoadedMessages(messages = []) {
  $('#messageList').innerHTML = '';
  state.messageNodes.clear();
  for (const [idx, message] of messages.entries()) {
    if (!['user', 'assistant', 'custom'].includes(message.role)) continue;
    if (message.role === 'custom' && !message.display) continue;
    const text = messageText(message);
    if (!text.trim()) continue;
    appendMessage({ id: `history-${idx}-${message.timestamp || ''}`, role: message.role === 'custom' ? 'system' : message.role, text, final: true });
  }
}

function fullAssistantText(message) {
  return contentText(message?.content || []);
}

function handlePiEvent(event) {
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent || {};
    if (update.type === 'text_start') {
      state.currentAssistant = event.message?.timestamp ? `assistant-${event.message.timestamp}` : `assistant-${Date.now()}`;
      state.streamingText = '';
      appendMessage({ id: state.currentAssistant, role: 'assistant', text: '', final: false });
    }
    if (update.type === 'text_delta') {
      if (!state.currentAssistant) state.currentAssistant = `assistant-${Date.now()}`;
      state.streamingText += update.delta || '';
      appendMessage({ id: state.currentAssistant, role: 'assistant', text: state.streamingText, final: false });
    }
    if (update.type === 'done' || update.type === 'error') {
      if (state.currentAssistant) appendMessage({ id: state.currentAssistant, role: 'assistant', text: fullAssistantText(event.message) || state.streamingText, final: true });
    }
  }

  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const id = state.currentAssistant || `assistant-${event.message.timestamp || Date.now()}`;
    appendMessage({ id, role: 'assistant', text: fullAssistantText(event.message) || state.streamingText, final: true });
    state.currentAssistant = null;
    state.streamingText = '';
  }

  if (event.type === 'tool_execution_start') setConnection(`工具：${event.toolName}`, 'ok');
  if (event.type === 'turn_end' || event.type === 'agent_end') refreshState().catch(() => {});
  if (event.type === 'extension_ui_request') handleExtensionUi(event);
}

function summarizePiEvent(event) {
  if (event.type === 'tool_execution_start') return `tool start: ${event.toolName}`;
  if (event.type === 'tool_execution_end') return `tool end: ${event.toolName} ${event.isError ? 'ERROR' : 'OK'}`;
  if (event.type === 'message_start' || event.type === 'message_end') return `${event.type}: ${event.message?.role || ''}`;
  if (event.type === 'extension_error') return `extension error: ${event.error || ''}`;
  return event.type;
}

function handleExtensionUi(event) {
  if (event.method === 'notify') toast(event.message || '通知', event.notifyType === 'error' ? 'error' : '');
  if (event.method === 'setStatus' && event.statusKey) setConnection(`${event.statusKey}: ${event.statusText || ''}`, 'ok');
}

function setConnection(text, cls = '') {
  const pill = $('#connectionPill');
  pill.textContent = text;
  pill.className = `connection-pill ${cls}`;
  const backendStatus = $('#backendStatus');
  if (backendStatus) backendStatus.textContent = text;
}

function addBackendLog(kind, payload) {
  const time = new Date().toLocaleTimeString();
  const text = typeof payload === 'string' ? payload.trimEnd() : JSON.stringify(payload);
  if (!text) return;
  state.backendLogs.push(`[${time}] ${kind} ${text}`);
  if (state.backendLogs.length > 500) state.backendLogs.splice(0, state.backendLogs.length - 500);
  renderBackendLog();
}

function renderBackendLog() {
  const log = $('#backendLog');
  if (!log) return;
  log.textContent = state.backendLogs.join('\n');
  log.scrollTop = log.scrollHeight;
}

function connectSse() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => {
    setConnection('SSE 监听中', 'ok');
    addBackendLog('SSE', 'browser connected to /api/events');
  });
  source.addEventListener('error', () => {
    setConnection('连接中断，自动重连…', 'bad');
    addBackendLog('SSE', 'connection lost; EventSource will retry');
  });
  source.addEventListener('pi', (e) => {
    const event = JSON.parse(e.data);
    if (['agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'message_end', 'tool_execution_start', 'tool_execution_end', 'extension_error'].includes(event.type)) {
      addBackendLog('RPC', summarizePiEvent(event));
    }
    handlePiEvent(event);
  });
  source.addEventListener('server', (e) => {
    const data = JSON.parse(e.data);
    addBackendLog('SERVER', data);
    if (data.type === 'connected') setConnection('Web 已连接 / 后端监听中', 'ok');
    if (data.type === 'pi_exit') setConnection('pi 已退出', 'bad');
    if (['state_changed', 'session_switched', 'session_new', 'avatar_changed'].includes(data.type)) refreshState().catch(() => {});
    if (['model_changed', 'thinking_changed'].includes(data.type)) loadModels().catch(() => {});
  });
  source.addEventListener('stderr', (e) => addBackendLog('STDERR', JSON.parse(e.data).text || ''));
}

async function loadMessages() {
  try {
    const data = await api('/api/messages');
    renderLoadedMessages(data.messages || []);
  } catch (error) {
    appendMessage({ role: 'system', text: `历史消息暂不可用：${error.message}` });
  }
}

function pct(current, max) {
  const c = Number(current || 0);
  const m = Number(max || 0);
  return m > 0 ? Math.max(0, Math.min(100, (c / m) * 100)) : 0;
}

function meter(label, current, max, type = '') {
  return `<div class="meter"><b><span>${label}</span><span>${Math.floor(Number(current || 0))}/${Math.floor(Number(max || 0))}</span></b><div class="bar ${type}"><span style="width:${pct(current, max)}%"></span></div></div>`;
}

function renderStatus(data) {
  const host = $('#statusContent');
  if (!host) return;
  const panel = data?.panel?.data || {};
  const snapshotState = data?.snapshot?.state || {};
  const pc = snapshotState.主角 || {};
  const attrs = panel.attrs || pc.属性 || {};
  host.classList.remove('loading');
  host.innerHTML = `
    <div class="pc-title"><b>${pc.姓名 || '主角'}</b><small>Lv.${panel.level ?? pc.等级 ?? '?'} · ${pc.生命层级 || ''}</small></div>
    ${meter('HP', panel.hp, panel.hpMax)}
    ${meter('MP', panel.mp, panel.mpMax, 'mp')}
    ${meter('SP', panel.sp, panel.spMax, 'sp')}
    <div class="meter"><b><span>XP</span><span>${panel.xp ?? 0}/${panel.xpNeed ?? 0}</span></b><div class="bar xp"><span style="width:${pct(panel.xp, panel.xpNeed)}%"></span></div></div>
    <div class="state-grid">
      <div class="state-tile">金钱<strong>${panel.money ?? pc.金钱 ?? 0}G</strong></div>
      <div class="state-tile">FP<strong>${panel.fp ?? snapshotState.命运点数 ?? 0}</strong></div>
      <div class="state-tile">属性点<strong>${panel.attrPoints ?? pc.属性点 ?? 0}</strong></div>
      <div class="state-tile">任务<strong>${panel.quests ?? 0}</strong></div>
      <div class="state-tile" style="grid-column:span 2">地点<strong>${panel.location || snapshotState.世界?.地点 || '未知'}</strong></div>
      <div class="state-tile" style="grid-column:span 2">时间<strong>${panel.time || snapshotState.世界?.时间 || '未知'}</strong></div>
    </div>
    <div class="attr-row">${['力量','敏捷','体质','智力','精神'].map((key) => `<span class="attr-chip">${key[0]} ${attrs[key] ?? '?'}</span>`).join('')}</div>
    <div class="panel-quick-actions">
      <button class="soft-btn" data-open-detail="player">主角</button>
      <button class="soft-btn" data-open-detail="bag">背包</button>
      <button class="soft-btn" data-open-detail="relations">关系</button>
      <button class="soft-btn" data-open-detail="quests">任务</button>
      <button class="soft-btn" data-open-detail="raw">全部</button>
    </div>
  `;
  host.querySelectorAll('[data-open-detail]').forEach((btn) => btn.onclick = () => openDetails(btn.dataset.openDetail).catch((e) => toast(e.message, 'error')));
}

function avatarFor(char) {
  return state.avatarMap?.[char.key]?.url || char.avatar || '';
}

function avatarPreviewFor(char) {
  const avatar = state.avatarMap?.[char.key];
  return avatar?.croppedUrl || avatar?.url || char.avatar || '';
}

async function loadAvatars() {
  const data = await api('/api/avatars');
  state.avatarMap = data.avatars || {};
}

function renderCharacters(characters) {
  const list = $('#characterList');
  if (!list) return;
  list.innerHTML = '';
  for (const char of characters) {
    const card = el('div', `char-card ${char.isProtagonist ? 'protagonist' : ''}`);
    const avatar = avatarFor(char);
    if (avatar) {
      const img = document.createElement('img');
      img.src = avatar;
      img.onerror = () => img.remove();
      card.appendChild(img);
    }
    card.appendChild(el('div', 'name', char.displayName || char.key));
    card.title = `${char.displayName || char.key} · Lv.${char.level ?? '?'}`;
    card.addEventListener('click', () => openCharacter(char.key));
    list.appendChild(card);
  }
}

async function refreshState() {
  const data = await api('/api/state');
  await loadAvatars().catch(() => {});
  state.gameState = data;
  state.characters = data.characters || [];
  renderStatus(data);
  renderCharacters(state.characters);
  if (state.selectedChar) {
    const fresh = state.characters.find((c) => c.key === state.selectedChar.key);
    if (fresh) {
      state.selectedChar = fresh;
      renderCharacterDialog();
    }
  }
  if ($('#detailsDialog')?.open) renderDetailsDialog();
}

function openCharacter(key) {
  state.selectedChar = state.characters.find((c) => c.key === key);
  state.selectedTab = 'basic';
  renderCharacterDialog();
  $('#characterDialog').showModal();
}

function setTab(tab) {
  state.selectedTab = tab;
  renderCharacterDialog();
}

function qualityColor(q = '') {
  return ({ 普通:'#6b6258', 优良:'#2f7a4a', 稀有:'#2e69b2', 史诗:'#6e4ab4', 传说:'#c49a32', 神话:'#b23d5a', 唯一:'#c8872b' })[q] || '#6b6258';
}

function itemQuality(item) { return item?.品质 || item?.quality || '普通'; }
function itemType(item) { return item?.类型 || item?.type || ''; }
function itemDesc(item) { return item?.物品简介 || item?.描述 || item?.desc || ''; }
function valueText(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(' / ');
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}:${valueText(v)}`).join(' / ');
  return String(value);
}
function firstValue(obj, keys = []) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}
function skillName(key, skill) { return skill?.名称 || skill?.name || key; }
function skillCost(skill = {}) {
  const direct = firstValue(skill, ['消耗', '资源消耗', 'cost', 'Cost']);
  if (direct) return valueText(direct);
  const parts = [
    ['HP', ['HP消耗', '生命消耗', '生命值消耗']],
    ['MP', ['MP消耗', '魔力消耗', '法力消耗', '魔法消耗']],
    ['SP', ['SP消耗', '体力消耗', '耐力消耗']],
    ['FP', ['FP消耗', '命运点消耗', '命运点数消耗']],
  ].map(([label, keys]) => {
    const value = firstValue(skill, keys);
    return value ? `${label} ${valueText(value)}` : '';
  }).filter(Boolean);
  return parts.join(' / ');
}
function skillMeta(skill = {}) {
  return [
    ['效果', firstValue(skill, ['效果', '技能效果', '作用', '效果描述']) || itemDesc(skill)],
    ['威力', firstValue(skill, ['威力', '伤害', '伤害倍率', '倍率', 'power', 'damage'])],
    ['消耗', skillCost(skill)],
    ['冷却', firstValue(skill, ['冷却', '冷却时间', 'CD', 'cooldown'])],
    ['目标', firstValue(skill, ['目标', 'target'])],
    ['范围', firstValue(skill, ['范围', '射程', 'range'])],
    ['类型', itemType(skill)],
  ].map(([label, value]) => [label, valueText(value)]).filter(([, value]) => value);
}
function selectedSkillSet(charKey) {
  return new Set(state.selectedSkills[charKey] || []);
}
function setSelectedSkill(charKey, key, checked) {
  const selected = selectedSkillSet(charKey);
  if (checked) selected.add(key); else selected.delete(key);
  state.selectedSkills[charKey] = [...selected];
}
function setBasicAction(charKey, action) {
  state.selectedBasicActions[charKey] = state.selectedBasicActions[charKey] === action ? '' : action;
}
function clearCharacterActions(charKey) {
  state.selectedBasicActions[charKey] = '';
  state.selectedSkills[charKey] = [];
}
function actionNamesForChar(char) {
  const skills = char?.data?.技能 || {};
  const basic = state.selectedBasicActions[char.key];
  const selectedSkillNames = (state.selectedSkills[char.key] || [])
    .filter((key) => Object.prototype.hasOwnProperty.call(skills, key))
    .map((key) => skillName(key, skills[key]));
  return [...(basic ? [basic] : []), ...selectedSkillNames];
}
function actionCountForChar(char) {
  return actionNamesForChar(char).length;
}
function commandForChar(char) {
  const names = actionNamesForChar(char);
  if (!names.length) return '';
  return `${char.displayName || char.key}使用${names.join('、')}；`;
}
function buildAllActionsText() {
  return state.characters.map(commandForChar).filter(Boolean).join('');
}
function setInputText(text) {
  const input = $('#promptInput');
  if (!input) return;
  input.value = text;
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}
function characterSwitcherHtml(currentKey) {
  return `<div class="character-switcher">
    ${state.characters.map((c) => {
      const avatar = avatarPreviewFor(c);
      const count = actionCountForChar(c);
      return `<button type="button" class="switch-char ${c.key === currentKey ? 'active' : ''}" data-switch-character="${escapeHtml(c.key)}">
        ${avatar ? `<img src="${avatar}" alt="">` : '<span class="switch-avatar-empty"></span>'}
        <span>${escapeHtml(c.displayName || c.key)}</span>
        ${count ? `<em>${count}</em>` : ''}
      </button>`;
    }).join('')}
  </div>`;
}
function actionFooterHtml() {
  const selected = state.characters.map((char) => ({ char, command: commandForChar(char) })).filter((row) => row.command);
  return `<div class="action-footer">
    <div class="action-summary">
      <b>已选行动</b>
      <span>${selected.length ? selected.map((row) => escapeHtml(row.command)).join(' ') : '还没有为任何角色选择行动。'}</span>
    </div>
    <div class="action-footer-buttons">
      <button type="button" class="soft-btn" data-clear-current-action>清空当前角色</button>
      <button type="button" class="soft-btn" data-clear-all-actions>清空全部</button>
      <button type="button" class="send-btn small-send" data-send-all-actions>发送全部到输入框</button>
    </div>
  </div>`;
}
function characterPanelShell(content) {
  return `${characterSwitcherHtml(state.selectedChar?.key)}<div class="character-tab-content">${content}</div>${actionFooterHtml()}`;
}
function bindCharacterPanelControls(body) {
  body.querySelectorAll('[data-switch-character]').forEach((btn) => {
    btn.onclick = () => {
      const next = state.characters.find((c) => c.key === btn.dataset.switchCharacter);
      if (!next) return;
      state.selectedChar = next;
      renderCharacterDialog();
    };
  });
  body.querySelectorAll('[data-basic-action]').forEach((btn) => {
    btn.onclick = () => {
      if (!state.selectedChar) return;
      setBasicAction(state.selectedChar.key, btn.dataset.basicAction);
      renderCharacterDialog();
    };
  });
  body.querySelector('[data-clear-current-action]')?.addEventListener('click', () => {
    if (!state.selectedChar) return;
    clearCharacterActions(state.selectedChar.key);
    renderCharacterDialog();
  });
  body.querySelector('[data-clear-all-actions]')?.addEventListener('click', () => {
    state.selectedBasicActions = {};
    state.selectedSkills = {};
    renderCharacterDialog();
  });
  body.querySelector('[data-send-all-actions]')?.addEventListener('click', () => {
    const text = buildAllActionsText();
    if (!text) return toast('请先为至少一个角色选择行动', 'error');
    setInputText(text);
    $('#characterDialog')?.close();
  });
}
function defaultEquipSlot(item) {
  const raw = `${item?.slot || ''} ${item?.位置 || ''} ${itemType(item)}`;
  for (const slot of EQUIPMENT_SLOTS) if (raw.includes(slot)) return slot;
  if (/副手|盾/.test(raw)) return '副手';
  if (/头|帽|盔/.test(raw)) return '头部';
  if (/身体|胸|甲|袍|衣/.test(raw)) return '身体';
  if (/手套|护手/.test(raw)) return '手部';
  if (/腿|裤/.test(raw)) return '腿部';
  if (/足|靴|鞋/.test(raw)) return '足部';
  if (/饰品|戒|项链|护符/.test(raw)) return '饰品1';
  return '主手';
}
function slotOptions(selected) {
  return EQUIPMENT_SLOTS.map((slot) => `<option value="${slot}" ${slot === selected ? 'selected' : ''}>${slot}</option>`).join('');
}

async function uploadAvatarFromFile(char, file) {
  if (!file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取本地图片失败'));
    reader.readAsDataURL(file);
  });
  openAvatarCrop(char, dataUrl, file.name);
}

async function uploadAvatarFromUrl(char, url) {
  const value = String(url || '').trim();
  if (!value) return;
  const fetched = await api('/api/avatar/fetch-url', {
    method: 'POST',
    body: JSON.stringify({ url: value }),
  });
  openAvatarCrop(char, fetched.dataUrl, fetched.sourceName || 'avatar');
}

function cropElements() {
  return {
    dialog: $('#avatarCropDialog'),
    viewport: $('#cropViewport'),
    image: $('#cropImage'),
    zoom: $('#cropZoom'),
  };
}

function clampCrop() {
  const { viewport } = cropElements();
  const crop = state.crop;
  if (!viewport || !crop.naturalW || !crop.naturalH) return;
  const rect = viewport.getBoundingClientRect();
  const scale = crop.baseScale * crop.zoom;
  const displayW = crop.naturalW * scale;
  const displayH = crop.naturalH * scale;
  const maxX = Math.max(0, (displayW - rect.width) / 2);
  const maxY = Math.max(0, (displayH - rect.height) / 2);
  crop.x = Math.max(-maxX, Math.min(maxX, crop.x));
  crop.y = Math.max(-maxY, Math.min(maxY, crop.y));
}

function updateCropView() {
  const { image, zoom } = cropElements();
  const crop = state.crop;
  if (!image) return;
  clampCrop();
  image.style.width = `${crop.naturalW}px`;
  image.style.height = `${crop.naturalH}px`;
  image.style.transform = `translate(-50%, -50%) translate(${crop.x}px, ${crop.y}px) scale(${crop.baseScale * crop.zoom})`;
  if (zoom) zoom.value = String(crop.zoom);
}

function openAvatarCrop(char, dataUrl, sourceName = 'avatar.png') {
  const { dialog, image, zoom } = cropElements();
  if (!dialog || !image) {
    toast('裁剪器未加载', 'error');
    return;
  }
  state.crop.char = char;
  state.crop.sourceName = sourceName;
  state.crop.dataUrl = dataUrl;
  state.crop.x = 0;
  state.crop.y = 0;
  state.crop.zoom = 1;
  if (zoom) zoom.value = '1';
  image.onload = () => {
    const { viewport } = cropElements();
    const rect = viewport.getBoundingClientRect();
    state.crop.naturalW = image.naturalWidth || 1;
    state.crop.naturalH = image.naturalHeight || 1;
    state.crop.baseScale = Math.max(rect.width / state.crop.naturalW, rect.height / state.crop.naturalH);
    updateCropView();
  };
  image.src = dataUrl;
  dialog.showModal();
}

async function saveCroppedAvatar() {
  const { viewport, image, dialog } = cropElements();
  const crop = state.crop;
  if (!viewport || !image || !crop.char) return;
  const rect = viewport.getBoundingClientRect();
  const scale = crop.baseScale * crop.zoom;
  const displayW = crop.naturalW * scale;
  const displayH = crop.naturalH * scale;
  const left = rect.width / 2 + crop.x - displayW / 2;
  const top = rect.height / 2 + crop.y - displayH / 2;
  const sx = Math.max(0, (0 - left) / scale);
  const sy = Math.max(0, (0 - top) / scale);
  const sw = Math.min(crop.naturalW - sx, rect.width / scale);
  const sh = Math.min(crop.naturalH - sy, rect.height / scale);
  const canvas = document.createElement('canvas');
  canvas.width = 370;
  canvas.height = 484;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/png');
  const result = await api('/api/avatar', {
    method: 'POST',
    body: JSON.stringify({ characterKey: crop.char.key, originalDataUrl: crop.dataUrl, dataUrl, sourceName: crop.sourceName || 'avatar.png' }),
  });
  state.avatarMap[crop.char.key] = result.avatar;
  dialog?.close();
  toast('头像已裁剪并保存到本地', 'ok');
  renderCharacters(state.characters);
  renderCharacterDialog();
}

function panelProfileForChar(char) {
  const data = char?.data || {};
  const dossier = data.档案 && typeof data.档案 === 'object' ? data.档案 : {};
  return { ...dossier, ...data };
}

function characterPanelMeta(profile = {}) {
  const panel = profile.面板 && typeof profile.面板 === 'object' ? profile.面板 : {};
  return {
    importance: panel.重要度 || profile.重要度 || '普通互动',
    source: panel.来源 || profile.来源 || '当前存档',
  };
}

function textList(value) {
  if (Array.isArray(value)) return value.map(textList).filter(Boolean).join(' / ');
  if (value && typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}:${textList(v)}`).join(' / ');
  return String(value || '').trim();
}

function overviewImportanceClass(importance = '') {
  if (importance === '路人') return 'minor';
  if (importance === '命定角色') return 'fated';
  if (importance === '敌对核心') return 'hostile';
  if (importance === '重要NPC') return 'important';
  return 'standard';
}

function attrBarsHtml(attrs = {}) {
  const baseKeys = ['力量', '敏捷', '体质', '智力', '精神', '感知', '意志', '魅力'];
  const keys = [
    ...baseKeys.filter((key) => attrs?.[key] !== undefined),
    ...Object.keys(attrs || {}).filter((key) => !baseKeys.includes(key) && Number(attrs?.[key]) > 0),
  ];
  const entries = keys
    .map((key) => [key, Number(attrs?.[key] || 0)])
    .filter(([, value]) => value > 0);
  if (!entries.length) return '<div class="policy-note">暂无可展示属性。</div>';
  return `<div class="overview-attrs">${entries.map(([key, value]) => `<div class="overview-attr"><span>${key}</span><b>${value}</b><i style="width:${Math.max(8, Math.min(100, (value / 20) * 100))}%"></i></div>`).join('')}</div>`;
}

function bindAvatarControls(body, char) {
  const fileInput = body.querySelector('[data-avatar-file]');
  const urlInput = body.querySelector('[data-avatar-url]');
  const urlBtn = body.querySelector('[data-avatar-url-btn]');
  const fileBtn = body.querySelector('[data-avatar-file-btn]');
  if (fileBtn && fileInput) fileBtn.onclick = () => fileInput.click();
  if (fileInput) fileInput.onchange = async () => {
    try { await uploadAvatarFromFile(char, fileInput.files?.[0]); }
    catch (error) { toast(error.message, 'error'); }
    finally { fileInput.value = ''; }
  };
  if (urlBtn) urlBtn.onclick = async () => {
    try { await uploadAvatarFromUrl(char, urlInput?.value); }
    catch (error) { toast(error.message, 'error'); }
  };
}

function renderCharacterDialog() {
  const char = state.selectedChar;
  if (!char) return;
  $('#characterTitle').textContent = `角色行动面板 · ${char.displayName || char.key}`;
  $('#characterTabs').querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.selectedTab);
    btn.onclick = () => setTab(btn.dataset.tab);
  });
  const body = $('#characterBody');
  const data = char.data || {};
  if (state.selectedTab === 'basic') {
    const avatar = avatarPreviewFor(char);
    const profile = panelProfileForChar(char);
    const meta = characterPanelMeta(profile);
    const importanceClass = overviewImportanceClass(meta.importance);
    const identity = textList(firstValue(profile, ['身份', '身分']));
    const job = textList(firstValue(profile, ['职业', '職業']));
    const appearance = textList(firstValue(profile, ['外貌特质', '外貌特征', '外貌']));
    const outfit = textList(firstValue(profile, ['衣物装饰', '衣着', '服装', '穿着']));
    const personality = textList(firstValue(profile, ['性格', '性格钩子']));
    const likes = textList(firstValue(profile, ['喜爱', '喜好']));
    const background = textList(firstValue(profile, ['背景故事', '背景', '背景钩子']));
    body.innerHTML = characterPanelShell(`
      <div class="character-overview ${importanceClass}">
        <div class="overview-portrait">${avatar ? `<img src="${avatar}" alt="${char.displayName || char.key}">` : `<span>${escapeHtml(String(char.displayName || char.key).slice(0, 2))}</span>`}</div>
        <div class="overview-main">
          <div class="overview-kicker">${escapeHtml(meta.importance)} · ${escapeHtml(meta.source)}${char.present ? ' · 在场' : ''}</div>
          <h2>${escapeHtml(profile.姓名 || char.displayName || char.key)}</h2>
          <p>${escapeHtml([identity, job, profile.种族, profile.生命层级].filter(Boolean).join(' · ') || '角色资料')}</p>
          <div class="char-info-tags overview-tags">
            ${[profile.种族, profile.等级 !== undefined ? `Lv.${profile.等级}` : '', profile.生命层级, identity, job, profile.好感度 !== undefined ? `好感 ${profile.好感度}` : ''].filter(Boolean).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}
          </div>
        </div>
      </div>
      <div class="overview-sections">
        <section><b>性格</b><span>${personality ? escapeHtml(personality) : '<i class="empty-value">—</i>'}</span></section>
        <section><b>喜爱</b><span>${likes ? escapeHtml(likes) : '<i class="empty-value">—</i>'}</span></section>
        <section><b>外貌</b><span>${appearance ? escapeHtml(appearance) : '<i class="empty-value">—</i>'}</span></section>
        <section><b>衣物</b><span>${outfit ? escapeHtml(outfit) : '<i class="empty-value">—</i>'}</span></section>
        <section class="wide"><b>背景钩子</b><span>${background ? escapeHtml(background) : '<i class="empty-value">—</i>'}</span></section>
      </div>
      ${attrBarsHtml(profile.属性 || data.属性)}
      <div class="policy-note">装备、背包转移允许前端直操；属性/经验/等级等受保护字段只能查看，修改需 GM/专用工具叙事支持。</div>
      <details class="avatar-importer collapsed-importer">
        <summary>头像导入 / 裁剪</summary>
        <div class="avatar-importer-inner">
          <div class="avatar-preview">${avatar ? `<img src="${avatar}" alt="${char.displayName || char.key}">` : '<span>无头像</span>'}</div>
          <div class="avatar-tools">
            <b>头像导入</b>
            <small>本地文件或图片网址会复制/下载到 user/images/dest-poet-web/avatars/，不会只引用外链。</small>
            <input data-avatar-file class="hidden-file-input" type="file" accept="image/*" />
            <button class="soft-btn avatar-file-btn" data-avatar-file-btn>选择本地图片</button>
            <div class="url-row"><input data-avatar-url placeholder="https://.../avatar.png" /><button class="soft-btn" data-avatar-url-btn>从网址导入</button></div>
          </div>
        </div>
      </details>`);
    bindAvatarControls(body, char);
  }
  if (state.selectedTab === 'equip') {
    const equipment = data.装备 || {};
    const rows = Object.entries(equipment).map(([slot, item]) => {
      const filled = item && typeof item === 'object' && Object.keys(item).length;
      return `<div class="equip-row"><div><b>${slot}</b><br><small>${filled ? item.名称 || item.name || '装备' : '空'}</small></div><div class="inline-actions">${filled ? `<button class="soft-btn" data-action="unequip" data-slot="${slot}">卸下</button>` : ''}</div></div>`;
    }).join('') || '<div class="policy-note">暂无装备栏。</div>';
    body.innerHTML = characterPanelShell(rows);
    body.querySelectorAll('[data-action="unequip"]').forEach((btn) => btn.onclick = () => runAction({ type: 'unequip', owner: char.key, slot: btn.dataset.slot }));
  }
  if (state.selectedTab === 'skills') {
    const skills = data.技能 || {};
    const entries = Object.entries(skills);
    const selected = selectedSkillSet(char.key);
    const basic = state.selectedBasicActions[char.key] || '';
    state.selectedSkills[char.key] = [...selected].filter((key) => Object.prototype.hasOwnProperty.call(skills, key));
    const actionButtons = `<div class="basic-action-row">
      ${BASIC_ACTIONS.map((action) => `<button type="button" class="basic-action ${basic === action ? 'active' : ''}" data-basic-action="${action}">${action}</button>`).join('')}
    </div>`;
    const skillList = entries.length ? `<div class="skill-list">
      ${entries.map(([name, skill], idx) => {
        const title = skillName(name, skill);
        const meta = skillMeta(skill);
        const desc = itemDesc(skill);
        return `<label class="skill-card ${selected.has(name) ? 'checked' : ''}">
          <input type="checkbox" data-skill-index="${idx}" ${selected.has(name) ? 'checked' : ''} />
          <div class="skill-main">
            <div class="skill-title"><b style="color:${qualityColor(itemQuality(skill))}">${escapeHtml(title)}</b><small>${escapeHtml(itemQuality(skill))}</small></div>
            <div class="skill-meta">${meta.map(([label, value]) => `<span><i>${escapeHtml(label)}</i>${escapeHtml(value)}</span>`).join('') || '<span><i>信息</i>暂无效果/威力/消耗记录</span>'}</div>
            ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
          </div>
        </label>`;
      }).join('')}
    </div>` : '<div class="policy-note">暂无技能；仍可选择普通攻击、防御、闪避。</div>';
    body.innerHTML = characterPanelShell(`
      <div class="policy-note">在上方切换角色，为每个角色选择普通动作或技能；全部选完后点底部“发送全部到输入框”。</div>
      ${actionButtons}
      ${skillList}
    `);
    body.querySelectorAll('[data-skill-index]').forEach((input) => {
      input.onchange = () => {
        const [name] = entries[Number(input.dataset.skillIndex)] || [];
        if (!name) return;
        setSelectedSkill(char.key, name, input.checked);
        input.closest('.skill-card')?.classList.toggle('checked', input.checked);
        renderCharacterDialog();
      };
    });
  }
  if (state.selectedTab === 'bag') {
    const bag = data.背包 || {};
    const targets = state.characters.filter((c) => c.key !== char.key).map((c) => `<option value="${c.key}">${c.displayName || c.key}</option>`).join('');
    const bagRows = Object.entries(bag).map(([key, item]) => `
      <div class="item-row">
        <div><b style="color:${qualityColor(itemQuality(item))}">${item.名称 || item.name || key}</b><br><small>${key} · ${itemType(item)} · 数量 ${item.数量 ?? item.qty ?? 1}</small><p>${itemDesc(item)}</p></div>
        <div class="inline-actions">
          <span class="mini-label">装备到</span>
          <select data-equip-slot="${key}">${slotOptions(defaultEquipSlot(item))}</select>
          <button class="soft-btn" data-action="equip" data-key="${key}">装备</button>
          <select data-transfer-target="${key}">${targets}</select>
          <input data-transfer-qty="${key}" type="number" value="1" min="1" />
          <button class="soft-btn" data-action="transfer" data-key="${key}">转移</button>
        </div>
      </div>`).join('') || '<div class="policy-note">背包为空。</div>';
    body.innerHTML = characterPanelShell(bagRows);
    body.querySelectorAll('[data-action="equip"]').forEach((btn) => btn.onclick = () => {
      const key = btn.dataset.key;
      const slot = body.querySelector(`[data-equip-slot="${CSS.escape(key)}"]`)?.value || '主手';
      runAction({ type: 'equip', owner: char.key, itemKey: key, slot });
    });
    body.querySelectorAll('[data-action="transfer"]').forEach((btn) => btn.onclick = () => {
      const key = btn.dataset.key;
      const target = body.querySelector(`[data-transfer-target="${CSS.escape(key)}"]`)?.value;
      const qty = body.querySelector(`[data-transfer-qty="${CSS.escape(key)}"]`)?.value || 1;
      runAction({ type: 'transferItem', fromOwner: char.key, toOwner: target, itemKey: key, quantity: Number(qty) });
    });
  }
  bindCharacterPanelControls(body);
}

function getFullState() {
  return state.gameState?.snapshot?.state || {};
}

function jsonBlock(value) {
  return `<pre class="detail-json">${escapeHtml(JSON.stringify(value ?? {}, null, 2))}</pre>`;
}

function scalar(value) {
  if (value === null || value === undefined || value === '') return '<span class="empty-value">—</span>';
  if (Array.isArray(value)) {
    if (value.every((v) => !v || typeof v !== 'object')) return `<div class="chip-list">${value.map((v) => `<span class="attr-chip">${escapeHtml(String(v))}</span>`).join('')}</div>`;
    return `<div class="pretty-array">${value.map((v, i) => `<details class="pretty-nested"><summary>#${i + 1}</summary>${prettyObject(v, { compact: true })}</details>`).join('')}</div>`;
  }
  if (typeof value === 'object') return prettyObject(value, { compact: true });
  return `<span>${escapeHtml(String(value))}</span>`;
}

function prettyObject(obj = {}, { compact = false } = {}) {
  if (!obj || typeof obj !== 'object') return scalar(obj);
  const entries = Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!entries.length) return '<div class="policy-note">暂无内容。</div>';
  const simple = [];
  const complex = [];
  for (const [key, value] of entries) {
    if (Array.isArray(value) || typeof value !== 'object') simple.push([key, value]);
    else complex.push([key, value]);
  }
  const simpleHtml = simple.length ? `<div class="pretty-grid ${compact ? 'compact' : ''}">${simple.map(([key, value]) => `<div class="pretty-field"><span>${escapeHtml(key)}</span><b>${scalar(value)}</b></div>`).join('')}</div>` : '';
  const complexHtml = complex.map(([key, value]) => `<details class="pretty-nested"><summary>${escapeHtml(key)}</summary>${Array.isArray(value) ? scalar(value) : prettyObject(value, { compact: true })}</details>`).join('');
  return `${simpleHtml}${complexHtml}`;
}

function objectRows(obj = {}, { kind = 'item' } = {}) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return '<div class="policy-note">暂无内容。</div>';
  return entries.map(([key, value]) => {
    const title = value && typeof value === 'object' ? (value.名称 || value.姓名 || value.标题 || value.name || key) : key;
    const subtitle = value && typeof value === 'object'
      ? [value.品质, value.类型, value.生命层级, value.状态, value.进展].filter(Boolean).join(' · ')
      : String(value ?? '');
    const rowClass = kind === 'relation' ? 'relation-row' : kind === 'quest' ? 'quest-row' : 'item-row';
    return `<details><summary>${escapeHtml(title)}</summary><div class="${rowClass}"><div><small>${escapeHtml(key)}${subtitle ? ` · ${escapeHtml(subtitle)}` : ''}</small></div></div>${prettyObject(value)}</details>`;
  }).join('');
}

function relationRows(relations = {}) {
  const entries = Object.entries(relations || {});
  if (!entries.length) return '<div class="policy-note">暂无关系。</div>';
  return `<div class="relation-list">
    ${entries.map(([key, value], idx) => {
      const rel = value && typeof value === 'object' ? value : {};
      const present = rel.在场 === true;
      const name = rel.姓名 || key;
      const subtitle = [rel.生命层级, rel.等级 !== undefined ? `Lv.${rel.等级}` : '', rel.好感度 !== undefined ? `好感 ${rel.好感度}` : ''].filter(Boolean).join(' · ');
      const avatar = state.avatarMap?.[key]?.croppedUrl || state.avatarMap?.[key]?.url || rel.头像 || rel.avatar || rel.image || rel.立绘 || '';
      return `<details class="relation-card ${present ? 'present' : 'absent'}">
        <summary>
          <span class="relation-head">
            ${avatar ? `<img src="${avatar}" alt="">` : '<i class="relation-avatar-empty"></i>'}
            <span><b>${escapeHtml(name)}</b><small>${escapeHtml(key)}${subtitle ? ` · ${escapeHtml(subtitle)}` : ''}</small></span>
          </span>
          <button type="button" class="presence-toggle ${present ? 'on' : ''}" data-presence-index="${idx}" data-present="${present ? 'false' : 'true'}">${present ? '在场' : '离场'}</button>
        </summary>
        ${prettyObject(rel)}
      </details>`;
    }).join('')}
  </div>`;
}

function bindRelationControls(body, relations = {}) {
  const entries = Object.entries(relations || {});
  body.querySelectorAll('[data-presence-index]').forEach((btn) => {
    btn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const [key] = entries[Number(btn.dataset.presenceIndex)] || [];
      if (!key) return;
      runAction({ type: 'setPresence', characterKey: key, present: btn.dataset.present === 'true' });
    };
  });
}

function renderDetailsDialog() {
  const full = getFullState();
  const body = $('#detailsBody');
  const tabs = $('#detailsTabs');
  if (!body || !tabs) return;
  tabs.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.detailTab === state.detailsTab);
    btn.onclick = () => { state.detailsTab = btn.dataset.detailTab; renderDetailsDialog(); };
  });
  const pc = full.主角 || {};
  if (state.detailsTab === 'player') {
    body.innerHTML = `
      <div class="detail-section-title">主角完整资料</div>
      <div class="state-grid">
        <div class="state-tile">等级<strong>${pc.等级 ?? '?'}</strong></div>
        <div class="state-tile">经验<strong>${pc.累计经验值 ?? 0}/${pc.升级所需经验 ?? '?'}</strong></div>
        <div class="state-tile">金钱<strong>${pc.金钱 ?? 0}G</strong></div>
        <div class="state-tile">FP<strong>${full.命运点数 ?? 0}</strong></div>
      </div>
      ${prettyObject(pc)}`;
  } else if (state.detailsTab === 'bag') {
    body.innerHTML = `<div class="detail-section-title">主角背包</div>${objectRows(pc.背包, { kind: 'item' })}`;
  } else if (state.detailsTab === 'equipment') {
    body.innerHTML = `<div class="detail-section-title">主角装备</div>${objectRows(pc.装备, { kind: 'item' })}`;
  } else if (state.detailsTab === 'skills') {
    body.innerHTML = `<div class="detail-section-title">主角技能</div>${objectRows(pc.技能, { kind: 'item' })}`;
  } else if (state.detailsTab === 'relations') {
    body.innerHTML = `<div class="detail-section-title">关系列表 / NPC</div><div class="policy-note">可手动切换“在场/离场”。在场角色会出现在左侧角色栏与角色行动面板中；离场角色保留资料但不参与当前场景选择。</div>${relationRows(full.关系列表)}`;
    bindRelationControls(body, full.关系列表);
  } else if (state.detailsTab === 'quests') {
    body.innerHTML = `<div class="detail-section-title">任务列表</div>${objectRows(full.任务列表, { kind: 'quest' })}`;
  } else if (state.detailsTab === 'world') {
    body.innerHTML = `<div class="detail-section-title">世界</div>${prettyObject(full.世界)}<div class="detail-section-title">新闻</div>${prettyObject(full.新闻 || {})}<div class="detail-section-title">DLC</div>${prettyObject(full.DLC || {})}`;
  } else {
    body.innerHTML = jsonBlock(full);
  }
}

async function openDetails(tab = state.detailsTab || 'player') {
  state.detailsTab = tab;
  if (!state.gameState) await refreshState();
  renderDetailsDialog();
  $('#detailsDialog')?.showModal();
}

async function runAction(payload) {
  try {
    const result = await api('/api/action', { method: 'POST', body: JSON.stringify(payload) });
    toast(`操作成功：${result.action || payload.type}`, 'ok');
    await refreshState();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadSessions() {
  const data = await api('/api/sessions');
  const host = $('#sessionList');
  host.innerHTML = (data.sessions || []).map((s) => `
    <div class="session-card">
      <div><b>${s.name || s.basename}</b><small>${s.preview || '无预览'}<br>${new Date(s.modifiedAt).toLocaleString()} · ${s.messageCount} messages</small></div>
      <button class="soft-btn" data-session="${s.file}">读取</button>
    </div>`).join('') || '<div class="policy-note">暂无存档。可点击新游戏开始。</div>';
  host.querySelectorAll('[data-session]').forEach((btn) => btn.onclick = async () => {
    try {
      await api('/api/session/switch', { method: 'POST', body: JSON.stringify({ file: btn.dataset.session }) });
      $('#sessionDialog').close();
      await loadMessages();
      await refreshState();
      toast('已切换存档', 'ok');
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function loadTools() {
  const data = await api('/api/tools');
  state.tools = data.tools || [];
  renderTools();
}

function renderTools() {
  const q = $('#toolSearch').value.trim().toLowerCase();
  const host = $('#toolList');
  const tools = state.tools.filter((t) => !q || `${t.name} ${t.label} ${t.description} ${t.group}`.toLowerCase().includes(q));
  const groups = new Map();
  for (const tool of tools) {
    if (!groups.has(tool.group)) groups.set(tool.group, []);
    groups.get(tool.group).push(tool);
  }
  host.innerHTML = '';
  for (const [group, rows] of groups) {
    host.appendChild(el('div', 'tool-group', group));
    for (const tool of rows) {
      const card = el('div', 'tool-card');
      card.innerHTML = `<div><b>${tool.name}</b> ${tool.active ? '' : '<small>（未激活）</small>'}<br><small>${tool.description || tool.promptSnippet || ''}</small><pre>${tool.template}</pre></div><div class="tool-actions"><button class="soft-btn" data-insert>插入</button>${tool.directSafe ? '<button class="soft-btn" data-direct>执行</button>' : '<button class="soft-btn" data-gm>交给GM</button>'}</div>`;
      card.querySelector('[data-insert]').onclick = () => insertText(tool.template);
      card.querySelector('[data-direct]')?.addEventListener('click', () => directTool(tool));
      card.querySelector('[data-gm]')?.addEventListener('click', () => insertText(`请根据当前剧情调用函数：${tool.template}`));
      host.appendChild(card);
    }
  }
}

function insertText(text) {
  const input = $('#promptInput');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
  input.focus();
  input.selectionStart = input.selectionEnd = start + text.length;
}

async function directTool(tool, argsOverride = null) {
  try {
    const args = argsOverride || (tool.name === 'get_status' ? { section: '主角' } : {});
    const data = await api('/api/safe-tool', { method: 'POST', body: JSON.stringify({ name: tool.name, args }) });
    if (tool.name === 'render_character_panel' && data.data?.charInfo) {
      appendMessage({ role: 'system', text: data.data.charInfo });
    } else {
      appendMessage({ role: 'system', text: `<details open><summary>${tool.name} 结果</summary><pre>${escapeHtml(JSON.stringify(data.data, null, 2))}</pre></details>` });
    }
    $('#functionDialog').close();
  } catch (error) { toast(error.message, 'error'); }
}

async function loadModels() {
  const data = await api('/api/models');
  state.models = data.models || [];
  state.currentModel = data.state?.model || null;
  state.thinkingLevel = data.state?.thinkingLevel || 'off';
  renderModels();
}

function renderModels() {
  const current = state.currentModel;
  const currentText = $('#currentModelText');
  const thinkingSelect = $('#thinkingSelect');
  const search = $('#modelSearch');
  const host = $('#modelList');
  if (!host) return;
  if (currentText) currentText.textContent = current ? `当前：${current.provider}/${current.id || current.modelId || current.name}` : '当前：未设置';
  if (thinkingSelect) thinkingSelect.value = state.thinkingLevel || 'off';
  const q = (search?.value || '').trim().toLowerCase();
  const models = state.models.filter((m) => !q || `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q));
  host.innerHTML = models.map((m, index) => `
    <div class="model-card">
      <div><b>${m.name || m.id}</b><br><small>${m.provider}/${m.id} · ctx ${m.contextWindow || '?'} · max ${m.maxTokens || '?'}</small></div>
      <button class="soft-btn" data-model-index="${index}">切换</button>
    </div>`).join('') || '<div class="policy-note">没有可用模型。请检查 .pi/agent/auth.json / models.json。</div>';
  host.querySelectorAll('[data-model-index]').forEach((btn) => {
    btn.onclick = async () => {
      const model = models[Number(btn.dataset.modelIndex)];
      await setModel(model.provider, model.id);
    };
  });
}

async function setModel(provider, modelId) {
  await api('/api/model', { method: 'POST', body: JSON.stringify({ provider, modelId }) });
  toast(`已切换模型：${provider}/${modelId}`, 'ok');
  await loadModels();
}

async function setThinking(level) {
  await api('/api/thinking', { method: 'POST', body: JSON.stringify({ level }) });
  state.thinkingLevel = level;
  toast(`Thinking: ${level}`, 'ok');
}

function parseArgs(argText = '') {
  const args = {};
  const re = /([\w\u4e00-\u9fa5]+)\??\s*=\s*("[^"]*"|'[^']*'|[^,\s)]+)/g;
  let match;
  while ((match = re.exec(argText))) {
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    else if (value === 'true' || value === 'false') value = value === 'true';
    args[match[1]] = value;
  }
  return args;
}

async function handleDirectInput(message) {
  const fn = message.match(/^([a-zA-Z_][\w]*)\s*\((.*)\)\s*$/s);
  if (fn) {
    if (!state.tools.length) await loadTools();
    const name = fn[1];
    const args = parseArgs(fn[2]);
    const tool = state.tools.find((t) => t.name === name);
    if (tool?.directSafe && !(name === 'render_character_panel' && args.persist === true)) {
      await directTool(tool, args);
      return true;
    }
    insertText('');
    appendMessage({ role: 'system', text: `函数 ${name}${tool?.directSafe ? ' 的写入模式' : ''}不能前端直执，已交给 GM/工具链。` });
    await api('/api/prompt', { method: 'POST', body: JSON.stringify({ message: `请根据当前剧情调用函数：${message}` }) });
    return true;
  }

  if (!message.startsWith('/')) return false;
  const [cmd, ...rest] = message.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  if (cmd === 'status') {
    await directTool({ name: 'get_status', directSafe: true }, { section: arg || '主角' });
    return true;
  }
  if (cmd === 'panel') {
    await openDetails('player');
    return true;
  }
  if (cmd === 'raw') {
    await openDetails('raw');
    return true;
  }
  if (cmd === 'models' || cmd === 'model') {
    if (!arg) {
      await loadModels();
      $('#modelDialog').showModal();
      return true;
    }
    const [provider, modelId] = arg.includes('/') ? arg.split('/', 2) : ['', arg];
    if (!provider) throw new Error('用法：/model provider/modelId');
    await setModel(provider, modelId);
    return true;
  }
  if (cmd === 'cycle-model') {
    await api('/api/model/cycle', { method: 'POST', body: '{}' });
    await loadModels();
    toast('已切换到下一个模型', 'ok');
    return true;
  }
  if (cmd === 'thinking') {
    await setThinking(arg || 'off');
    return true;
  }
  if (cmd === 'tools') {
    await loadTools();
    $('#functionDialog')?.showModal();
    return true;
  }
  if (cmd === 'backend') {
    renderBackendLog();
    $('#backendDialog')?.showModal();
    return true;
  }
  return false; // Other slash commands are sent to pi RPC, e.g. extension commands.
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendPrompt(text) {
  const message = text.trim();
  if (!message) return;
  $('#promptInput').value = '';
  try {
    const handled = await handleDirectInput(message);
    if (handled) return;
    appendMessage({ role: 'user', text: message });
    await api('/api/prompt', { method: 'POST', body: JSON.stringify({ message }) });
  } catch (error) {
    toast(error.message, 'error');
  }
}

function applySavedLayoutSizes() {
  const root = document.documentElement;
  const charWidth = localStorage.getItem('destPoet.charRailWidth');
  const statusWidth = localStorage.getItem('destPoet.statusPanelWidth');
  if (charWidth) root.style.setProperty('--char-rail-width', `${charWidth}px`);
  if (statusWidth) root.style.setProperty('--status-panel-width', `${statusWidth}px`);
}

function bindPaneResizer(handle, { cssVar, storageKey, initial, min, max, invert = false }) {
  if (!handle) return;
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const root = document.documentElement;
    const startX = event.clientX;
    const current = parseInt(getComputedStyle(root).getPropertyValue(cssVar), 10) || Number(localStorage.getItem(storageKey)) || initial;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const next = Math.max(min, Math.min(max, current + (invert ? -dx : dx)));
      root.style.setProperty(cssVar, `${next}px`);
      localStorage.setItem(storageKey, String(next));
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function bindCropUi() {
  const { viewport, zoom } = cropElements();
  if (!viewport) return;
  viewport.addEventListener('mousedown', (event) => {
    event.preventDefault();
    state.crop.dragging = true;
    state.crop.lastX = event.clientX;
    state.crop.lastY = event.clientY;
  });
  window.addEventListener('mousemove', (event) => {
    if (!state.crop.dragging) return;
    state.crop.x += event.clientX - state.crop.lastX;
    state.crop.y += event.clientY - state.crop.lastY;
    state.crop.lastX = event.clientX;
    state.crop.lastY = event.clientY;
    updateCropView();
  });
  window.addEventListener('mouseup', () => { state.crop.dragging = false; });
  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    state.crop.zoom = Math.max(1, Math.min(3, state.crop.zoom + (event.deltaY > 0 ? -0.08 : 0.08)));
    updateCropView();
  }, { passive: false });
  if (zoom) zoom.oninput = () => { state.crop.zoom = Number(zoom.value) || 1; updateCropView(); };
  $('#cropSaveBtn') && ($('#cropSaveBtn').onclick = () => saveCroppedAvatar().catch((e) => toast(e.message, 'error')));
  $('#cropCancelBtn') && ($('#cropCancelBtn').onclick = () => $('#avatarCropDialog')?.close());
}

function bindUi() {
  applySavedLayoutSizes();
  bindPaneResizer($('#charRailResize'), { cssVar: '--char-rail-width', storageKey: 'destPoet.charRailWidth', initial: 108, min: 84, max: 260 });
  bindPaneResizer($('#statusPanelResize'), { cssVar: '--status-panel-width', storageKey: 'destPoet.statusPanelWidth', initial: 310, min: 240, max: 560, invert: true });
  bindCropUi();
  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    sendPrompt($('#promptInput').value);
  });
  $('#promptInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#insertStatusBtn') && ($('#insertStatusBtn').onclick = () => insertText('get_status(section="主角")'));
  $('#refreshStateBtn') && ($('#refreshStateBtn').onclick = () => refreshState().catch((e) => toast(e.message, 'error')));
  $('#sessionBtn') && ($('#sessionBtn').onclick = async () => { await loadSessions(); $('#sessionDialog')?.showModal(); });
  $('#newSessionBtn') && ($('#newSessionBtn').onclick = async () => {
    if (!confirm('开始新游戏/新会话？当前存档不会删除。')) return;
    try {
      await api('/api/session/new', { method: 'POST', body: '{}' });
      await loadMessages();
      await refreshState();
      toast('已创建新会话', 'ok');
    } catch (error) { toast(error.message, 'error'); }
  });
  $('#functionsBtn') && ($('#functionsBtn').onclick = async () => { await loadTools(); $('#functionDialog')?.showModal(); });
  $('#detailsBtn') && ($('#detailsBtn').onclick = () => openDetails('player').catch((e) => toast(e.message, 'error')));
  $('#modelBtn') && ($('#modelBtn').onclick = async () => { await loadModels(); $('#modelDialog')?.showModal(); });
  $('#cycleModelBtn') && ($('#cycleModelBtn').onclick = async () => { await api('/api/model/cycle', { method: 'POST', body: '{}' }); await loadModels(); toast('已切换到下一个模型', 'ok'); });
  $('#thinkingSelect') && ($('#thinkingSelect').onchange = (event) => setThinking(event.target.value).catch((e) => toast(e.message, 'error')));
  $('#backendBtn') && ($('#backendBtn').onclick = () => { renderBackendLog(); $('#backendDialog')?.showModal(); });
  $('#clearBackendLog') && ($('#clearBackendLog').onclick = () => { state.backendLogs = []; renderBackendLog(); });
  $('#abortBtn') && ($('#abortBtn').onclick = async () => { try { await api('/api/abort', { method: 'POST', body: '{}' }); toast('已请求停止', 'ok'); } catch (e) { toast(e.message, 'error'); } });
  $('#toolSearch')?.addEventListener('input', renderTools);
  $('#modelSearch')?.addEventListener('input', renderModels);
  document.querySelectorAll('[data-close]').forEach((btn) => btn.onclick = () => document.getElementById(btn.dataset.close).close());
}

async function boot() {
  bindUi();
  connectSse();
  await Promise.allSettled([loadMessages(), refreshState(), loadTools(), loadModels()]);
  setInterval(() => refreshState().catch(() => {}), 10_000);
}

boot().catch((error) => toast(error.message, 'error'));
