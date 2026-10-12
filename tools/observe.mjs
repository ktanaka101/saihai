#!/usr/bin/env node
// 現実からの観測（G7）。最初は saihai 自身を観測する（J47）。
// どの数値にも、出どころと関わるゴールの具体例の ID を付ける（GQM：目的につながらない数値は集めない）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGoals } from './check-goals.mjs';
import { TARGETS } from './eval-goals.mjs';
import { runHidden } from './eval-hidden.mjs';

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url));
const GOALS_DIR = join(REPO_DIR, 'goals');
const TRANSCRIPTS_DIR = join(homedir(), '.claude', 'projects', REPO_DIR.replace(/\/$/, '').replace(/[^a-zA-Z0-9]/g, '-'));
const ADOPTED = '推奨を採用（J37）';
const TOO_FEW = 5; // これ未満の件数の指標は、G6 で「まだ判断できない」とする（J51）

const metric = (name, value, count, source, examples) => ({ name, value, count, source, examples });
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function collectGoalMetrics(goals) {
  const statuses = ['達成', '進行中', '議論中', '中止']
    .map((s) => [s, goals.filter((g) => g.frontmatter?.status === s).length])
    .filter(([, n]) => n > 0);
  const judgments = goals.flatMap((g) => g.judgments);
  const isAdopted = (j) => (j.cells[2] ?? '').includes(ADOPTED);
  const adopted = judgments.filter(isAdopted).length;
  const asked = judgments.filter((j) => !isAdopted(j) && j.from.length > 0).length;
  const conversation = judgments.length - adopted - asked;
  const withJudgments = goals.filter((g) => g.judgments.length > 0).length;
  const pending = goals.reduce((n, g) => n + g.pending.length, 0);
  return [
    metric('ゴールの状態', statuses.map(([s, n]) => `${s} ${n}`).join('・') || 'なし', goals.length, 'ゴール文書', ['G0.E11']),
    metric('判断の内訳', `人が答えた ${asked}・会話で決まった ${conversation}・推奨を採用 ${adopted}`, judgments.length, 'ゴール文書の判例', ['G7.E3']),
    metric('1ゴールあたりの人の判断', withJudgments ? ((asked + conversation) / withJudgments).toFixed(1) : '0.0', withJudgments, 'ゴール文書の判例', ['G7.E3']),
    metric('判断待ち', String(pending), pending, 'ゴール文書', ['G1.E11', 'G6.E5']),
  ];
}

export function collectGitMetrics(repoDir, goals) {
  const git = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  const lines = (r) => (r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : []);
  const gateRuns = lines(git('log', '--format=%s', '--grep=門番を通過')).length;
  const hours = goals
    .filter((g) => g.frontmatter?.status === '達成')
    .flatMap((g) => {
      const created = lines(git('log', '--diff-filter=A', '--format=%cI', '--', g.path)).at(-1);
      const achieved = lines(git('log', '--format=%cI', '-S', 'status: 達成', '--', g.path)).at(-1);
      return created && achieved ? [(Date.parse(achieved) - Date.parse(created)) / 3_600_000] : [];
    });
  return [
    metric('門番の通過', `${gateRuns} 回`, gateRuns, 'git の履歴', ['G5.E2']),
    metric('文書ができてから達成まで', hours.length ? `中央値 ${median(hours).toFixed(1)} 時間` : '達成したゴールなし', hours.length, 'git の履歴', ['G2.E1']),
  ];
}

function listJsonl(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listJsonl(path) : name.endsWith('.jsonl') ? [path] : [];
  });
}

// 作業記録からは件数だけを取り、内容は取らない（J48）
export function collectTranscriptMetrics(transcriptsDir) {
  const source = '作業記録（件数のみ）';
  if (!existsSync(transcriptsDir)) {
    return [
      metric('人の発言', '作業記録なし', 0, source, ['G7.E3', 'G7.E4']),
      metric('人への質問', '作業記録なし', 0, source, ['G3.2.E5', 'G6.E5']),
      metric('推奨どおりの回答', '作業記録なし', 0, source, ['G2.E1', 'G6.E5']),
    ];
  }
  const entries = listJsonl(transcriptsDir).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      }),
  );
  const isToolResult = (e) => Array.isArray(e.message?.content) && e.message.content[0]?.type === 'tool_result';
  const human = entries.filter((e) => e.type === 'user' && !e.isMeta && !isToolResult(e) && (e.origin?.kind === 'human' || e.turnOrigin === 'human')).length;
  const asks = entries
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
    .filter((c) => c.type === 'tool_use' && c.name === 'AskUserQuestion');
  const questions = asks.reduce((n, a) => n + (a.input?.questions?.length ?? 0), 0);
  // 回答の選択肢に「（推奨）」が付いているかだけを数える。回答の中身は取らない（J48）
  const answers = entries
    .filter((e) => e.type === 'user' && Array.isArray(e.message?.content))
    .flatMap((e) => e.message.content)
    .filter((c) => c.type === 'tool_result' && typeof c.content === 'string' && c.content.includes('questions have been answered'))
    .flatMap((c) => [...c.content.matchAll(/="([^"]*)"/g)].map((m) => m[1].includes('（推奨）')));
  return [
    metric('人の発言', String(human), human, source, ['G7.E3', 'G7.E4']),
    metric('人への質問', `${asks.length} 回（問い ${questions} 件）`, asks.length, source, ['G3.2.E5', 'G6.E5']),
    metric('推奨どおりの回答', `${answers.length} 件中 ${answers.filter(Boolean).length} 件`, answers.length, source, ['G2.E1', 'G6.E5']),
  ];
}

function collectHiddenMetrics(hidden) {
  return Object.keys(TARGETS).map((target) => {
    let r;
    try {
      r = hidden(target);
    } catch {
      r = {};
    }
    const total = r.total ?? 0;
    return metric(`隠しシナリオ（${target}）`, total ? `${total} 件中 ${total - r.failed} 件が通過` : '隠しシナリオなし', total, '評価の結果', ['G3.3.E3']);
  });
}

export function observe({
  goals = loadGoals(GOALS_DIR),
  repoDir = REPO_DIR,
  transcriptsDir = TRANSCRIPTS_DIR,
  hidden = (targetName) => runHidden({ targetName }),
} = {}) {
  return [
    ...collectGoalMetrics(goals),
    ...collectGitMetrics(repoDir, goals),
    ...collectHiddenMetrics(hidden),
    ...collectTranscriptMetrics(transcriptsDir),
    // G0.E9 は、記録する仕組みがまだないので観測できない。観測できないことも報告する
    metric('実装後に見つかった既知の落とし穴', 'まだ観測できない（記録する仕組みがない）', 0, 'なし（未観測）', ['G0.E9']),
  ];
}

export function renderReport(metrics, now = new Date()) {
  return [
    `# saihai の観測（${now.toISOString().slice(0, 16).replace('T', ' ')} UTC）`,
    '',
    '| 指標 | 値 | 件数 | 出どころ | 具体例 | 判断に使えるか |',
    '|---|---|---|---|---|---|',
    ...metrics.map(
      (m) => `| ${m.name} | ${m.value} | ${m.count} | ${m.source} | ${m.examples.join('・')} | ${m.count >= TOO_FEW ? '使える' : 'まだ判断できない'} |`,
    ),
    '',
    `件数が${TOO_FEW}件未満の指標は「まだ判断できない」とし、解釈（G6）の候補にしない（J51）。`,
    '',
  ].join('\n');
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(renderReport(observe()));
}
