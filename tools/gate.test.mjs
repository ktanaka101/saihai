import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate } from './gate.mjs';

// テストの一時リポジトリでは、利用者の git フックを動かさない
const HOOKLESS = ['-c', 'core.hooksPath=/dev/null'];

function setupRepo({ withRemote = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'saihai-gate-test-'));
  const repo = join(base, 'repo');
  const git = (cwd, ...args) => {
    const r = spawnSync('git', [...HOOKLESS, ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (file, content, message) => {
    writeFileSync(join(repo, file), content);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', message);
  };
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commit('base.txt', 'base\n', 'base');
  if (withRemote) {
    git(base, 'init', '-q', '--bare', join(base, 'remote.git'));
    git(repo, 'remote', 'add', 'origin', join(base, 'remote.git'));
    git(repo, 'push', '-q', 'origin', 'main');
  }
  git(repo, 'checkout', '-q', '-b', 'work/x');
  commit('feature.txt', 'feature\n', 'feature');
  return { base, repo, git, commit };
}

const pass = { name: '通る検査', cmd: [process.execPath, '-e', 'process.exit(0)'] };
const fail = { name: '落ちる検査', cmd: [process.execPath, '-e', 'console.error("理由の説明"); process.exit(1)'] };
const needs = (file) => ({ name: `${file} がある`, cmd: [process.execPath, '-e', `require('fs').accessSync(${JSON.stringify(file)})`] });
const gate = (repo, checks) => runGate({ repoDir: repo, checks, gitConfig: HOOKLESS });

test('すべて通れば、人の操作なしで main に反映し、push する（E2）', () => {
  const { base, repo, git } = setupRepo();
  const r = gate(repo, [pass, needs('feature.txt')]);
  assert.equal(r.code, 0, r.summary);
  assert.match(r.summary, /main に反映しました/);
  assert.equal(git(repo, 'show', 'main:feature.txt'), 'feature');
  assert.equal(git(join(base, 'remote.git'), 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'));
});

test('作業ブランチ単体ではなく、最新の main とマージした結果を検査する（E1）', () => {
  const { repo, git, commit } = setupRepo();
  git(repo, 'checkout', '-q', 'main');
  commit('main-only.txt', 'main\n', 'main moves on');
  git(repo, 'checkout', '-q', 'work/x');
  const r = gate(repo, [needs('feature.txt'), needs('main-only.txt')]);
  assert.equal(r.code, 0, r.summary);
});

test('1つでも落ちれば反映せず、落ちた検査と理由を報告する（E3）', () => {
  const { base, repo, git } = setupRepo();
  const before = git(repo, 'rev-parse', 'main');
  const r = gate(repo, [pass, fail]);
  assert.equal(r.code, 1);
  assert.match(r.summary, /反映していません/);
  assert.match(r.summary, /失敗：落ちる検査/);
  assert.match(r.summary, /理由の説明/);
  assert.equal(git(repo, 'rev-parse', 'main'), before);
  assert.equal(git(join(base, 'remote.git'), 'rev-parse', 'main'), before);
});

test('未コミットの変更があれば動かない', () => {
  const { repo, git } = setupRepo();
  const before = git(repo, 'rev-parse', 'main');
  writeFileSync(join(repo, 'dirty.txt'), 'x');
  const r = gate(repo, [pass]);
  assert.equal(r.code, 1);
  assert.match(r.summary, /未コミット/);
  assert.equal(git(repo, 'rev-parse', 'main'), before);
});

test('main の上では動かない', () => {
  const { repo, git } = setupRepo();
  git(repo, 'checkout', '-q', 'main');
  const r = gate(repo, [pass]);
  assert.equal(r.code, 1);
  assert.match(r.summary, /作業ブランチ/);
});

test('main とマージできない（衝突する）ときは反映しない', () => {
  const { repo, git, commit } = setupRepo();
  commit('base.txt', 'work side\n', 'work edits base');
  git(repo, 'checkout', '-q', 'main');
  commit('base.txt', 'main side\n', 'main edits base');
  const before = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', 'work/x');
  const r = gate(repo, [pass]);
  assert.equal(r.code, 1);
  assert.match(r.summary, /衝突/);
  assert.equal(git(repo, 'rev-parse', 'main'), before);
});

test('終わったら一時 worktree を片づける', () => {
  const { repo, git } = setupRepo();
  gate(repo, [pass]);
  gate(repo, [fail]);
  const worktrees = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
  assert.equal(worktrees.length, 1);
});

test('push に失敗したら、そのことを報告する（main は手元で更新済み）', () => {
  const { repo, git } = setupRepo({ withRemote: false });
  const r = gate(repo, [pass]);
  assert.equal(r.code, 1);
  assert.match(r.summary, /push に失敗/);
  assert.equal(git(repo, 'show', 'main:feature.txt'), 'feature');
});
