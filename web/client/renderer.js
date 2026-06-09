const executedMessages = new Set();

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/'/g, '&#39;');
}

function renderMarkdown(text) {
  let out = String(text || '');
  out = out.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${escapeHtml(code.trim())}</code></pre>`);
  out = out.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  out = out.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  out = out.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  out = out.replace(/^>\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out.split(/\n{2,}/).map((para) => {
    if (/^\s*<(h\d|pre|blockquote|table|ul|ol|div|section|details|style|script|svg|img|p|figure|canvas)/i.test(para)) return para;
    return `<p>${para.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

function parseScalar(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value === '{}') return {};
  if (value === '[]') return [];
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && !value.endsWith(']')) throw new Error('未闭合的方括号列表');
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(/[,，]/).map((v) => v.trim()).filter(Boolean);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  return value;
}

export function parseCharacterInfoYaml(text) {
  const root = {};
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let currentKey = '';
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = line.match(/^([^\s:#][^:：]*?)\s*[:：]\s*(.*)$/);
    if (top) {
      currentKey = top[1].trim();
      root[currentKey] = parseScalar(top[2] || '');
      continue;
    }
    if (!currentKey) continue;
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item) {
      if (!Array.isArray(root[currentKey])) root[currentKey] = [];
      root[currentKey].push(parseScalar(item[1] || ''));
      continue;
    }
    const nested = line.match(/^\s+([^\s:#][^:：]*?)\s*[:：]\s*(.*)$/);
    if (nested) {
      if (!root[currentKey] || typeof root[currentKey] !== 'object' || Array.isArray(root[currentKey])) root[currentKey] = {};
      root[currentKey][nested[1].trim()] = parseScalar(nested[2] || '');
      continue;
    }
    root[currentKey] = `${root[currentKey] || ''}${root[currentKey] ? '\n' : ''}${line.trim()}`;
  }
  if (!Object.keys(root).length) throw new Error('空角色资料');
  return root;
}

function listText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(' / ');
  if (value && typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}:${listText(v)}`).join(' / ');
  return String(value || '').trim();
}

function firstValue(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function importanceClass(importance) {
  if (importance === '路人') return 'minor';
  if (importance === '命定角色') return 'fated';
  if (importance === '敌对核心') return 'hostile';
  if (importance === '重要NPC') return 'important';
  return 'standard';
}

function resolvedDisplayMode(profile, importance) {
  const panel = profile.面板 && typeof profile.面板 === 'object' ? profile.面板 : {};
  const mode = panel.展示模式 || panel.displayMode || 'auto';
  if (mode === 'compact' || mode === '轻量') return 'compact';
  if (mode === 'full' || mode === '完整') return 'full';
  return importance === '路人' ? 'compact' : 'full';
}

function attributeHtml(attrs = {}) {
  if (!attrs || typeof attrs !== 'object') return '';
  const baseKeys = ['力量', '敏捷', '体质', '智力', '精神', '感知', '意志', '魅力'];
  const keys = [
    ...baseKeys.filter((key) => attrs[key] !== undefined),
    ...Object.keys(attrs).filter((key) => !baseKeys.includes(key) && Number(attrs[key]) > 0),
  ];
  const rows = keys.map((key) => {
    const value = Number(attrs[key] || 0);
    if (!value) return '';
    const width = Math.max(8, Math.min(100, (value / 20) * 100));
    return `<div class="char-info-attr"><span>${escapeHtml(key)}</span><b>${value}</b><i style="width:${width}%"></i></div>`;
  }).filter(Boolean).join('');
  return rows ? `<div class="char-info-attrs">${rows}</div>` : '';
}

export function renderCharacterInfoCard(profile, original = '') {
  const panel = profile.面板 && typeof profile.面板 === 'object' ? profile.面板 : {};
  const name = firstValue(profile, ['姓名', '名字', '名称', 'name']) || '未命名角色';
  const importance = panel.重要度 || profile.重要度 || '普通互动';
  const mode = resolvedDisplayMode(profile, importance);
  const cls = importanceClass(importance);
  const identity = listText(firstValue(profile, ['身份', '身分']));
  const job = listText(firstValue(profile, ['职业', '職業']));
  const race = listText(firstValue(profile, ['种族', '種族'])) || '未知种族';
  const level = firstValue(profile, ['等级', '等級', 'level']) || '?';
  const tier = firstValue(profile, ['生命层级', '生命層級']) || '';
  const appearance = listText(firstValue(profile, ['外貌特质', '外貌特征', '外貌']));
  const outfit = listText(firstValue(profile, ['衣物装饰', '衣着', '服装', '穿着']));
  const personality = listText(firstValue(profile, ['性格', '性格钩子']));
  const likes = listText(firstValue(profile, ['喜爱', '喜好']));
  const background = listText(firstValue(profile, ['背景故事', '背景', '背景钩子']));
  const avatar = firstValue(profile, ['头像', 'avatar', 'image', '立绘']);
  const tags = [race, `Lv.${level}`, tier, identity, job].filter(Boolean).slice(0, 6);
  const subtitle = [identity, job].filter(Boolean).join(' · ') || personality || appearance || '角色资料';
  const rawDetails = original ? `<details class="char-info-raw"><summary>原始 char_info</summary><pre>${escapeHtml(original.trim())}</pre></details>` : '';

  if (mode === 'compact') {
    return `<section class="character-info-card compact ${cls}">
      <div class="char-info-compact-head"><span>${escapeHtml(importance)}</span><b>${escapeHtml(name)}</b><small>${escapeHtml(subtitle)}</small></div>
      ${appearance ? `<p>${escapeHtml(appearance)}</p>` : ''}
      ${rawDetails}
    </section>`;
  }

  return `<section class="character-info-card full ${cls}">
    <div class="char-info-portrait">${avatar ? `<img src="${escapeAttr(avatar)}" alt="${escapeAttr(name)}">` : `<span>${escapeHtml(String(name).slice(0, 2))}</span>`}</div>
    <div class="char-info-main">
      <div class="char-info-kicker">${escapeHtml(importance)}${panel.来源 ? ` · ${escapeHtml(panel.来源)}` : ''}</div>
      <h3>${escapeHtml(name)}</h3>
      <p class="char-info-subtitle">${escapeHtml(subtitle)}</p>
      <div class="char-info-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="char-info-grid">
        ${personality ? `<div><b>性格</b><span>${escapeHtml(personality)}</span></div>` : ''}
        ${likes ? `<div><b>喜爱</b><span>${escapeHtml(likes)}</span></div>` : ''}
        ${appearance ? `<div><b>外貌</b><span>${escapeHtml(appearance)}</span></div>` : ''}
        ${outfit ? `<div><b>衣物</b><span>${escapeHtml(outfit)}</span></div>` : ''}
        ${background ? `<div class="wide"><b>背景钩子</b><span>${escapeHtml(background)}</span></div>` : ''}
      </div>
      ${attributeHtml(profile.属性)}
      ${rawDetails}
    </div>
  </section>`;
}

function renderTextSegment(segment) {
  if (!segment) return '';
  if (/^\s*<\/?[a-zA-Z][\s\S]*>/m.test(segment.trim())) return segment;
  return renderMarkdown(segment);
}

export function renderCharacterInfoDocument(text) {
  const raw = String(text || '');
  const re = /<char_info>([\s\S]*?)<\/char_info>/gi;
  let match;
  let cursor = 0;
  let output = '';
  let found = false;
  while ((match = re.exec(raw))) {
    found = true;
    output += renderTextSegment(raw.slice(cursor, match.index));
    const body = match[1];
    try {
      const profile = parseCharacterInfoYaml(body);
      output += renderCharacterInfoCard(profile, match[0]);
    } catch (error) {
      output += `<details class="char-info-error" open><summary>角色资料解析失败</summary><pre>${escapeHtml(body.trim())}</pre><p>${escapeHtml(error?.message || String(error))}</p></details>`;
    }
    cursor = match.index + match[0].length;
  }
  if (!found) return null;
  output += renderTextSegment(raw.slice(cursor));
  return output;
}

export function trustedRender(element, text, { final = false, messageId = '' } = {}) {
  const raw = String(text || '');
  const charInfoHtml = renderCharacterInfoDocument(raw);
  if (charInfoHtml !== null) {
    element.innerHTML = charInfoHtml;
  } else if (raw.includes('<char_info')) {
    element.innerHTML = `<pre><code>${escapeHtml(raw)}</code></pre>`;
  } else {
    const looksHtml = /<\/?[a-zA-Z][\s\S]*>/m.test(raw);
    element.innerHTML = looksHtml ? raw : renderMarkdown(raw);
  }
  if (final && messageId && !executedMessages.has(messageId)) {
    executedMessages.add(messageId);
    executeScripts(element);
  }
}

export function executeScripts(root) {
  const scripts = [...root.querySelectorAll('script')];
  for (const oldScript of scripts) {
    const script = document.createElement('script');
    for (const attr of oldScript.attributes) script.setAttribute(attr.name, attr.value);
    script.textContent = oldScript.textContent;
    oldScript.replaceWith(script);
  }
}
