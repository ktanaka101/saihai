#!/usr/bin/env node
// Claude Code の PreToolUse フック（Bash）。main への直接のコミット・マージ・push を止める（G5.E5・J39）。
// main への反映は門番（npm run gate）が行う。門番は Claude Code の Bash を通さずに git を操作するので、ここでは止まらない。
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGE =
  'main への直接のコミット・マージ・push は止めています（J39）。作業ブランチ（work/<名前>）でコミットし、main への反映は npm run gate で行ってください。';

// ヒアドキュメントの本文と引用符の中身はデータなので取り除き、&& ; | などで区切った各コマンドを見る
function segments(command) {
  return command
    .split('<<')[0]
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function shouldBlock({ command, branch }) {
  let current = branch;
  for (const segment of segments(command)) {
    const m = segment.match(/^git\s+(?:-[cC]\s+\S+\s+)*([\w-]+)(.*)$/);
    if (!m) continue;
    const [, sub, rest] = m;
    if ((sub === 'checkout' || sub === 'switch') && /(^|\s)main(\s|$)/.test(rest)) current = 'main';
    if ((sub === 'commit' || sub === 'merge') && current === 'main') return true;
    if (sub === 'push' && (current === 'main' || /(^|\s)([^\s:]*:)?main(\s|$)/.test(rest))) return true;
  }
  return false;
}

function currentBranch(cwd) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

export function guard({ stdin, branchOf = currentBranch }) {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return { code: 0, err: '' };
  }
  if (input?.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') return { code: 0, err: '' };
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return shouldBlock({ command: input.tool_input.command, branch: branchOf(cwd) }) ? { code: 2, err: `${MESSAGE}\n` } : { code: 0, err: '' };
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, err } = guard({ stdin: readFileSync(0, 'utf8') });
  process.stderr.write(err);
  process.exitCode = code;
}
