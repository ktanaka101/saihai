// saihai を他のプロジェクトに導入する（G9.E2・E3）。
// 導入先の既存のファイルは上書きしない（G9 の不変条件）。CLAUDE.md は印の間だけ、設定は saihai のフックだけを入れ替える。
// 先にすべてを確かめ、問題があれば何も書かずに止まる（途中まで書いた状態を残さない）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goalTemplate } from './new-goal.mjs';

export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));
export const SAIHAI_BIN = fileURLToPath(new URL('../bin/saihai.mjs', import.meta.url));
const SKILLS = ['goal-draft', 'interpret'];
export const SELF_COMMAND = 'node bin/saihai.mjs'; // saihai 自身からの呼び方（G9.E5）
const START = '<!-- saihai:start';
const END = '<!-- saihai:end -->';
const GOAL_FILE = /^G\d+(\.\d+)*-[a-z0-9-]+\.md$/;

export const renderTemplate = (text, command) => text.replaceAll('{{saihai}}', command);

// シェルで展開されないよう単一引用符で囲む（パスの $ やバッククォートを実行させない）
export const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

// 導入先からの呼び方（J78）：PATH 上の saihai があればそれ、なければこの saihai の絶対パス
export function saihaiCommand({ onPath = () => spawnSync('sh', ['-c', 'command -v saihai'], { stdio: 'ignore' }).status === 0 } = {}) {
  return onPath() ? 'saihai' : `node ${shellQuote(SAIHAI_BIN)}`;
}

const count = (text, mark) => text.split(mark).length - 1;

// 印が1組だけ正しい順に並んでいるときだけ置き換える。崩れていれば、利用者の文章を消さないよう止まる
export function mergeClaudeMd(existing, section) {
  const starts = count(existing, START);
  const ends = count(existing, END);
  if (starts === 0 && ends === 0) return existing.trim() ? `${existing.replace(/\n*$/, '\n')}\n${section}` : section;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new Error('CLAUDE.md の saihai の印（<!-- saihai:start と <!-- saihai:end -->）が1組そろっていません。手で直してから、もう一度 init してください');
  }
  const after = existing.slice(end + END.length).replace(/^\n/, '');
  return `${existing.slice(0, start)}${section}${after}`;
}

// saihai のフックの種類。呼び方（パス）が変わっても同じ種類として見分ける
const KINDS = [
  { kind: 'guard', event: 'PreToolUse', matcher: 'Bash', args: 'guard', statusMessage: 'main への直接の反映を確認中' },
  { kind: 'hook', event: 'PostToolUse', matcher: 'Edit|Write', args: 'check --hook --root "$CLAUDE_PROJECT_DIR"', statusMessage: 'ゴール文書の書式を検査中' },
  { kind: 'stop', event: 'Stop', args: 'check --stop --root "$CLAUDE_PROJECT_DIR"', statusMessage: 'ゴール文書の書式を検査中' },
];
const kindOf = (command) => {
  const m = String(command ?? '').match(/saihai(\.mjs)?['"]?\s+(guard|check\s+--hook|check\s+--stop)(\s|$)/);
  return m ? { guard: 'guard', 'check --hook': 'hook', 'check --stop': 'stop' }[m[2].replace(/\s+/, ' ')] : null;
};

function validateSettings(settings) {
  if (settings === null) return;
  const ok =
    typeof settings === 'object' &&
    !Array.isArray(settings) &&
    (settings.hooks === undefined ||
      (typeof settings.hooks === 'object' &&
        !Array.isArray(settings.hooks) &&
        Object.values(settings.hooks).every((ms) => Array.isArray(ms) && ms.every((m) => m && typeof m === 'object' && (m.hooks === undefined || Array.isArray(m.hooks))))));
  if (!ok) throw new Error('.claude/settings.json の hooks の形が想定と違います。手で直してから、もう一度 init してください');
}

// 既存の設定はそのまま残し、saihai のフックだけを今の呼び方のものにする（古い呼び方のものは外す）。元のオブジェクトは変えない
export function mergeSettings(existing, command) {
  const hooks = { ...(existing?.hooks ?? {}) };
  for (const k of KINDS) {
    const wanted = `${command} ${k.args}`;
    const matchers = hooks[k.event] ?? [];
    const kept = matchers
      .map((m) => ({ m, rest: (m.hooks ?? []).filter((h) => kindOf(h.command) !== k.kind || h.command === wanted) }))
      .filter(({ m, rest }) => rest.length > 0 || (m.hooks ?? []).length === 0)
      .map(({ m, rest }) => (m.hooks ? { ...m, hooks: rest } : m));
    const present = kept.some((m) => (m.hooks ?? []).some((h) => h.command === wanted));
    const entry = { type: 'command', command: wanted, statusMessage: k.statusMessage };
    hooks[k.event] = present ? kept : [...kept, { ...(k.matcher ? { matcher: k.matcher } : {}), hooks: [entry] }];
  }
  return { ...(existing ?? {}), hooks };
}

const readJson = (path, label) => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} を JSON として読めません（${error.message}）。手で直してから、もう一度 init してください`);
  }
};

// 書く前に確かめ、書く内容をすべて決める
function plan({ root, command, templatesDir, date, force }) {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`導入先のフォルダ ${root} がありません`);
  const rel = (path) => join(root, path);
  const writes = [];
  const report = [];

  // ゴール文書：goals/ の Markdown はすべてゴール文書として検査される。違う名前のものがあれば止まる
  const goalsDir = rel('goals');
  if (existsSync(goalsDir) && !statSync(goalsDir).isDirectory()) throw new Error('goals がフォルダではありません');
  const names = existsSync(goalsDir) ? readdirSync(goalsDir).filter((n) => n.endsWith('.md')) : [];
  const strangers = names.filter((n) => !GOAL_FILE.test(n));
  if (strangers.length) {
    throw new Error(`goals/ にゴール文書の名前（G{番号}-{名前}.md）でない Markdown があります：${strangers.join('、')}。saihai はこれを検査し、直すよう求め続けるので、別の場所に移してから init してください`);
  }
  if (names.some((n) => /^G0-/.test(n))) {
    report.push('- goals/G0：既にあるのでそのまま');
  } else {
    const goal = goalTemplate({ id: 'G0', parent: null, title: `${basename(root)} のゴール`, summary: '（このプロジェクトが目指すこと。goal-draft スキルの手順で書く）', date });
    writes.push({ path: 'goals/G0-project.md', content: goal, note: '作りました' });
  }
  for (const path of ['decisions/log.jsonl', 'observations/log.jsonl']) {
    if (existsSync(rel(path))) report.push(`- ${path}：既にあるのでそのまま`);
    else writes.push({ path, content: '', note: '作りました' });
  }

  // 設定：saihai が持つ command だけを今の呼び方にする（ほかの項目はそのまま）
  const config = readJson(rel('saihai.config.json'), 'saihai.config.json');
  const oldCommand = config?.command;
  if (!config) writes.push({ path: 'saihai.config.json', content: `${JSON.stringify({ command, gate: { checks: [] }, probes: {} }, null, 2)}\n`, note: '作りました' });
  else if (oldCommand !== command) writes.push({ path: 'saihai.config.json', content: `${JSON.stringify({ ...config, command }, null, 2)}\n`, note: `呼び方を ${command} にしました（ほかの項目はそのまま）` });
  else report.push('- saihai.config.json：変更なし');

  // CLAUDE.md：印の間だけ
  const before = existsSync(rel('CLAUDE.md')) ? readFileSync(rel('CLAUDE.md'), 'utf8') : '';
  const merged = mergeClaudeMd(before, renderTemplate(readFileSync(join(templatesDir, 'CLAUDE.md'), 'utf8'), command));
  if (merged === before) report.push('- CLAUDE.md：変更なし');
  else writes.push({ path: 'CLAUDE.md', content: merged, note: before ? 'saihai の節を書きました（ほかの部分はそのまま）' : '作りました' });

  // スキル：前に init で入れたまま（前の呼び方で作った雛形と同じ）なら置き換える。手が入っていれば --force のときだけ
  for (const skill of SKILLS) {
    const path = `.claude/skills/${skill}/SKILL.md`;
    const template = readFileSync(join(templatesDir, 'skills', skill, 'SKILL.md'), 'utf8');
    const content = renderTemplate(template, command);
    const current = existsSync(rel(path)) ? readFileSync(rel(path), 'utf8') : null;
    const untouched = current !== null && oldCommand !== undefined && current === renderTemplate(template, oldCommand);
    if (current === content) report.push(`- スキル ${skill}：変更なし`);
    else if (current === null || untouched || force) writes.push({ path, content, note: current === null ? '作りました' : '置き換えました' });
    else report.push(`- スキル ${skill}：中身の違うものが既にあるので上書きしません（置き換えるなら --force）`);
  }

  // フック：saihai のものだけを入れ替える
  const settings = readJson(rel('.claude/settings.json'), '.claude/settings.json');
  validateSettings(settings);
  const next = mergeSettings(settings, command);
  if (JSON.stringify(next) === JSON.stringify(settings)) report.push('- .claude/settings.json：変更なし');
  else writes.push({ path: '.claude/settings.json', content: `${JSON.stringify(next, null, 2)}\n`, note: 'saihai のフックを入れました（ほかの設定はそのまま）' });

  return { writes, report };
}

export function initProject({ root, command = saihaiCommand(), templatesDir = TEMPLATES_DIR, date = new Date().toISOString().slice(0, 10), force = false }) {
  const { writes, report } = plan({ root, command, templatesDir, date, force });
  for (const w of writes) {
    mkdirSync(dirname(join(root, w.path)), { recursive: true });
    writeFileSync(join(root, w.path), w.content);
  }
  return [
    `saihai を ${root} に導入しました（呼び方：${command}）`,
    ...writes.map((w) => `- ${w.path}：${w.note}`),
    ...report,
    '',
    '次の一歩：Claude Code で「〇〇をゴールにしたい」と伝えると、goal-draft スキルで G0 の草案を書きます。',
    `受信箱：${command} inbox`,
    '',
  ].join('\n');
}
