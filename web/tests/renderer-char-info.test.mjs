import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCharacterInfoDocument } from '../client/renderer.js';

test('renders a char_info block as a character card', () => {
  const html = renderCharacterInfoDocument(`<char_info>
姓名: 艾尔莎
等级: 3
种族: 人类
生命层级: 第一层级/普通层级
身份:
  - 雾港药师
性格: 温和细心
外貌特质: 袖口有草药汁痕
面板:
  重要度: 重要NPC
  展示模式: 完整
</char_info>`);

  assert.match(html, /character-info-card/);
  assert.match(html, /艾尔莎/);
  assert.match(html, /重要NPC/);
  assert.match(html, /雾港药师/);
});

test('renders multiple char_info blocks independently', () => {
  const html = renderCharacterInfoDocument(`<char_info>
姓名: 甲
面板:
  重要度: 路人
</char_info>
旁白
<char_info>
姓名: 乙
面板:
  重要度: 命定角色
</char_info>`);

  assert.equal((html.match(/character-info-card/g) || []).length, 2);
  assert.match(html, /甲/);
  assert.match(html, /乙/);
  assert.match(html, /旁白/);
});

test('falls back to the original block when char_info parsing fails', () => {
  const html = renderCharacterInfoDocument(`<char_info>
姓名: [未闭合
</char_info>`);

  assert.match(html, /角色资料解析失败/);
  assert.match(html, /姓名: \[未闭合/);
});

test('scales attribute bars against a max value of 20', () => {
  const html = renderCharacterInfoDocument(`<char_info>
姓名: 测试角色
属性:
  力量: 10
  敏捷: 20
</char_info>`);

  assert.match(html, /力量[\s\S]*width:50%/);
  assert.match(html, /敏捷[\s\S]*width:100%/);
});
