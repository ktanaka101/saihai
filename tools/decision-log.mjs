#!/usr/bin/env node
// 判断ログ（G8）。実装する AI は、報告条件に当たらない判断を自分で決め、ここに記録して先に進む。
// 人は全部を読まない。解釈区間で、抽出された重要な判断だけを見る（G6.1）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { localDate } from './date.mjs';

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url));
const KINDS = ['判断', 'バックブリーフ', '報告', '確認'];
const RELATIONS = ['従った', '逸脱', '仮置きの変更', '指摘', '該当なし'];
const REVERSIBILITY = ['容易', '困難'];
const RULE = 'G8.E3';
const PATH_LABEL = 'decisions/log.jsonl';

export const decisionsPathOf = (goalsDir) => join(goalsDir, '..', 'decisions', 'log.jsonl');

export function parseDecisions(text) {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, t }))
    .filter(({ t }) => t.trim())
    .map(({ line, t }) => {
      try {
        return { line, value: JSON.parse(t) };
      } catch {
        return { line, value: null };
      }
    });
}

export function loadDecisions(goalsDir) {
  const path = decisionsPathOf(goalsDir);
  return existsSync(path) ? parseDecisions(readFileSync(path, 'utf8')) : [];
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const stringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function entryProblems(e, goalIds) {
  const problems = [];
  if (!/^D\d+$/.test(e.id ?? '')) problems.push('id は D{番号} にしてください');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? '')) problems.push(`date「${e.date}」は YYYY-MM-DD の形にしてください`);
  if (!goalIds.includes(e.goal)) problems.push(`goal「${e.goal}」に当たるゴールがありません`);
  if (!KINDS.includes(e.kind)) problems.push(`kind「${e.kind}」は ${KINDS.join('・')} のどれかにしてください`);
  if (e.kind === '判断') {
    for (const key of ['decision', 'reason']) if (!nonEmpty(e[key])) problems.push(`${key} が要ります`);
    if (typeof e.rejected !== 'string') problems.push('rejected が要ります（なければ ―）');
    if (!stringArray(e.related)) problems.push('related は ID の配列にしてください');
    if (!stringArray(e.impact)) problems.push('impact は配列にしてください');
    if (!RELATIONS.includes(e.relation)) problems.push(`relation「${e.relation}」は ${RELATIONS.join('・')} のどれかにしてください`);
    if (!REVERSIBILITY.includes(e.reversibility)) problems.push(`reversibility「${e.reversibility}」は ${REVERSIBILITY.join('・')} のどちらかにしてください`);
  }
  if (e.kind === 'バックブリーフ' && !nonEmpty(e.decision)) problems.push('decision（解釈の要約）が要ります');
  if (e.kind === '報告') for (const key of ['decision', 'reason']) if (!nonEmpty(e[key])) problems.push(`${key} が要ります`);
  if (e.kind === '確認' && !(stringArray(e.targets) && e.targets.length)) problems.push('targets（確認した ID の配列）が要ります');
  return problems;
}

export function checkDecisions(parsed, goalIds) {
  const ids = parsed.map((p) => p.value?.id).filter(Boolean);
  const seen = new Set();
  const violation = (message) => ({ path: PATH_LABEL, rule: RULE, message });
  return parsed.flatMap(({ line, value }) => {
    if (value === null || typeof value !== 'object') return [violation(`${line} 行目が JSON として読めません`)];
    const label = value.id ?? `${line} 行目`;
    const duplicate = seen.has(value.id) ? [violation(`${value.id} が重複しています`)] : [];
    seen.add(value.id);
    const missingTargets =
      value.kind === '確認' && stringArray(value.targets)
        ? value.targets.filter((t) => !ids.includes(t)).map((t) => violation(`${label} の確認の対象 ${t} が判断ログにありません`))
        : [];
    const problems = entryProblems(value, goalIds);
    return [...duplicate, ...(problems.length ? [violation(`${label}：${problems.join('、')}`)] : []), ...missingTargets];
  });
}

const goalIdsIn = (goalsDir) =>
  readdirSync(goalsDir)
    .map((name) => name.match(/^(G\d+(?:\.\d+)*)-.*\.md$/)?.[1])
    .filter(Boolean);

// 通し番号と今日の日付を付けて1件足す。項目が足りなければ書かずに失敗する（G8.E4）
export function appendDecision({ goalsDir = join(REPO_DIR, 'goals'), decisionsPath = decisionsPathOf(goalsDir), entry, today = localDate() }) {
  const existing = existsSync(decisionsPath) ? parseDecisions(readFileSync(decisionsPath, 'utf8')) : [];
  const numbers = existing.map((p) => Number(p.value?.id?.match(/^D(\d+)$/)?.[1] ?? 0));
  const full = { ...entry, id: `D${Math.max(0, ...numbers) + 1}`, date: today };
  const problems = entryProblems(full, goalIdsIn(goalsDir));
  const knownIds = existing.map((p) => p.value?.id);
  const missing = full.kind === '確認' && stringArray(full.targets) ? full.targets.filter((t) => !knownIds.includes(t)) : [];
  if (problems.length || missing.length) {
    throw new Error([...problems, ...missing.map((t) => `確認の対象 ${t} が判断ログにありません`)].join('、'));
  }
  mkdirSync(dirname(decisionsPath), { recursive: true });
  appendFileSync(decisionsPath, `${JSON.stringify(full)}\n`);
  return full;
}

const USAGE = [
  '使い方：saihai log --goal <ID> --kind 判断 --decision "何を決めたか" --related "G7.1.E2,J47" --reason "なぜ"',
  '        --rejected "退けた案と理由" --relation 従った|逸脱|仮置きの変更|指摘|該当なし --reversibility 容易|困難 --impact "データ形式,利用者の体験"',
  '        （バックブリーフ・報告は --goal --kind --decision [--reason]、確認は --goal --kind 確認 --targets "D3,D4"）',
].join('\n');

const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function run({ argv = [], goalsDir = join(REPO_DIR, 'goals'), decisionsPath = decisionsPathOf(goalsDir) } = {}) {
  try {
    const keys = ['goal', 'kind', 'decision', 'related', 'reason', 'rejected', 'relation', 'reversibility', 'impact', 'targets', 'note'];
    const { values: v } = parseArgs({ args: argv, options: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])) });
    if (!v.goal || !v.kind || (v.kind !== '確認' && !v.decision)) return { code: 1, out: '', err: `${USAGE}\n` };
    const entry =
      v.kind === '判断'
        ? { goal: v.goal, kind: v.kind, decision: v.decision, related: list(v.related), reason: v.reason, rejected: v.rejected ?? '―', relation: v.relation, reversibility: v.reversibility, impact: list(v.impact) }
        : v.kind === '確認'
          ? { goal: v.goal, kind: v.kind, targets: list(v.targets), ...(v.note ? { note: v.note } : {}) }
          : { goal: v.goal, kind: v.kind, decision: v.decision, ...(v.reason ? { reason: v.reason } : {}) };
    const saved = appendDecision({ goalsDir, decisionsPath, entry });
    return { code: 0, out: `${saved.id} を判断ログに記録しました（${saved.kind}${saved.decision ? `：${saved.decision}` : ''}）\n`, err: '' };
  } catch (error) {
    return { code: 1, out: '', err: `${error.message}\n${USAGE}\n` };
  }
}

// 受信箱の事後確認を見たら、まとめて確認済みにする（人の手間を1回にする）。確認はゴールの根（parent が null）に記録する
function rootGoalId(goalsDir) {
  for (const name of readdirSync(goalsDir).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(join(goalsDir, name), 'utf8');
    if (/^parent:\s*null\s*$/m.test(text)) return text.match(/^id:\s*(\S+)\s*$/m)?.[1];
  }
  return undefined;
}

export function confirmReviews({ goalsDir, decisionsPath = decisionsPathOf(goalsDir), ids, today }) {
  const goal = rootGoalId(goalsDir);
  if (!goal) throw new Error('ゴールの根（parent: null のゴール文書）が見つかりません');
  return appendDecision({ goalsDir, decisionsPath, entry: { goal, kind: '確認', targets: ids }, ...(today ? { today } : {}) });
}

export function runConfirm({ argv = [], goalsDir = join(REPO_DIR, 'goals') } = {}) {
  const ids = argv.flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
  if (ids.length === 0) return { code: 1, out: '', err: '使い方：saihai confirm D3 D6（受信箱の事後確認を見たら、まとめて確認済みにする）\n' };
  try {
    const saved = confirmReviews({ goalsDir, ids });
    return { code: 0, out: `${ids.join('・')} を確認済みにしました（${saved.id}）\n`, err: '' };
  } catch (error) {
    return { code: 1, out: '', err: `${error.message}\n` };
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
  const { code, out, err } = run({ argv: process.argv.slice(2) });
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}
