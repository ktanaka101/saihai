import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './saihai.mjs';

const BIN = fileURLToPath(new URL('./saihai.mjs', import.meta.url));
const CMD = `node "${BIN}"`;

// 一時フォルダに git のプロジェクトを作って導入する
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'saihai-cli-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  mkdirSync(join(root, 'src'));
  const r = main({ argv: ['init', '--command', CMD], cwd: root, env: {} });
  assert.equal(r.code, 0, r.err);
  return root;
}
const sub = (root) => join(root, 'src');

test('saihai: サブコマンドがなければ使い方を出す（G9.E1）', () => {
  const r = main({ argv: [], cwd: '/', env: {} });
  assert.equal(r.code, 1);
  assert.match(r.err, /init/);
  assert.match(r.err, /inbox/);
});

test('saihai: 知らないサブコマンド（toString など）は使い方を出す', () => {
  for (const name of ['toString', 'constructor', 'nope']) {
    const r = main({ argv: [name], cwd: '/', env: {} });
    assert.equal(r.code, 1, name);
    assert.match(r.err, /使い方/, name);
  }
});

test('saihai: --root に存在しないフォルダを渡すと、理由を示して止まる', () => {
  const r = main({ argv: ['observe', '--root', '/nonexistent/saihai-typo'], cwd: '/', env: {} });
  assert.equal(r.code, 1);
  assert.match(r.err, /ありません/);
});

test('saihai: プロジェクトが見つからなければ、init か --root を促す', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'saihai-cli-none-')));
  const r = main({ argv: ['check'], cwd: dir, env: {} });
  assert.equal(r.code, 1);
  assert.match(r.err, /saihai init/);
});

test('saihai init のあと、サブフォルダからでも check・new・brief・log・inbox・observe・aar が動く（G9.E1・E2）', () => {
  const root = project();
  const run = (...argv) => main({ argv, cwd: sub(root), env: {} });
  assert.equal(run('check').code, 0);
  const created = run('new', '--parent', 'G0', '--slug', 'first', '--title', '最初', '--summary', '要約');
  assert.equal(created.code, 0, created.err);
  assert.ok(existsSync(join(root, 'goals', 'G1-first.md')));
  assert.match(run('brief', 'G1').out, /委任指示：G1/);
  assert.equal(run('log', '--goal', 'G1', '--kind', 'バックブリーフ', '--decision', '解釈').code, 0);
  assert.match(readFileSync(join(root, 'decisions', 'log.jsonl'), 'utf8'), /"goal":"G1"/);
  assert.match(run('inbox').out, /# 受信箱/);
  const observed = run('observe', '--save');
  assert.match(observed.out, /# 観測/);
  assert.doesNotMatch(observed.out, /隠しシナリオ/);
  assert.match(readFileSync(join(root, 'observations', 'log.jsonl'), 'utf8'), /"kind":"観測"/);
  assert.match(run('aar', 'G1').out, /事後検証の材料/);
});

test('saihai --root と SAIHAI_ROOT で対象を決められる（G9.E1）', () => {
  const root = project();
  assert.equal(main({ argv: ['check', '--root', root], cwd: '/', env: {} }).code, 0);
  assert.equal(main({ argv: ['check'], cwd: '/', env: { SAIHAI_ROOT: root } }).code, 0);
});

test('saihai guard: main への直接のコミットを止める', () => {
  const root = project();
  // コミットがまだない新しいリポジトリでも、今のブランチ（main）が分かる
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: root });
  const r = main({ argv: ['guard'], cwd: root, env: {}, stdin });
  assert.equal(r.code, 2);
  assert.match(r.err, /gate/);
});

test('saihai: 実行ファイルとして動く', () => {
  const root = project();
  const r = spawnSync(process.execPath, [BIN, 'check'], { cwd: sub(root), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /違反なし/);
});

// --- G10：プラグインとして、どのプロジェクトでも動く ---

const plain = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'saihai-plain-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
};
const hookInput = (root, command = 'git commit -m x') => JSON.stringify({ tool_name: 'Bash', tool_input: { command, file_path: join(root, 'a.md') }, cwd: root });

test('saihai を使っていないプロジェクトでは、フック（check・context・guard）は何もせずエラーも出さない（G10.E2）', () => {
  const root = plain();
  for (const argv of [['check', '--hook', '--root', root], ['check', '--stop', '--root', root], ['context', '--root', root], ['guard']]) {
    const r = main({ argv, cwd: root, env: {}, stdin: hookInput(root) });
    assert.deepEqual([r.code, r.out, r.err], [0, '', ''], argv.join(' '));
  }
});

test('guard は、設定で guard: true にしたプロジェクトだけで main への直接のコミットを止める（G10.E3）', () => {
  const root = plain();
  assert.equal(main({ argv: ['init', '--minimal', '--command', CMD], cwd: root, env: {} }).code, 0);
  assert.equal(main({ argv: ['guard'], cwd: root, env: {}, stdin: hookInput(root) }).code, 0);
  const config = JSON.parse(readFileSync(join(root, 'saihai.config.json'), 'utf8'));
  writeFileSync(join(root, 'saihai.config.json'), JSON.stringify({ ...config, guard: true }));
  assert.equal(main({ argv: ['guard'], cwd: root, env: {}, stdin: hookInput(root) }).code, 2);
});

test('saihai context：saihai を使うプロジェクトでだけ、委任の約束をセッションの文脈に入れる（G10.E4）', () => {
  const root = project();
  const r = main({ argv: ['context', '--root', root], cwd: '/', env: {} });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /バックブリーフ/);
  assert.match(out.hookSpecificOutput.additionalContext, /brief <ゴールの ID>/);
});

test('saihai init --minimal：ゴール文書・判断ログ・設定だけを作り、CLAUDE.md・スキル・フックには触れない（G10.E5）', () => {
  const root = plain();
  const r = main({ argv: ['init', '--minimal', '--command', 'saihai'], cwd: root, env: {} });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(root, 'goals', 'G0-project.md')));
  assert.ok(existsSync(join(root, 'decisions', 'log.jsonl')));
  assert.ok(!existsSync(join(root, 'CLAUDE.md')));
  assert.ok(!existsSync(join(root, '.claude')));
  assert.equal(JSON.parse(readFileSync(join(root, 'saihai.config.json'), 'utf8')).guard, undefined);
  assert.equal(main({ argv: ['check'], cwd: root, env: {} }).code, 0);
});

test('saihai init（全部入り）は guard を有効にする（フックも入れるので、今までどおり止める）', () => {
  const root = project();
  assert.equal(JSON.parse(readFileSync(join(root, 'saihai.config.json'), 'utf8')).guard, true);
});
