import { readdir, stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text || '')
      .join('\n');
  }
  return '';
}

function truncate(value, max = 140) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

async function readSessionSummary(file) {
  const raw = await readFile(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let id = '';
  let headerTimestamp = '';
  let name = '';
  let preview = '';
  let messageCount = 0;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'session') {
      id = entry.id || id;
      headerTimestamp = entry.timestamp || headerTimestamp;
      continue;
    }

    if (entry.type === 'session_info' && entry.name) {
      name = String(entry.name);
      continue;
    }

    if (entry.type === 'message') {
      messageCount += 1;
      if (!preview && entry.message?.role === 'user') {
        preview = truncate(textFromContent(entry.message.content));
      }
    }
  }

  return { id, headerTimestamp, name, preview, messageCount };
}

export async function listSessions(sessionDir) {
  const dir = resolve(sessionDir);
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = join(dir, entry.name);
    const [fileStat, summary] = await Promise.all([stat(file), readSessionSummary(file)]);
    sessions.push({
      file,
      basename: entry.name,
      id: summary.id,
      name: summary.name || '',
      preview: summary.preview || '',
      messageCount: summary.messageCount,
      createdAt: summary.headerTimestamp || fileStat.birthtime.toISOString(),
      modifiedAt: fileStat.mtime.toISOString(),
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
    });
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || a.basename.localeCompare(b.basename));
  return sessions;
}

export function pickLatestSession(sessions) {
  return Array.isArray(sessions) && sessions.length > 0 ? sessions[0] : null;
}
