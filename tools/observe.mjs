#!/usr/bin/env node
// 現実からの観測（G7・G7.1）。ゴールの仮説と判定（観測の式）から何を観測するかを決め、値を集めて判定する。
// どの数値にも、出どころと関わるゴールの具体例・仮説を付ける（GQM：目的につながらない数値は集めない）。
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkRepo, isAdoptedJudgment as isAdopted, isNoHypothesis, loadGoals, parseExpressions, section } from './check-goals.mjs';
import { checkDecisions, loadDecisions } from './decision-log.mjs';
import { TARGETS } from './eval-goals.mjs';
import { runHidden } from './eval-hidden.mjs';
import { readConfig, transcriptsDirOf } from './root.mjs';
import { MARKS } from './answer.mjs';

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url));
const TOO_FEW = 5; // これ未満の件数の指標は判定に使わない（J51）
const DEVIATIONS = ['逸脱', '仮置きの変更', '指摘'];

const metric = (name, value, count, source, examples, num) => ({ name, value, count, source, examples, ...(num === undefined ? {} : { num }) });
const fmt = (n) => String(Number(n.toFixed(2)));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const observationsPathOf = (repoDir) => join(repoDir, 'observations', 'log.jsonl');

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
}

// --- 組み込みの指標 ---

export function collectGoalMetrics(goals) {
  const statuses = ['達成', '進行中', '議論中', '中止']
    .map((s) => [s, goals.filter((g) => g.frontmatter?.status === s).length])
    .filter(([, n]) => n > 0);
  const judgments = goals.flatMap((g) => g.judgments);
  const adopted = judgments.filter(isAdopted).length;
  const asked = judgments.filter((j) => !isAdopted(j) && j.from.length > 0).length;
  const conversation = judgments.length - adopted - asked;
  const withJudgments = goals.filter((g) => g.judgments.length > 0).length;
  const perGoal = withJudgments ? (asked + conversation) / withJudgments : 0;
  const pending = goals.reduce((n, g) => n + g.pending.length, 0);
  // 後から置き換えられた判断。推奨どおりの割合が高くても、置き換えが多ければ推奨を過信している（J67）
  const replaced = new Set(judgments.flatMap((j) => (j.cells[5] ?? '').match(/J\d+/g) ?? []));
  const replacedCount = judgments.filter((j) => replaced.has(j.id)).length;
  const replacedRate = judgments.length ? replacedCount / judgments.length : 0;
  return [
    metric('ゴールの状態', statuses.map(([s, n]) => `${s} ${n}`).join('・') || 'なし', goals.length, 'ゴール文書', ['G0.E4']),
    metric('判断の内訳', `人が答えた ${asked}・会話で決まった ${conversation}・推奨を採用 ${adopted}`, judgments.length, 'ゴール文書の判例', ['G7.E3']),
    metric('1ゴールあたりの人の判断', perGoal.toFixed(1), withJudgments, 'ゴール文書の判例', ['G7.E3'], perGoal),
    metric('判断待ち', String(pending), pending, 'ゴール文書', ['G1.E11', 'G6.E5'], pending),
    metric('置き換えられた判断の割合', `${fmt(replacedRate)}（判断 ${judgments.length} 件中 ${replacedCount} 件）`, judgments.length, 'ゴール文書の判例（置き換えの列）', ['G0（仮説）'], replacedRate),
  ];
}

export function collectDecisionMetrics(repoDir) {
  const entries = loadDecisions(join(repoDir, 'goals')).map((p) => p.value).filter(Boolean);
  const judgments = entries.filter((e) => e.kind === '判断');
  const deviations = judgments.filter((e) => DEVIATIONS.includes(e.relation)).length;
  return [
    metric('判断ログの件数', String(judgments.length), judgments.length, '判断ログ', ['G8.E3'], judgments.length),
    metric('逸脱と指摘', `${deviations}（判断 ${judgments.length} 件中）`, judgments.length, '判断ログ', ['G8.E3', 'G1.2（仮説）'], deviations),
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
    metric('門番の通過', `${gateRuns} 回`, gateRuns, 'git の履歴', ['G5.E2'], gateRuns),
    metric('文書ができてから達成まで', hours.length ? `中央値 ${median(hours).toFixed(1)} 時間` : '達成したゴールなし', hours.length, 'git の履歴', ['G2.E1'], hours.length ? median(hours) : undefined),
  ];
}

function listJsonl(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listJsonl(path) : name.endsWith('.jsonl') ? [path] : [];
  });
}

// 作業記録からは件数だけを取り、内容は取らない（J48）
// saihai answer がゴール文書の判例に付けた印（G6.2.E2）。推奨どおりか、それ以外か
export function countDocAnswers(goals) {
  const texts = goals.flatMap((g) => g.judgments.map((j) => j.cells?.[2] ?? ''));
  const recommended = texts.filter((t) => t.includes(MARKS.推奨)).length;
  const other = texts.filter((t) => t.includes(MARKS.自明な案) || t.includes(MARKS.自由記述)).length;
  return { recommended, total: recommended + other };
}

// 推奨どおりの割合は、作業記録の回答（AskUserQuestion）とゴール文書の回答の印を合わせて出す
function recommendedMetric(fromTranscripts, fromDocs) {
  const total = fromTranscripts.total + fromDocs.total;
  const recommended = fromTranscripts.recommended + fromDocs.recommended;
  const rate = total ? recommended / total : undefined;
  const source = `作業記録（件数のみ）${fromTranscripts.total} 件・ゴール文書の回答の印 ${fromDocs.total} 件`;
  return metric('推奨どおりの割合', rate === undefined ? '回答なし' : `${fmt(rate)}（${total} 件中 ${recommended} 件）`, total, source, ['G2.E1', 'G6.E5'], rate);
}

export function collectTranscriptMetrics(transcriptsDir, docAnswers = { recommended: 0, total: 0 }) {
  const source = '作業記録（件数のみ）';
  if (!existsSync(transcriptsDir)) {
    return [
      metric('人の発言', '作業記録なし', 0, source, ['G7.E3', 'G7.E4']),
      metric('人への質問', '作業記録なし', 0, source, ['G3.2.E5', 'G6.E5']),
      recommendedMetric({ recommended: 0, total: 0 }, docAnswers),
    ];
  }
  const entries = listJsonl(transcriptsDir).flatMap((file) => readJsonl(file));
  const isToolResult = (e) => Array.isArray(e.message?.content) && e.message.content[0]?.type === 'tool_result';
  const human = entries.filter((e) => e.type === 'user' && !e.isMeta && !isToolResult(e) && (e.origin?.kind === 'human' || e.turnOrigin === 'human')).length;
  const asks = entries
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
    .filter((c) => c.type === 'tool_use' && c.name === 'AskUserQuestion');
  const questions = asks.reduce((n, a) => n + (a.input?.questions?.length ?? 0), 0);
  // 回答の選択肢に「（推奨）」が付いているかだけを数える。回答の中身は取らない（J48）
  // AskUserQuestion の結果だけを見る。ソースを読んだ結果などに同じ文字列が入っても数えない
  const askIds = new Set(asks.map((a) => a.id).filter(Boolean));
  const answers = entries
    .filter((e) => e.type === 'user' && Array.isArray(e.message?.content))
    .flatMap((e) => e.message.content)
    .filter((c) => c.type === 'tool_result' && askIds.has(c.tool_use_id) && typeof c.content === 'string' && c.content.includes('questions have been answered'))
    .flatMap((c) => [...c.content.matchAll(/="([^"]*)"/g)].map((m) => m[1].includes('（推奨）')));
  return [
    metric('人の発言', String(human), human, source, ['G7.E3', 'G7.E4'], human),
    metric('人への質問', `${asks.length} 回（問い ${questions} 件）`, asks.length, source, ['G3.2.E5', 'G6.E5'], asks.length),
    recommendedMetric({ recommended: answers.filter(Boolean).length, total: answers.length }, docAnswers),
  ];
}

// 隠しシナリオは、設定の hidden に挙げた評価対象だけ（今は saihai 自身の check-goals だけ）
function collectHiddenMetrics(hidden, targets) {
  return targets.filter((t) => TARGETS[t]).map((target) => {
    let r;
    try {
      r = hidden(target);
    } catch {
      r = {};
    }
    const total = r.total ?? 0;
    return metric(`隠しシナリオ（${target}）`, total ? `${total} 件中 ${total - r.failed} 件が通過` : '隠しシナリオなし', total, '評価の結果', ['G3.3.E3'], total ? (total - r.failed) / total : undefined);
  });
}

// 合否のような1回の値は、履歴に残した回数を件数にする（G7.1 の仮置き）
const historyCount = (history, name) => history.filter((h) => h.kind === '観測' && h.metrics?.some((m) => m.name === name)).length + 1;

// ある時点（ref）のゴール文書と判断ログを一時フォルダに取り出す。saihai 自身なら検査ツール（tools）も取り出す
const INSTALLED_CHECKER = fileURLToPath(new URL('./check-goals.mjs', import.meta.url));
function extractAt(repoDir, ref) {
  const ls = spawnSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: repoDir, encoding: 'utf8' });
  if (ls.status !== 0) return null;
  const files = ls.stdout.split('\n');
  if (!files.some((f) => f.startsWith('goals/'))) return null;
  // saihai 自身（package.json の name が saihai、または bin/saihai.mjs がある）だけ、その時点の検査ツールを使う。導入先の tools/ は実行しない
  const pkg = spawnSync('git', ['show', `${ref}:package.json`], { cwd: repoDir, encoding: 'utf8' });
  const named = pkg.status === 0 && /"name"\s*:\s*"saihai"/.test(pkg.stdout);
  const self = files.includes('tools/check-goals.mjs') && (named || files.includes('bin/saihai.mjs'));
  const paths = ['goals', ...(files.some((f) => f.startsWith('decisions/')) ? ['decisions'] : []), ...(self ? ['tools'] : [])];
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'saihai-main-'));
  const r = spawnSync('sh', ['-c', 'ref="$1"; shift; git archive "$ref" "$@" | tar -x -C "$0"', dir, ref, ...paths], { cwd: repoDir });
  // パイプの終了コードは tar のものなので、取り出せたかは goals/ があるかで確かめる
  if (r.status === 0 && existsSync(join(dir, 'goals'))) return { dir, checker: self ? join(dir, 'tools', 'check-goals.mjs') : INSTALLED_CHECKER };
  rmSync(dir, { recursive: true, force: true });
  return null;
}

function checkAt(repoDir, ref) {
  const at = extractAt(repoDir, ref);
  if (!at) return null;
  try {
    return spawnSync(process.execPath, [at.checker, '--goals-dir', join(at.dir, 'goals')], { stdio: 'ignore' }).status === 0 ? 0 : 1;
  } finally {
    rmSync(at.dir, { recursive: true, force: true });
  }
}

// 門番を通した各時点の main（「門番を通過」のマージ）と今の main
function gatedStates(repoDir) {
  const log = spawnSync('git', ['log', 'main', '--first-parent', '--format=%H%x09%s'], { cwd: repoDir, encoding: 'utf8' });
  if (log.status !== 0) return [];
  const rows = log.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const head = rows[0]?.[0];
  return [...new Set([head, ...rows.filter(([, subject]) => subject?.includes('門番を通過')).map(([hash]) => hash)].filter(Boolean))];
}

// G5 の仮説の観測。門番を通した各時点の main を、その時点の検査ツールで検査する（G7.1 の D6 の指摘）。
// 作業ツリーの検査ツールで検査すると、書式を変えたときに main が壊れたように見える。main がなければ作業ツリーで代える
export function collectCheckMetric(repoDir, goals, history) {
  const results = gatedStates(repoDir).map((ref) => checkAt(repoDir, ref)).filter((r) => r !== null);
  if (results.length) {
    const failed = results.reduce((a, b) => a + b, 0);
    return metric('mainの検査の失敗', `${failed}（門番を通した main の ${results.length} 個の状態のうち）`, results.length, 'ゴール文書の検査（main の各時点、その時点の検査ツール）', ['G5.E2'], failed);
  }
  const failed = checkRepo(goals).length + checkDecisions(loadDecisions(join(repoDir, 'goals')), goals.map((g) => g.frontmatter?.id).filter(Boolean)).length > 0 ? 1 : 0;
  return metric('mainの検査の失敗', failed ? '1（違反あり）' : '0（違反なし）', historyCount(history, 'mainの検査の失敗'), 'ゴール文書の検査（いまの作業ツリー。main が見つからない）', ['G5.E2'], failed);
}

// プロジェクトが設定する観測のコマンド（saihai.config.json の probes）。標準出力の1つ目の数値が値、2つ目が件数
export function collectProbeMetrics(repoDir, history = readJsonl(observationsPathOf(repoDir))) {
  const configPath = join(repoDir, 'saihai.config.json');
  if (!existsSync(configPath)) return [];
  const probes = JSON.parse(readFileSync(configPath, 'utf8')).probes ?? {};
  return Object.entries(probes).map(([name, probe]) => {
    const r = spawnSync('sh', ['-c', probe.command], { cwd: repoDir, encoding: 'utf8', timeout: 30_000 });
    const numbers = r.status === 0 ? (r.stdout.match(/-?\d+(?:\.\d+)?/g) ?? []) : [];
    const examples = probe.examples ?? [];
    if (numbers.length === 0) return metric(name, 'まだ観測できない（コマンドが失敗しました）', 0, `観測のコマンド（${probe.command}）`, examples);
    const count = numbers[1] === undefined ? historyCount(history, name) : Number(numbers[1]);
    return metric(name, numbers[0], count, `観測のコマンド（${probe.command}）`, examples, Number(numbers[0]));
  });
}

// --- 人の観測と履歴 ---

export function recordObservation({ repoDir = REPO_DIR, name, num, count = 1, note = '', by = 'AI', date = new Date().toISOString().slice(0, 10) }) {
  if (!name || !Number.isFinite(num)) throw new Error('記録には「指標の名前=数値」が要ります');
  const path = observationsPathOf(repoDir);
  mkdirSync(join(repoDir, 'observations'), { recursive: true });
  const entry = { kind: '記録', date, name, num, count, note, by };
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  return entry;
}

// その名前を観測の式で使っているゴールの仮説
function linkedHypotheses(goals, name) {
  return goals
    .filter((g) =>
      (section(g.human, '仮説と判定') ?? [])
        .filter((l) => /^- (当たり|外れ)の判定：/.test(l))
        .flatMap(parseExpressions)
        .some((e) => e.key === name),
    )
    .map((g) => `${g.frontmatter.id}（仮説）`);
}

export function collectRecordMetrics(repoDir, goals, builtinNames, history = readJsonl(observationsPathOf(repoDir))) {
  const latest = new Map();
  for (const h of history.filter((x) => x.kind === '記録' && !builtinNames.includes(x.name))) latest.set(h.name, h);
  return [...latest.values()].map((r) => {
    const linked = linkedHypotheses(goals, r.name);
    return metric(r.name, `${fmt(r.num)}（${r.by} の記録、${r.date}${r.note ? `：${r.note}` : ''}）`, r.count, `${r.by} の記録`, linked.length ? linked : ['（どの仮説にも使われていない）'], r.num);
  });
}

export function saveSnapshot(repoDir, metrics, date = new Date().toISOString()) {
  mkdirSync(join(repoDir, 'observations'), { recursive: true });
  const values = metrics.filter((m) => m.num !== undefined).map(({ name, num, count }) => ({ name, num, count }));
  appendFileSync(observationsPathOf(repoDir), `${JSON.stringify({ kind: '観測', date, metrics: values })}\n`);
}

export function previousValues(repoDir) {
  const last = readJsonl(observationsPathOf(repoDir)).filter((h) => h.kind === '観測').at(-1);
  return new Map((last?.metrics ?? []).map((m) => [m.name, m.num]));
}

// --- 仮説の判定（G7.1.E1・J64） ---

const holds = (e, n) => ({ '>=': n >= e.value, '<=': n <= e.value, '>': n > e.value, '<': n < e.value, '==': n === e.value })[e.op];

export function judgeHypotheses(goals, metrics) {
  const byName = new Map(metrics.map((m) => [m.name, m]));
  const verdicts = goals.flatMap((g) => {
    const lines = section(g.human, '仮説と判定') ?? [];
    const line = lines.find((l) => l.startsWith('- 仮説：')) ?? '';
    const hypothesis = line.slice('- 仮説：'.length);
    // 中止したゴールの仮説は、もう判定しない
    if (!hypothesis || isNoHypothesis(line) || g.frontmatter?.status === '中止') return [];
    const exprs = (label) => lines.filter((l) => l.startsWith(`- ${label}：`)).flatMap(parseExpressions).filter((e) => !e.invalid);
    const hit = exprs('当たりの判定');
    const miss = exprs('外れの判定');
    const base = { goal: g.frontmatter.id, hypothesis };
    if (hit.length === 0 && miss.length === 0) return [{ ...base, verdict: '人が判定', basis: '判定の行に観測の式がない' }];
    const keys = [...new Set([...hit, ...miss].map((e) => e.key))];
    const missing = keys.filter((k) => !Number.isFinite(byName.get(k)?.num));
    if (missing.length) return [{ ...base, verdict: 'まだ観測できない', basis: `観測できない指標：${missing.join('、')}` }];
    const basis = keys.map((k) => `${k} = ${fmt(byName.get(k).num)}（${byName.get(k).count}件）`).join('、');
    if (keys.some((k) => byName.get(k).count < TOO_FEW)) return [{ ...base, keys, verdict: 'まだ判断できない', basis }];
    const hitTrue = hit.length > 0 && hit.every((e) => holds(e, byName.get(e.key).num));
    const missTrue = miss.some((e) => holds(e, byName.get(e.key).num));
    const verdict = hitTrue && missTrue ? '矛盾' : hitTrue ? '当たり' : missTrue ? '外れ' : 'どちらでもない';
    return [{ ...base, keys, verdict, basis }];
  });
  // 根拠の指標がすべて他の仮説の根拠に含まれるなら、その仮説とは独立の根拠にならない（J68）
  const within = (v, o) => v.keys.every((k) => o.keys.includes(k));
  return verdicts.map((v) => (v.keys ? { ...v, sharedWith: verdicts.filter((o) => o !== v && o.keys && within(v, o)).map((o) => o.goal) } : v));
}

export function derivedMetrics(metrics, verdicts) {
  const usable = metrics.filter((m) => m.count >= TOO_FEW).length;
  const judged = verdicts.filter((v) => v.verdict === '当たり' || v.verdict === '外れ').length;
  const usableRate = metrics.length ? usable / metrics.length : undefined;
  const judgedRate = verdicts.length ? judged / verdicts.length : undefined;
  return [
    metric('判断に使える指標の割合', usableRate === undefined ? '指標なし' : `${fmt(usableRate)}（${metrics.length} 件中 ${usable} 件）`, metrics.length, '観測の報告', ['G7（仮説）'], usableRate),
    metric('判定できた仮説の割合', judgedRate === undefined ? '仮説なし' : `${fmt(judgedRate)}（${verdicts.length} 件中 ${judged} 件）`, verdicts.length, '仮説の判定', ['G7.1（仮説）'], judgedRate),
  ];
}

// --- まとめ ---

export function observeAll({
  repoDir = REPO_DIR,
  goals = loadGoals(join(repoDir, 'goals')),
  transcriptsDir = transcriptsDirOf(repoDir),
  hidden = (targetName) => runHidden({ targetName }),
  hiddenTargets = readConfig(repoDir).hidden ?? [],
  // 組み込みの指標に付ける具体例の ID は saihai 自身のもの。導入先では付けず、仮説から引いたものだけにする（G9）
  ownExamples = realPath(repoDir) === realPath(REPO_DIR),
} = {}) {
  const history = readJsonl(observationsPathOf(repoDir));
  const own = (m) => (ownExamples ? m : { ...m, examples: [] });
  const builtin = [
    ...[
      ...collectGoalMetrics(goals),
      ...collectDecisionMetrics(repoDir),
      ...collectGitMetrics(repoDir, goals),
      ...collectHiddenMetrics(hidden, hiddenTargets),
      ...collectTranscriptMetrics(transcriptsDir, countDocAnswers(goals)),
      collectCheckMetric(repoDir, goals, history),
    ].map(own),
    ...collectProbeMetrics(repoDir, history),
  ];
  const derivedNames = ['判断に使える指標の割合', '判定できた仮説の割合'];
  const collected = [...builtin, ...collectRecordMetrics(repoDir, goals, [...builtin.map((m) => m.name), ...derivedNames], history)];
  // 式に出てくるのに観測できない指標も、表に出す（黙って当たり扱いにしない。G7.1.E5）
  const exprKeys = goals.flatMap((g) => (section(g.human, '仮説と判定') ?? []).filter((l) => /^- (当たり|外れ)の判定：/.test(l)).flatMap(parseExpressions)).map((e) => e.key);
  const unobserved = [...new Set(exprKeys)]
    .filter((k) => k && !collected.some((m) => m.name === k) && !derivedNames.includes(k))
    .map((k) => metric(k, 'まだ観測できない（指標がない）', 0, 'なし（未観測）', linkedHypotheses(goals, k)));
  const base = [...collected, ...unobserved];
  // 判定できた仮説の割合は、仮説の判定そのものから出すので、2回に分けて判定する。
  // 1回目にも「判断に使える指標の割合」は入れる（G7 の判定を数え漏らさないため）
  const usable = own(derivedMetrics(base, []).find((m) => m.name === '判断に使える指標の割合'));
  const firstVerdicts = judgeHypotheses(goals, [...base, usable]);
  const metrics = [...base, ...derivedMetrics(base, firstVerdicts).map(own)].map((m) => {
    const linked = linkedHypotheses(goals, m.name).filter((x) => !m.examples.includes(x));
    return { ...m, examples: [...m.examples, ...linked] };
  });
  return { metrics, verdicts: judgeHypotheses(goals, metrics), previous: previousValues(repoDir) };
}

export const observe = (options) => observeAll(options).metrics;

const cell = (x) => String(x).replace(/\r?\n/g, ' ').replaceAll('|', '\\|'); // 表のセルの改行と「|」で表が崩れないように

export function renderReport(metrics, verdicts = [], previous = new Map(), now = new Date()) {
  return [
    `# 観測（${now.toISOString().slice(0, 16).replace('T', ' ')} UTC）`,
    '',
    ...(verdicts.length
      ? ['## 仮説の判定', '', '| ゴール | 仮説 | 判定 | 根拠 |', '|---|---|---|---|', ...verdicts.map((v) => `| ${v.goal} | ${cell(v.hypothesis)} | ${v.verdict} | ${cell(v.basis)}${v.sharedWith?.length ? `。根拠は ${v.sharedWith.join('・')} と共通` : ''} |`), '']
      : []),
    '## 指標',
    '',
    '| 指標 | 値 | 前回 | 件数 | 出どころ | 具体例 | 判断に使えるか |',
    '|---|---|---|---|---|---|---|',
    ...metrics.map((m) => {
      const before = previous.has(m.name) ? fmt(previous.get(m.name)) : '―';
      return `| ${cell(m.name)} | ${cell(m.value)} | ${before} | ${m.count} | ${cell(m.source)} | ${cell(m.examples.join('・') || '―')} | ${m.count >= TOO_FEW ? '使える' : 'まだ判断できない'} |`;
    }),
    '',
    `件数が${TOO_FEW}件未満の指標は「まだ判断できない」とし、仮説の判定にも解釈（G6）の候補にも使わない（J51）。`,
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

// npm run observe [-- --save] [-- --record 指標=値 --n 件数 --note メモ --by 人|AI]
export function run({ argv = [], root = REPO_DIR } = {}) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { save: { type: 'boolean' }, record: { type: 'string' }, n: { type: 'string' }, note: { type: 'string' }, by: { type: 'string' } },
    });
    const out = [];
    if (values.record) {
      const [name, value] = values.record.split('=');
      const entry = recordObservation({ repoDir: root, name: name?.trim(), num: Number(value), count: values.n ? Number(values.n) : 1, note: values.note ?? '', by: values.by ?? 'AI' });
      out.push(`観測を記録しました：${entry.name} = ${entry.num}（${entry.count}件、${entry.by} の記録）\n\n`);
    }
    const { metrics, verdicts, previous } = observeAll({ repoDir: root });
    out.push(renderReport(metrics, verdicts, previous));
    if (values.save) {
      saveSnapshot(root, metrics);
      out.push('観測を履歴（observations/log.jsonl）に残しました。\n');
    }
    return { code: 0, out: out.join(''), err: '' };
  } catch (error) {
    return { code: 1, out: '', err: `観測できませんでした：${error.message}\n` };
  }
}

if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, out, err } = run({ argv: process.argv.slice(2) });
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}
