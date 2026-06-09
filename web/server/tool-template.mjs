const DIRECT_SAFE_TOOLS = new Set(['get_status', 'get_player_panel', 'render_character_panel']);

export function groupTool(tool) {
  const name = tool.name || '';
  if (name.startsWith('mcp_')) return 'Memo Palace';
  if (['get_status', 'get_player_panel', 'get_state_schema', 'migrate_state', 'patch_state'].includes(name)) return '状态';
  if (['roll_d20', 'resolve_combat_round', 'generate_battle_npc', 'calculate_xp', 'apply_damage_to_player', 'try_level_up'].includes(name)) return '战斗';
  if (['craft_item', 'get_price', 'generate_loot', 'generate_creation_seed', 'manage_item', 'manage_equipment'].includes(name)) return '制作/交易';
  if (['update_affection', 'get_fate_core_info', 'set_fate_core', 'setup_game', 'manage_contract', 'commit_skill', 'render_character_panel'].includes(name)) return '社交/成长';
  if (['lookup', 'change_scene', 'generate_quest', 'manage_quest', 'manage_dlc', 'get_dlc_info', 'generate_story_npc'].includes(name)) return '探索/世界';
  return '其他';
}

function literalDefault(schema) {
  if (!schema || typeof schema !== 'object') return 'value';
  if (Array.isArray(schema.enum) && schema.enum.length) return JSON.stringify(schema.enum[0]);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.default !== undefined) return JSON.stringify(schema.default);
  if (schema.type === 'string') return '""';
  if (schema.type === 'number' || schema.type === 'integer') return '0';
  if (schema.type === 'boolean') return 'false';
  if (schema.type === 'array') return '[]';
  if (schema.type === 'object') return '{}';
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return literalDefault(schema.anyOf[0]);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return literalDefault(schema.oneOf[0]);
  return 'value';
}

export function toolTemplate(tool) {
  const schema = tool.parameters || {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const entries = Object.entries(props).map(([key, prop]) => {
    const optional = required.has(key) ? '' : '?';
    return `${key}${optional}=${literalDefault(prop)}`;
  });
  return `${tool.name}(${entries.join(', ')})`;
}

const CODING_BUILTINS = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);

export function decorateTools(tools = []) {
  return tools
    .filter((tool) => !CODING_BUILTINS.has(tool.name))
    .map((tool) => ({
      ...tool,
      group: groupTool(tool),
      template: toolTemplate(tool),
      directSafe: DIRECT_SAFE_TOOLS.has(tool.name),
    }));
}
