import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandOf, findRoot, readConfig, transcriptsDirOf } from './root.mjs';

const project = (marker) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'saihai-root-')));
  if (marker === 'config') writeFileSync(join(dir, 'saihai.config.json'), '{}');
  if (marker === 'goal') {
    mkdirSync(join(dir, 'goals'));
    writeFileSync(join(dir, 'goals', 'G0-x.md'), '');
  }
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  return dir;
};

test('findRoot: --root がいちばん強く、次に SAIHAI_ROOT（G9.E1）', () => {
  const a = project('config');
  const b = project('config');
  assert.equal(findRoot({ argv: ['--root', a], env: { SAIHAI_ROOT: b }, cwd: '/' }).root, a);
  assert.equal(findRoot({ argv: [], env: { SAIHAI_ROOT: b }, cwd: '/' }).root, b);
});

test('findRoot: 今のフォルダから上へ、saihai.config.json か goals/G0-*.md がある最初のフォルダを探す（G9.E1）', () => {
  const a = project('config');
  const b = project('goal');
  assert.equal(findRoot({ argv: [], env: {}, cwd: join(a, 'src', 'deep') }).root, a);
  assert.equal(findRoot({ argv: [], env: {}, cwd: join(b, 'src') }).root, b);
});

test('findRoot: 見つからなければ null。--root は取り除いた引数を返す', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'saihai-root-none-')));
  assert.equal(findRoot({ argv: [], env: {}, cwd: dir }).root, null);
  const a = project('config');
  assert.deepEqual(findRoot({ argv: ['G1', '--root', a, '--x'], env: {}, cwd: '/' }).argv, ['G1', '--x']);
  assert.deepEqual(findRoot({ argv: [`--root=${a}`, 'G1'], env: {}, cwd: '/' }), { root: a, argv: ['G1'] });
});

test('transcriptsDirOf: Claude Code の作業記録のフォルダは、ルートのパスの記号を - にした名前', () => {
  assert.equal(transcriptsDirOf('/Users/a/codes/my_app', '/home'), '/home/.claude/projects/-Users-a-codes-my-app');
});

test('readConfig: saihai.config.json を読む。なければ空', () => {
  const a = project('config');
  writeFileSync(join(a, 'saihai.config.json'), '{"probes":{}}');
  assert.deepEqual(readConfig(a), { probes: {} });
  assert.deepEqual(readConfig(project('goal')), {});
});

test('commandOf: 設定の command（init が書く呼び方）。なければ saihai', () => {
  const a = project('config');
  writeFileSync(join(a, 'saihai.config.json'), '{"command":"node bin/saihai.mjs"}');
  assert.equal(commandOf(a), 'node bin/saihai.mjs');
  assert.equal(commandOf(project('goal')), 'saihai');
});

test('findRoot: 指定されたフォルダがなければ、ルートにせず理由を返す（打ち間違いで別の場所に書かないように）', () => {
  const r = findRoot({ argv: ['--root', '/nonexistent/saihai-typo'], env: {}, cwd: '/' });
  assert.equal(r.root, null);
  assert.match(r.error, /ありません/);
  assert.match(findRoot({ argv: [], env: { SAIHAI_ROOT: '/nonexistent/x' }, cwd: '/' }).error, /SAIHAI_ROOT/);
});

test('findRoot: 上のフォルダに goals という名前のファイルがあっても落ちない', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'saihai-root-file-')));
  writeFileSync(join(dir, 'goals'), '');
  mkdirSync(join(dir, 'sub'));
  assert.equal(findRoot({ argv: [], env: {}, cwd: join(dir, 'sub') }).root, null);
});
