import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as check } from './check-goals.mjs';
import { SELF_COMMAND, TEMPLATES_DIR, initProject, mergeClaudeMd, mergeSettings, renderTemplate, shellQuote } from './init.mjs';

const CMD = 'node "/opt/saihai/bin/saihai.mjs"';
const emptyProject = () => realpathSync(mkdtempSync(join(tmpdir(), 'saihai-init-')));
const read = (root, path) => readFileSync(join(root, path), 'utf8');
const settingsOf = (root) => JSON.parse(read(root, '.claude/settings.json'));
const hookCommands = (settings) => Object.values(settings.hooks ?? {}).flat().flatMap((m) => m.hooks.map((h) => h.command));

test('renderTemplate: {{saihai}} をすべて呼び方に置き換える', () => {
  assert.equal(renderTemplate('`{{saihai}} check` と `{{saihai}} inbox`', 'saihai'), '`saihai check` と `saihai inbox`');
});

test('initProject: 空のプロジェクトに G0・判断ログ・設定・CLAUDE.md の節・スキル2つ・フックが入り、検査を通る（G9.E2）', () => {
  const root = emptyProject();
  const report = initProject({ root, command: CMD, date: '2026-10-12' });
  const g0 = readdirSync(join(root, 'goals')).find((n) => n.startsWith('G0-'));
  assert.ok(g0);
  assert.match(read(root, `goals/${g0}`), /^id: G0$/m);
  assert.match(read(root, `goals/${g0}`), /^parent: null$/m);
  assert.ok(existsSync(join(root, 'decisions', 'log.jsonl')));
  assert.deepEqual(JSON.parse(read(root, 'saihai.config.json')), { command: CMD, gate: { checks: [] }, probes: {} });
  assert.ok(existsSync(join(root, 'observations', 'log.jsonl')));
  assert.match(read(root, 'CLAUDE.md'), /<!-- saihai:start/);
  assert.match(read(root, 'CLAUDE.md'), /node "\/opt\/saihai\/bin\/saihai\.mjs" brief/);
  assert.doesNotMatch(read(root, 'CLAUDE.md'), /\{\{saihai\}\}/);
  for (const skill of ['goal-draft', 'interpret']) assert.match(read(root, `.claude/skills/${skill}/SKILL.md`), new RegExp(`name: ${skill}`));
  const commands = hookCommands(settingsOf(root));
  assert.ok(commands.some((c) => c.includes(`${CMD} check --hook`)));
  assert.ok(commands.some((c) => c.includes(`${CMD} check --stop`)));
  assert.ok(commands.some((c) => c.includes(`${CMD} guard`)));
  assert.equal(check({ argv: [], goalsDir: join(root, 'goals') }).code, 0);
  assert.match(report, /作りました/);
});

test('initProject: 既にある CLAUDE.md と設定は上書きせず、saihai の節とフックを足す。2回動かしても重複しない（G9.E3）', () => {
  const root = emptyProject();
  writeFileSync(join(root, 'CLAUDE.md'), '# 私のプロジェクト\n\n既存の指示\n');
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }));
  initProject({ root, command: CMD, date: '2026-10-12' });
  initProject({ root, command: CMD, date: '2026-10-12' });
  const md = read(root, 'CLAUDE.md');
  assert.match(md, /^# 私のプロジェクト\n\n既存の指示\n/);
  assert.equal(md.match(/saihai:start/g).length, 1);
  const settings = settingsOf(root);
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
  const commands = hookCommands(settings);
  assert.ok(commands.includes('echo bye'));
  assert.equal(commands.filter((c) => c.includes('check --stop')).length, 1);
  assert.equal(readdirSync(join(root, 'goals')).filter((n) => n.startsWith('G0-')).length, 1);
});

test('initProject: 中身の違うスキルが既にあれば上書きせず報告する。--force なら置き換える', () => {
  const root = emptyProject();
  mkdirSync(join(root, '.claude', 'skills', 'interpret'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'interpret', 'SKILL.md'), '自作のスキル');
  const report = initProject({ root, command: CMD, date: '2026-10-12' });
  assert.equal(read(root, '.claude/skills/interpret/SKILL.md'), '自作のスキル');
  assert.match(report, /interpret.*上書きしません/);
  initProject({ root, command: CMD, date: '2026-10-12', force: true });
  assert.match(read(root, '.claude/skills/interpret/SKILL.md'), /name: interpret/);
});

test('mergeClaudeMd: 印の間だけを置き換え、印がなければ末尾に足す', () => {
  const section = '<!-- saihai:start -->\n新\n<!-- saihai:end -->\n';
  assert.equal(mergeClaudeMd('', section), section);
  assert.equal(mergeClaudeMd('前\n', section), `前\n\n${section}`);
  assert.equal(mergeClaudeMd('前\n<!-- saihai:start -->\n旧\n<!-- saihai:end -->\n後\n', section), '前\n<!-- saihai:start -->\n新\n<!-- saihai:end -->\n後\n');
});

test('mergeSettings: 元のオブジェクトを変えずに新しいオブジェクトを返す', () => {
  const before = { hooks: { Stop: [] } };
  const after = mergeSettings(before, CMD);
  assert.deepEqual(before, { hooks: { Stop: [] } });
  assert.equal(hookCommands(after).length, 3);
});

test('saihai 自身のスキルと CLAUDE.md の節は、init が入れるものと同じ雛形から作られている（G9.E5）', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const rendered = (path) => renderTemplate(readFileSync(join(TEMPLATES_DIR, path), 'utf8'), SELF_COMMAND);
  for (const skill of ['goal-draft', 'interpret']) {
    assert.equal(read(repo, `.claude/skills/${skill}/SKILL.md`), rendered(`skills/${skill}/SKILL.md`), `${skill} が雛形とずれています`);
  }
  assert.ok(read(repo, 'CLAUDE.md').includes(rendered('CLAUDE.md')), 'CLAUDE.md の saihai の節が雛形とずれています');
});

// --- レビューの指摘（壊さない・冪等・安全） ---

const nothingWritten = (root) => {
  assert.ok(!existsSync(join(root, 'goals')), 'goals/ を作ってはいけない');
  assert.ok(!existsSync(join(root, '.claude', 'skills')), 'スキルを書いてはいけない');
};

test('mergeClaudeMd: 印が片方だけ・順序が逆・2組あるときは、利用者の文章を消さないよう止まる', () => {
  const section = '<!-- saihai:start -->\n新\n<!-- saihai:end -->\n';
  assert.throws(() => mergeClaudeMd('<!-- saihai:start -->\n利用者の文章\n', section), /印/);
  assert.throws(() => mergeClaudeMd('<!-- saihai:end -->\n利用者の文章\n<!-- saihai:start -->\n', section), /印/);
  assert.throws(() => mergeClaudeMd(`${section}間\n${section}`, section), /印/);
});

test('initProject: CLAUDE.md の印が崩れていれば、何も書かずに止まる（2回目に利用者の文章が消えない）', () => {
  const root = emptyProject();
  writeFileSync(join(root, 'CLAUDE.md'), '<!-- saihai:start\n## 利用者の大事な規則\n');
  assert.throws(() => initProject({ root, command: CMD, date: '2026-10-12' }), /CLAUDE\.md/);
  assert.equal(read(root, 'CLAUDE.md'), '<!-- saihai:start\n## 利用者の大事な規則\n');
  nothingWritten(root);
});

test('initProject: 呼び方が変わって init し直しても、フックは二重にならず、設定・スキル・CLAUDE.md が新しい呼び方になる', () => {
  const root = emptyProject();
  initProject({ root, command: CMD, date: '2026-10-12' });
  const NEW = "node '/new/place/bin/saihai.mjs'";
  initProject({ root, command: NEW, date: '2026-10-12' });
  const commands = hookCommands(settingsOf(root));
  assert.equal(commands.length, 3);
  assert.ok(commands.every((c) => c.startsWith(NEW)), commands.join('\n'));
  assert.equal(JSON.parse(read(root, 'saihai.config.json')).command, NEW);
  assert.match(read(root, '.claude/skills/interpret/SKILL.md'), /\/new\/place/);
  assert.doesNotMatch(read(root, 'CLAUDE.md'), /\/opt\/saihai/);
});

test('shellQuote: パスに $・バッククォート・引用符があっても、シェルで展開されない', () => {
  for (const path of ['/a b/saihai.mjs', '/a`touch PWNED`$HOME/x', "/it's/x"]) {
    assert.equal(spawnSync('sh', ['-c', `printf %s ${shellQuote(path)}`], { encoding: 'utf8' }).stdout, path);
  }
});

test('initProject: goals/ にゴール文書の名前でない Markdown があれば、何も書かずに止まる（フックが利用者のファイルを書き換えさせないように）', () => {
  const root = emptyProject();
  mkdirSync(join(root, 'goals'));
  writeFileSync(join(root, 'goals', 'q4-okr.md'), '# Q4 OKR\n');
  assert.throws(() => initProject({ root, command: CMD, date: '2026-10-12' }), /q4-okr\.md/);
  assert.deepEqual(readdirSync(join(root, 'goals')), ['q4-okr.md']);
  assert.ok(!existsSync(join(root, 'CLAUDE.md')));
});

test('initProject: .claude/settings.json が読めなければ、ファイル名を示して何も書かずに止まる', () => {
  const root = emptyProject();
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'settings.json'), '{ // コメント\n "hooks": {} }');
  assert.throws(() => initProject({ root, command: CMD, date: '2026-10-12' }), /settings\.json/);
  nothingWritten(root);
  writeFileSync(join(root, '.claude', 'settings.json'), '{ "hooks": { "Stop": "x" } }');
  assert.throws(() => initProject({ root, command: CMD, date: '2026-10-12' }), /settings\.json/);
  nothingWritten(root);
});

test('initProject: 導入先のフォルダがなければ止まる', () => {
  assert.throws(() => initProject({ root: join(emptyProject(), 'typo'), command: CMD, date: '2026-10-12' }), /ありません/);
});
