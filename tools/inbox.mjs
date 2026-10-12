#!/usr/bin/env node
// 受信箱（G6.1）。人が開くのはここだけ。いま判断すべきことを5件まで、優先順に並べる。
// 優先順：止まって待っている報告 → 判断待ち → 仮説の外れと矛盾 → 判断ログの事後確認（J66）
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNoHypothesis, listItems, loadGoals, section } from './check-goals.mjs';
import { loadDecisions } from './decision-log.mjs';
import { observeAll } from './observe.mjs';
import { commandOf } from './root.mjs';

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url));
const LIMIT = 5; // 一度に出すのは5件まで（J45・G6.1 の不変条件）
const REVIEW_RELATIONS = ['逸脱', '仮置きの変更', '指摘'];
const STAGES = ['ゴール設定', '実装', '観測', '解釈待ち', '完了'];
const RECOMMENDED = /^\s*[-*]\s*(\*\*)?推奨(\*\*)?：/;

export const titleOf = (goal) => goal.human.find((l) => l.startsWith('# '))?.slice(2) ?? goal.frontmatter?.id;

// 事後確認に上げる判断：逸脱・仮置きの変更・指摘、戻しにくいもの、どの ID にも紐づかないもの（G6.1.E3）
export function reviewReasons(d) {
  return [
    ...(REVIEW_RELATIONS.includes(d.relation) ? [d.relation] : []),
    ...(d.reversibility === '困難' ? ['戻しにくい'] : []),
    ...(!(d.related?.length > 0) ? ['どこにも紐づかない'] : []),
  ];
}

export function collectInboxItems({ goals, decisions, verdicts, command = 'saihai' }) {
  const confirmed = new Set(decisions.filter((d) => d.kind === '確認').flatMap((d) => d.targets ?? []));
  const open = (d) => !confirmed.has(d.id);
  const confirm = (d) => `${command} log --goal ${d.goal} --kind 確認 --targets ${d.id}`;
  const reports = decisions
    .filter((d) => d.kind === '報告' && open(d))
    .map((d) => ({ kind: '報告', goal: d.goal, id: d.id, title: d.decision, detail: `理由：${d.reason ?? ''}`, action: `答えたら：${confirm(d)}` }));
  const pending = goals.flatMap((g) =>
    g.pending.map((q) => ({
      kind: '判断待ち',
      goal: g.frontmatter.id,
      id: q.id,
      title: q.heading.replace(/^### Q\d+\s*/, ''),
      detail: `推奨：${q.lines.find((l) => RECOMMENDED.test(l))?.replace(RECOMMENDED, '') ?? '（なし）'}`,
      action: `答える：${command} answer ${q.id} 推奨（自明な案を選ぶなら「自明な案」、ほかの答えなら --text "…"）`,
    })),
  );
  const hypotheses = verdicts
    .filter((v) => v.verdict === '外れ' || v.verdict === '矛盾')
    .map((v) => ({ kind: '仮説', goal: v.goal, id: v.goal, title: `仮説が${v.verdict}：${v.hypothesis}`, detail: `根拠：${v.basis}`, action: `事後検証の材料：${command} aar ${v.goal}` }));
  // その判断を関連に挙げた後の判断（指摘への対応など）を添える
  const followUps = (d) => decisions.filter((x) => x.id !== d.id && (x.related ?? []).includes(d.id)).map((x) => x.id);
  const reviews = decisions
    .filter((d) => d.kind === '判断' && open(d) && reviewReasons(d).length > 0)
    .map((d) => {
      const after = followUps(d);
      const detail = `${reviewReasons(d).join('・')}。理由：${d.reason}${after.length ? `。対応：${after.join('・')}` : ''}`;
      return { kind: '事後確認', goal: d.goal, id: d.id, title: d.decision, detail, action: `見たら：${confirm(d)}` };
    });
  return [...reports, ...pending, ...hypotheses, ...reviews];
}

const hasAAR = (goal) => (goal.ai ?? []).some((l) => /^### 事後検証/.test(l));

// ゴールの段階（G6.1.E2）
export function stageOf(goal, verdict) {
  const status = goal.frontmatter?.status;
  if (status === '中止') return '完了';
  // 達成したゴールの判断待ちは、ゴール設定ではなく解釈の続き（仮説の判定を人に求めるなど）
  if (status === '達成' && goal.pending.length > 0) return '解釈待ち';
  if (status === '議論中' || goal.pending.length > 0) return 'ゴール設定';
  if (status === '進行中') return '実装';
  const hypothesis = (section(goal.human, '仮説と判定') ?? []).find((l) => l.startsWith('- 仮説：')) ?? '';
  if (!hypothesis || isNoHypothesis(hypothesis)) return '完了';
  if (!['当たり', '外れ', '矛盾', '人が判定'].includes(verdict?.verdict)) return '観測';
  return hasAAR(goal) ? '完了' : '解釈待ち';
}

// 残っている仮置き（制約と判例）。放っておくと実質的な不変条件になるので、数を出して見直しを促す（G6.1.E5）
export function countProvisional(goals) {
  return goals.reduce(
    (n, g) => n + listItems(section(g.human, '仮置き')).length + g.judgments.filter((j) => j.strength === '仮置き').length,
    0,
  );
}

// 古い仮置き（J の番号の小さい順）。放っておくと実質的な不変条件になるので、項目で見せる（G6.2.E5）
export function oldestProvisional(goals, n = 3) {
  return goals
    .flatMap((g) => g.judgments.filter((j) => j.strength === '仮置き').map((j) => ({ id: j.id, goal: g.frontmatter.id, text: j.cells[2] ?? '' })))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
    .slice(0, n);
}

const short = (text, n = 50) => (text.length > n ? `${text.slice(0, n)}…` : text);

export function renderInbox({ items, stages, provisional, oldest = [], limit = LIMIT }) {
  const shown = items.slice(0, limit);
  const rest = items.slice(limit);
  const restKinds = [...new Set(rest.map((i) => i.kind))].map((k) => `${k} ${rest.filter((i) => i.kind === k).length} 件`);
  const byStage = STAGES.map((s) => [s, stages.filter((x) => x.stage === s)]).filter(([, xs]) => xs.length > 0);
  return [
    '# 受信箱',
    '',
    `## いま判断すべきこと（${items.length} 件${items.length > limit ? `中 ${limit} 件` : ''}）`,
    '',
    ...(shown.length
      ? shown.flatMap((i, n) => [`${n + 1}. [${i.kind}] ${i.goal} ${i.id === i.goal ? '' : `${i.id}：`}${i.title}`, `   ${i.detail}`, `   → ${i.action}`])
      : ['いま判断すべきことはありません。']),
    ...(rest.length ? ['', `ほかに ${rest.length} 件（${restKinds.join('・')}）`] : []),
    '',
    '## ゴールの段階',
    '',
    ...byStage.map(([s, xs]) => `- ${s}：${xs.map((x) => `${x.goal}（${x.title.replace(/^\S+\s/, '')}）`).join('、')}`),
    '',
    '## 見直し',
    '',
    `- 残っている仮置き ${provisional} 件（推奨を採用しただけの判断を含む）。事後検証のときに見直す`,
    ...(oldest.length ? ['- 古いものから：', ...oldest.map((p) => `  - ${p.id}（${p.goal}）：${short(p.text)}`)] : []),
    '',
  ].join('\n');
}

export function inbox({ root = REPO_DIR, goalsDir = join(root, 'goals'), observe = observeAll, command = commandOf(root) } = {}) {
  const goals = loadGoals(goalsDir);
  const decisions = loadDecisions(goalsDir)
    .map((p) => p.value)
    .filter(Boolean);
  const { verdicts } = observe({ goals, repoDir: root });
  const stages = goals.map((g) => ({ goal: g.frontmatter.id, title: titleOf(g), stage: stageOf(g, verdicts.find((v) => v.goal === g.frontmatter.id)) }));
  return renderInbox({ items: collectInboxItems({ goals, decisions, verdicts, command }), stages, provisional: countProvisional(goals), oldest: oldestProvisional(goals) });
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function run({ root = REPO_DIR } = {}) {
  try {
    return { code: 0, out: inbox({ root }), err: '' };
  } catch (error) {
    return { code: 1, out: '', err: `受信箱を作れませんでした：${error.message}\n` };
  }
}

if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, out, err } = run();
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}
