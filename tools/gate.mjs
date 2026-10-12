#!/usr/bin/env node
// マージの門番（G5）。作業ブランチを最新の main とマージした結果で検査し、すべて通れば main に反映して push する。
// main には、マージした結果で検査を通ったものだけが入る（Not Rocket Science Rule）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './eval-goals.mjs';

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_TAIL_LINES = 30;

// 検査はマージした結果の worktree の中で、その中のツールを使って実行する
const DEFAULT_CHECKS = [
  { name: 'ゴール文書の検査', cmd: [process.execPath, 'tools/check-goals.mjs'] },
  { name: 'テスト', cmd: ['npm', 'test', '--silent'] },
  ...Object.keys(TARGETS).map((target) => ({ name: `隠しシナリオ（${target}）`, cmd: [process.execPath, 'tools/eval-hidden.mjs', 'run', target] })),
  { name: '監査（保管場所への許可された接触がない）', cmd: [process.execPath, 'tools/eval-hidden.mjs', 'audit'] },
];

const tail = (text) => text.trim().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');

export function runGate({ repoDir = REPO_DIR, checks = DEFAULT_CHECKS, mainBranch = 'main', remote = 'origin', gitConfig = [] } = {}) {
  const git = (cwd, ...args) => spawnSync('git', [...gitConfig, ...args], { cwd, encoding: 'utf8' });
  const ok = (r) => r.status === 0;
  const refuse = (summary) => ({ code: 1, summary });

  const branch = git(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  if (branch === mainBranch) return refuse(`${mainBranch} の上では門番を動かせません。作業ブランチ（work/<名前>）に切り替えてください`);
  if (git(repoDir, 'status', '--porcelain').stdout.trim()) return refuse('未コミットの変更があります。作業ブランチにコミットしてから門番を動かしてください');
  const before = git(repoDir, 'rev-parse', mainBranch).stdout.trim();

  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'saihai-gate-'));
  try {
    if (!ok(git(repoDir, 'worktree', 'add', '-q', '--detach', dir, mainBranch))) return refuse('一時 worktree を作れませんでした');
    const message = `Merge ${branch} (門番を通過)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
    if (!ok(git(dir, 'merge', '-q', '--no-ff', '-m', message, branch))) {
      git(dir, 'merge', '--abort');
      return refuse(`${branch} を ${mainBranch} とマージできません（衝突）。作業ブランチに ${mainBranch} を取り込んでから、もう一度動かしてください`);
    }

    const results = checks.map((check) => {
      const r = spawnSync(check.cmd[0], check.cmd.slice(1), { cwd: dir, encoding: 'utf8' });
      return { name: check.name, passed: r.status === 0, output: tail(`${r.stdout ?? ''}${r.stderr ?? ''}`) };
    });
    const lines = results.map((r) => `- ${r.passed ? '通過' : '失敗'}：${r.name}`);
    const failed = results.filter((r) => !r.passed);
    if (failed.length) {
      return refuse(
        [`門番で落ちたため、${mainBranch} には反映していません。`, ...lines, ...failed.flatMap((f) => ['', `「${f.name}」の出力（末尾）：`, f.output])].join('\n'),
      );
    }

    // 門番の実行中に main が動いていたら、反映を取りやめる
    const merged = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    if (!ok(git(repoDir, 'update-ref', `refs/heads/${mainBranch}`, merged, before))) {
      return refuse(`${mainBranch} が門番の実行中に変わったため、反映を取りやめました。もう一度動かしてください`);
    }
    const pushed = ok(git(repoDir, 'push', '-q', remote, mainBranch));
    return {
      code: pushed ? 0 : 1,
      summary: [
        `門番を通過し、${branch} を ${mainBranch} に反映しました（${merged.slice(0, 7)}）。`,
        ...lines,
        pushed ? `${remote} に push しました。` : `${remote} への push に失敗しました（${mainBranch} は手元で更新済み）。`,
      ].join('\n'),
    };
  } finally {
    git(repoDir, 'worktree', 'remove', '--force', dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, summary } = runGate();
  process.stdout.write(`${summary}\n`);
  process.exitCode = code;
}
