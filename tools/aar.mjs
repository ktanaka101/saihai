#!/usr/bin/env node
// 事後検証（AAR）の材料（G6.1.E4）。何が起きるはずで、何が起きたかを、仮説・判定・判断ログからまとめる。
// 「なぜ違ったか」「次にどうするか」は参謀が interpret スキルの手順で書く。
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGoals, section } from './check-goals.mjs';
import { loadDecisions } from './decision-log.mjs';
import { reviewReasons, titleOf } from './inbox.mjs';
import { observeAll } from './observe.mjs';

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url));
const bullets = (lines) => (lines ?? []).filter((l) => l.startsWith('- '));

export function buildAAR({ goal, verdict, decisions }) {
  const id = goal.frontmatter.id;
  const mine = decisions.filter((d) => d.goal === id);
  const judgments = mine.filter((d) => d.kind === '判断');
  const notable = judgments.filter((d) => reviewReasons(d).length > 0);
  const reports = mine.filter((d) => d.kind === '報告');
  return [
    `# 事後検証の材料：${titleOf(goal)}`,
    '',
    '> 「なぜ違ったか」「次にどうするか」は参謀が書き、ゴール文書の AI 層の「### 事後検証」に日付つきで残す（interpret スキル）。次にどうするかは、判断待ちとして上申する。',
    '',
    '## 起きるはずだったこと',
    '',
    ...bullets(section(goal.human, '意図')).filter((l) => l.startsWith('- 望ましい最終状態：')),
    ...bullets(section(goal.human, '仮説と判定')),
    '',
    '## 起きたこと',
    '',
    `- 仮説の判定：${verdict?.verdict ?? '判定なし'}${verdict?.basis ? `（${verdict.basis}）` : ''}`,
    `- 判断ログ：判断 ${judgments.length} 件、うち事後確認の対象 ${notable.length} 件、報告 ${reports.length} 件`,
    ...notable.map((d) => `  - ${d.id}（${reviewReasons(d).join('・')}）：${d.decision}`),
    ...reports.map((d) => `  - ${d.id}（報告）：${d.decision}`),
    '',
    '## なぜ違ったか（参謀が書く）',
    '',
    '- ',
    '',
    '## 次にどうするか（参謀が書く。続行・修正・方向転換・中止・新しいゴールのどれかを、判断待ちとして上申する）',
    '',
    '- ',
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
  const id = process.argv[2];
  try {
    if (!id) throw new Error('使い方：npm run aar -- <ゴールの ID>');
    const goalsDir = join(REPO_DIR, 'goals');
    const goals = loadGoals(goalsDir);
    const goal = goals.find((g) => g.frontmatter?.id === id);
    if (!goal) throw new Error(`ゴール ${id} が見つかりません`);
    const decisions = loadDecisions(goalsDir)
      .map((p) => p.value)
      .filter(Boolean);
    const { verdicts } = observeAll({ goals });
    process.stdout.write(buildAAR({ goal, verdict: verdicts.find((v) => v.goal === id), decisions }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
