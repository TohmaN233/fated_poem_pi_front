// Web Bridge Extension — private localhost API for the browser frontend.
// Loaded only by start-web.sh. It exposes canonical in-process game state and
// carefully whitelisted direct actions that should not require GM narration.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STATE_SESSION_ENTRY_TYPE,
  deepGet,
  escapeJsonPointerSegment,
  getState,
  getStateSnapshot,
  markStatePersisted,
  patchState,
} from "../engine/core/state.ts";
import { buildPlayerPanel } from "../engine/core/panel";
import {
  deriveAll,
  deriveBattleSummary,
  deriveProgressionStatus,
  deriveRelationshipStatus,
  deriveQuestSummary,
  deriveActiveTriggers,
  deriveInventorySummary,
} from "../engine/core/derived";
import { EQUIPMENT_SLOTS, isEquipmentSlot, resolveEquipSlot, resolveUnequipSlot } from "../engine/items/equipment-slots";
import { buildCharacterPanel, type PresetRoleEntry } from "../engine/social/character-panel";

const __dirname = dirname(fileURLToPath(import.meta.url));

type Json = Record<string, unknown>;

type OwnerRef = {
  owner: string;
  path: string;
  data: Record<string, any>;
};

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "http://127.0.0.1",
    "cache-control": "no-store",
  });
  res.end(text);
}

function notFound(res: ServerResponse) {
  send(res, 404, { ok: false, error: "not_found" });
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function loadPresetRoles(): PresetRoleEntry[] {
  try {
    return JSON.parse(readFileSync(join(__dirname, "..", "data", "roles.json"), "utf-8"));
  } catch {
    return [];
  }
}

function itemName(item: unknown): string {
  if (!item || typeof item !== "object") return "物品";
  const raw = item as Record<string, unknown>;
  return String(raw.名称 || raw.name || raw.title || raw.type || raw.类型 || "物品");
}

function quantityOf(item: unknown): number {
  if (!item || typeof item !== "object") return 1;
  const raw = item as Record<string, unknown>;
  const value = raw.数量 ?? raw.qty ?? raw.count;
  const qty = Number(value ?? 1);
  return Number.isFinite(qty) ? Math.max(1, Math.floor(qty)) : 1;
}

function withQuantity<T extends Record<string, unknown>>(item: T, qty: number): T {
  const copy = JSON.parse(JSON.stringify(item));
  const key = Object.prototype.hasOwnProperty.call(copy, "数量") ? "数量"
    : Object.prototype.hasOwnProperty.call(copy, "qty") ? "qty"
    : Object.prototype.hasOwnProperty.call(copy, "count") ? "count"
    : "数量";
  copy[key] = qty;
  return copy;
}

function sanitizeKey(value: string): string {
  return value.trim().replace(/[\\/~]/g, "_").replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_-]/gu, "") || "物品";
}

function makeBagKey(bag: Record<string, unknown>, item: unknown, preferred?: string): string {
  const base = sanitizeKey(preferred || itemName(item));
  if (!Object.prototype.hasOwnProperty.call(bag, base)) return base;
  for (let i = 2; i < 1000; i++) {
    const key = `${base}_${i}`;
    if (!Object.prototype.hasOwnProperty.call(bag, key)) return key;
  }
  return `${base}_${Date.now().toString(36)}`;
}

function jsonPointer(parts: string[]) {
  return `/${parts.map(escapeJsonPointerSegment).join("/")}`;
}

function getOwner(state: Record<string, unknown>, owner: string): OwnerRef {
  const safeOwner = String(owner || "主角").trim() || "主角";
  if (safeOwner === "主角") {
    const data = deepGet(state as any, "主角") as Record<string, any> | undefined;
    if (!data) throw new Error("未找到主角状态");
    return { owner: safeOwner, path: "/主角", data };
  }
  const data = deepGet(state as any, `关系列表.${safeOwner}`) as Record<string, any> | undefined;
  if (!data) throw new Error(`未找到角色：${safeOwner}`);
  return { owner: safeOwner, path: jsonPointer(["关系列表", safeOwner]), data };
}

function persistSnapshot(pi: ExtensionAPI) {
  pi.appendEntry(STATE_SESSION_ENTRY_TYPE, getStateSnapshot());
  markStatePersisted();
}

function publicCharacters(state: Record<string, unknown>) {
  const pc = deepGet(state as any, "主角") as Record<string, any> || {};
  const relations = deepGet(state as any, "关系列表") as Record<string, any> || {};
  const rows: any[] = [{
    key: "主角",
    displayName: pc.姓名 || "主角",
    isProtagonist: true,
    present: true,
    level: pc.等级 ?? null,
    xp: pc.累计经验值 ?? null,
    xpNeed: pc.升级所需经验 ?? null,
    lifeTier: pc.生命层级 || "",
    avatar: pc.头像 || pc.avatar || pc.image || null,
    data: pc,
  }];

  for (const [key, data] of Object.entries(relations)) {
    if (!data || typeof data !== "object") continue;
    const char = data as Record<string, any>;
    if (char.在场 !== true) continue;
    rows.push({
      key,
      displayName: char.姓名 || key,
      isProtagonist: false,
      present: true,
      level: char.等级 ?? null,
      xp: char.累计经验值 ?? null,
      xpNeed: char.升级所需经验 ?? null,
      lifeTier: char.生命层级 || "",
      affection: char.好感度 ?? char.friendship ?? null,
      avatar: char.头像 || char.avatar || char.image || char.立绘 || null,
      data: char,
    });
  }
  return rows;
}

function statusSection(section?: string) {
  const s = getState();
  if (section === "事件") return { error: "事件为内部处理数据，默认不输出。" };
  if (section === "派生") return deriveAll(s);
  if (section === "战斗派生") return deriveBattleSummary(s);
  if (section === "升级派生") return deriveProgressionStatus(s);
  if (section === "关系派生") return deriveRelationshipStatus(s);
  if (section === "任务派生") return deriveQuestSummary(s);
  if (section === "背包派生") return deriveInventorySummary(s);
  if (section === "触发派生") return deriveActiveTriggers(s);
  if (section && Object.prototype.hasOwnProperty.call(s, section)) return (s as any)[section];
  const { 事件, ...visibleState } = s as Record<string, unknown>;
  return { ...visibleState, 派生: deriveAll(s) };
}

function listTools(pi: ExtensionAPI) {
  return pi.getAllTools().map((tool: any) => ({
    name: tool.name,
    label: tool.label || tool.name,
    description: tool.description || "",
    promptSnippet: tool.promptSnippet || "",
    parameters: tool.parameters || {},
    active: pi.getActiveTools().includes(tool.name),
    sourceInfo: tool.sourceInfo || null,
  }));
}

function equipItem(pi: ExtensionAPI, params: Json) {
  const state = getState();
  const ref = getOwner(state, String(params.owner || "主角"));
  const itemKey = String(params.itemKey || "");
  if (!itemKey) throw new Error("装备需要 itemKey");
  const bag = (ref.data.背包 || {}) as Record<string, Record<string, unknown>>;
  const equipment = (ref.data.装备 || {}) as Record<string, unknown>;
  const item = bag[itemKey];
  if (!item) throw new Error(`${ref.owner} 背包中未找到 ${itemKey}`);

  const requestedSlot = params.slot ? String(params.slot) : "";
  let slot: string | undefined;
  let allowed: readonly string[] = EQUIPMENT_SLOTS;

  // Web UI is a player-facing inventory manager. LLM-generated item metadata is
  // often inconsistent (位置/type/slot may be missing or free-form), so an
  // explicit player-selected slot is authoritative as long as it is a real slot.
  if (requestedSlot) {
    if (!isEquipmentSlot(requestedSlot)) throw new Error(`无效装备槽位：${requestedSlot}；可用：${EQUIPMENT_SLOTS.join("|")}`);
    slot = requestedSlot;
  } else {
    const resolved = resolveEquipSlot(equipment, item.slot ?? item.位置 ?? item.type ?? item.类型);
    if (!resolved.slot) throw new Error(`${resolved.error || "物品没有合法装备槽位"}；请在前端手动选择装备槽位。`);
    slot = resolved.slot;
    allowed = resolved.allowed;
  }

  const ops: Array<{ op: string; path: string; value?: unknown }> = [
    { op: "remove", path: `${ref.path}/背包/${escapeJsonPointerSegment(itemKey)}` },
    { op: "replace", path: `${ref.path}/装备/${escapeJsonPointerSegment(slot)}`, value: item },
  ];
  const old = equipment[slot] as Record<string, unknown> | null;
  if (old && typeof old === "object" && Object.keys(old).length > 0) {
    const oldKey = makeBagKey(bag, old, `${itemName(old)}_${Date.now().toString(36)}`);
    ops.push({ op: "add", path: `${ref.path}/背包/${escapeJsonPointerSegment(oldKey)}`, value: old });
  }
  patchState(ops as any);
  persistSnapshot(pi);
  return { ok: true, action: "equip", owner: ref.owner, slot, allowedSlots: allowed, itemKey, item };
}

function unequipItem(pi: ExtensionAPI, params: Json) {
  const state = getState();
  const ref = getOwner(state, String(params.owner || "主角"));
  const equipment = (ref.data.装备 || {}) as Record<string, unknown>;
  const resolved = resolveUnequipSlot(equipment, params.slot ? String(params.slot) : undefined);
  if (!resolved.slot) throw new Error(resolved.error || "卸下需要有效 slot");
  const item = equipment[resolved.slot] as Record<string, unknown> | null;
  if (!item || typeof item !== "object" || Object.keys(item).length === 0) {
    return { ok: true, action: "unequip", owner: ref.owner, slot: resolved.slot, noop: true };
  }
  const bag = (ref.data.背包 || {}) as Record<string, unknown>;
  const key = makeBagKey(bag, item, `${itemName(item)}_${Date.now().toString(36)}`);
  patchState([
    { op: "add", path: `${ref.path}/背包/${escapeJsonPointerSegment(key)}`, value: item },
    { op: "replace", path: `${ref.path}/装备/${escapeJsonPointerSegment(resolved.slot)}`, value: null },
  ] as any);
  persistSnapshot(pi);
  return { ok: true, action: "unequip", owner: ref.owner, slot: resolved.slot, itemKey: key, item };
}

function setPresence(pi: ExtensionAPI, params: Json) {
  const state = getState();
  const key = String(params.characterKey || params.owner || "").trim();
  if (!key) throw new Error("修改在场状态需要 characterKey");
  if (key === "主角") throw new Error("主角默认在场，不能手动离场");
  const ref = getOwner(state, key);
  const present = Boolean(params.present);
  const op = Object.prototype.hasOwnProperty.call(ref.data, "在场") ? "replace" : "add";
  patchState([{ op, path: `${ref.path}/在场`, value: present }] as any);
  persistSnapshot(pi);
  return { ok: true, action: "setPresence", characterKey: key, present };
}

function transferItem(pi: ExtensionAPI, params: Json) {
  const state = getState();
  const from = getOwner(state, String(params.fromOwner || params.owner || "主角"));
  const to = getOwner(state, String(params.toOwner || "主角"));
  if (from.owner === to.owner) throw new Error("来源和目标角色相同");
  const itemKey = String(params.itemKey || "");
  if (!itemKey) throw new Error("转移物品需要 itemKey");
  const quantity = Math.max(1, Math.floor(Number(params.quantity || 1)));
  const fromBag = (from.data.背包 || {}) as Record<string, Record<string, unknown>>;
  const toBag = (to.data.背包 || {}) as Record<string, Record<string, unknown>>;
  const item = fromBag[itemKey];
  if (!item) throw new Error(`${from.owner} 背包中未找到 ${itemKey}`);
  const ownedQty = quantityOf(item);
  if (quantity > ownedQty) throw new Error(`数量不足：拥有 ${ownedQty}，请求转移 ${quantity}`);

  const movedItem = withQuantity(item, quantity);
  const ops: Array<{ op: string; path: string; value?: unknown }> = [];
  if (quantity >= ownedQty) ops.push({ op: "remove", path: `${from.path}/背包/${escapeJsonPointerSegment(itemKey)}` });
  else ops.push({ op: "replace", path: `${from.path}/背包/${escapeJsonPointerSegment(itemKey)}`, value: withQuantity(item, ownedQty - quantity) });

  let targetKey = itemKey;
  if (toBag[targetKey]) {
    const existing = toBag[targetKey];
    if (itemName(existing) === itemName(item)) {
      const merged = withQuantity(existing, quantityOf(existing) + quantity);
      ops.push({ op: "replace", path: `${to.path}/背包/${escapeJsonPointerSegment(targetKey)}`, value: merged });
    } else {
      targetKey = makeBagKey(toBag, movedItem, itemName(movedItem));
      ops.push({ op: "add", path: `${to.path}/背包/${escapeJsonPointerSegment(targetKey)}`, value: movedItem });
    }
  } else {
    ops.push({ op: "add", path: `${to.path}/背包/${escapeJsonPointerSegment(targetKey)}`, value: movedItem });
  }

  patchState(ops as any);
  persistSnapshot(pi);
  return { ok: true, action: "transferItem", from: from.owner, to: to.owner, itemKey, targetKey, quantity, item: movedItem };
}

function handleAction(pi: ExtensionAPI, body: Json) {
  const type = String(body.type || "");
  if (["setAttribute", "setXp", "setLevel", "setMoney", "setFp", "patchRaw", "damage", "heal", "questReward"].includes(type)) {
    return { ok: false, blocked: true, reason: "该操作涉及属性/经验/等级/资源/任务或战斗结算，必须由 GM 叙事或专用工具处理。" };
  }
  if (type === "equip") return equipItem(pi, body);
  if (type === "unequip") return unequipItem(pi, body);
  if (type === "transferItem") return transferItem(pi, body);
  if (type === "setPresence") return setPresence(pi, body);
  throw new Error(`未知或未开放的前端直操动作：${type}`);
}

export default function webBridgeExtension(pi: ExtensionAPI) {
  const port = Number(process.env.DEST_POET_WEB_BRIDGE_PORT || 0);
  if (!port) return;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, bridge: "dest-poet-web", sessionName: pi.getSessionName?.() || null });
      if (req.method === "GET" && url.pathname === "/state") {
        const state = getState();
        return send(res, 200, { ok: true, snapshot: getStateSnapshot(), panel: buildPlayerPanel(), characters: publicCharacters(state) });
      }
      if (req.method === "GET" && url.pathname === "/characters") return send(res, 200, { ok: true, characters: publicCharacters(getState()) });
      if (req.method === "GET" && url.pathname === "/tools") return send(res, 200, { ok: true, tools: listTools(pi) });
      if (req.method === "GET" && url.pathname === "/status") return send(res, 200, { ok: true, data: statusSection(url.searchParams.get("section") || undefined) });
      if (req.method === "POST" && url.pathname === "/safe-tool") {
        const body = await readBody(req);
        const name = String(body.name || "");
        if (name === "get_player_panel") return send(res, 200, { ok: true, data: buildPlayerPanel() });
        if (name === "get_status") return send(res, 200, { ok: true, data: statusSection(body.args?.section) });
        if (name === "render_character_panel") {
          const args = body.args || {};
          if (args.persist) return send(res, 403, { ok: false, error: "persist=true 需要 GM/工具链确认；前端直执只允许只读生成角色面板。" });
          const built = buildCharacterPanel(args, { state: getState(), presetEntries: loadPresetRoles() });
          return send(res, 200, { ok: true, data: built.ok ? { success: true, ...built } : { success: false, ...built } });
        }
        return send(res, 403, { ok: false, error: "该函数不能由前端直执；请插入模板交给 GM/工具链执行。" });
      }
      if (req.method === "POST" && url.pathname === "/action") {
        const body = await readBody(req);
        const result = handleAction(pi, body);
        return send(res, result.ok === false ? 403 : 200, result);
      }
      return notFound(res);
    } catch (error) {
      return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.error(`[dest-poet-web] bridge listening on http://127.0.0.1:${port}`);
  });

  pi.on("session_shutdown", async () => {
    server.close();
  });
}
