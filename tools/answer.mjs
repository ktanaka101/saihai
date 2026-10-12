// 判断待ちへの回答を1つのコマンドで記録する（G6.2）。
// 判断待ちの項目を消して判例に移し、推奨どおりに答えたかの印を付ける。答えた結果が検査に通らなければ書かない。
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkRepo, loadGoals, parseGoal } from './check-goals.mjs';

const USAGE = '使い方：saihai answer <Q の ID> 推奨|自明な案 [--text "自由記述"] [--strength 推奨|仮置き|不変条件] [--adopt J37] [--asked]';
const TABLE_HEADER = ['| ID | 日付 | 判断 | 強さ | 上申 | 置き換え |', '|---|---|---|---|---|---|'];
export const MARKS = { 推奨: '（推奨どおり）', 自明な案: '（自明な案を選択）', 自由記述: '（推奨と違う回答）' };

const isHeading = (line) => /^#{2,3} /.test(line);

// 判断待ちの項目を消す。節が空になれば節ごと消す
function removeQuestion(lines, qId) {
  const start = lines.findIndex((l) => new RegExp(`^### ${qId}(?!\\d)`).test(l));
  if (start === -1) return null;
  const rel = lines.slice(start + 1).findIndex(isHeading);
  const end = rel === -1 ? lines.length : start + 1 + rel;
  const rest = [...lines.slice(0, start), ...lines.slice(end)];
  const sectionStart = rest.findIndex((l) => /^## 判断待ち/.test(l));
  if (sectionStart === -1) return rest;
  const relEnd = rest.slice(sectionStart + 1).findIndex((l) => l.startsWith('## '));
  const sectionEnd = relEnd === -1 ? rest.length : sectionStart + 1 + relEnd;
  const empty = !rest.slice(sectionStart + 1, sectionEnd).some((l) => l.startsWith('### '));
  return empty ? [...rest.slice(0, sectionStart), ...rest.slice(sectionEnd)] : rest;
}

// 判例の表（AI 層の「### 判例」）の末尾に1行足す。表がなければ AI 層の末尾に作る
function appendJudgment(lines, row) {
  const heading = lines.findIndex((l) => /^### 判例/.test(l));
  if (heading !== -1) {
    const first = lines.findIndex((l, i) => i > heading && l.startsWith('|'));
    if (first !== -1) {
      let last = first;
      while (last + 1 < lines.length && lines[last + 1].startsWith('|')) last += 1;
      return [...lines.slice(0, last + 1), row, ...lines.slice(last + 1)];
    }
  }
  const body = lines.join('\n').replace(/\n*$/, '');
  return `${body}\n\n### 判例\n\n${[...TABLE_HEADER, row].join('\n')}\n`.split('\n');
}

export function applyAnswer(text, { qId, jId, date, decision, strength }) {
  const removed = removeQuestion(text.split('\n'), qId);
  if (!removed) throw new Error(`判断待ち ${qId} が見つかりません`);
  // 表の区切り（|）を文の中で使わない
  const row = `| ${jId} | ${date} | ${decision.replaceAll('|', '｜')} | ${strength} | ${qId} | ― |`;
  return appendJudgment(removed, row).join('\n').replace(/\n{3,}/g, '\n\n');
}

const labelText = (lines, label) => {
  const m = lines.map((l) => l.match(new RegExp(`^\\s*[-*]\\s*(\\*\\*)?${label}(\\*\\*)?：\\s*(.*)$`))).find(Boolean);
  return m ? m[3].trim() : null;
};

export function answerQuestion({ goalsDir, id, choice, text, strength, adopt, asked = false, date = new Date().toISOString().slice(0, 10) }) {
  const goals = loadGoals(goalsDir);
  const goal = goals.find((g) => g.pending.some((q) => q.id === id));
  if (!goal) throw new Error(`判断待ち ${id} が見つかりません（もう答えたか、ID が違います）`);
  const item = goal.pending.find((q) => q.id === id);

  let base;
  let mark;
  if (text) {
    base = text;
    mark = MARKS.自由記述;
  } else if (choice === '推奨' || choice === '自明な案') {
    base = labelText(item.lines, choice);
    if (!base) throw new Error(`${id} に「${choice}」の項目がありません`);
    mark = MARKS[choice];
  } else {
    throw new Error(USAGE);
  }
  const decision = adopt ? `${base}。推奨を採用（${adopt}）` : asked ? base : `${base}${mark}`;
  const finalStrength = strength ?? (adopt ? '仮置き' : '推奨');

  const maxJ = Math.max(0, ...goals.flatMap((g) => g.judgments.map((j) => Number(j.id.slice(1)) || 0)));
  const judgmentId = `J${maxJ + 1}`;
  const path = join(goalsDir, basename(goal.path));
  const answered = applyAnswer(readFileSync(path, 'utf8'), { qId: id, jId: judgmentId, date, decision, strength: finalStrength });
  // 議論中のゴールの最後の判断待ちに答えたら、進行中に進める（ゴール設定が終わった。人が status を書き換えなくてよい）
  const advanced = goal.frontmatter?.status === '議論中' && goal.pending.length === 1;
  const next = advanced ? answered.replace(/^status: 議論中$/m, 'status: 進行中').replace(/^updated: .*$/m, `updated: ${date}`) : answered;

  // 答えた結果が検査に通らなければ書かない（G6.2.E4）。もともとある違反は問わない
  const key = (v) => `${v.path}|${v.rule}|${v.message}`;
  const before = new Set(checkRepo(goals).map(key));
  const after = checkRepo(goals.map((g) => (g === goal ? parseGoal(goal.path, next) : g))).filter((v) => !before.has(key(v)));
  if (after.length) throw new Error(`答えた結果が検査に通らないので、記録しませんでした：${after.map((v) => `[${v.rule}] ${v.message}`).join('、')}`);
  writeFileSync(path, next);
  return { goal: goal.frontmatter.id, path, judgmentId, decision, advanced };
}

export function run({ argv = [], goalsDir }) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { text: { type: 'string' }, strength: { type: 'string' }, adopt: { type: 'string' }, asked: { type: 'boolean' } },
    });
    const [id, choice] = positionals;
    if (!id) return { code: 1, out: '', err: `${USAGE}\n` };
    const r = answerQuestion({ goalsDir, id, choice, text: values.text, strength: values.strength, adopt: values.adopt, asked: values.asked ?? false });
    const advanced = r.advanced ? `判断待ちがなくなったので、${r.goal} を進行中にしました（実装に進めます）\n` : '';
    return { code: 0, out: `${id} に答え、${r.judgmentId} として ${r.goal} の判例に移しました：${r.decision}\n${advanced}`, err: '' };
  } catch (error) {
    return { code: 1, out: '', err: `${error.message}\n` };
  }
}
