import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerQuestion, applyAnswer, run } from './answer.mjs';
import { checkRepo, loadGoals } from './check-goals.mjs';

const pending = (ids) =>
  ids.length
    ? `## 判断待ち\n\n${ids.map((q) => `### ${q} ${q} の問い\n\n- **推奨**：A にする（理由：速い）\n- **自明な案**：B にする\n- 取り消し：可能\n`).join('\n')}\n`
    : '';
const doc = ({ id = 'G1', parent = 'G0', qs = ['Q12'], table = true } = {}) => `---
id: ${id}
parent: ${parent}
status: 議論中
version: 0.1
updated: 2026-10-12
---

# ${id} テスト

> 要約

${pending(qs)}## 意図

- 目的：目的
- 理由：理由
- 望ましい最終状態：状態

## 仮説と判定

- 仮説：なし（理由：テスト用）

## 具体例

- E1 \`[機械]\` 例

---

## AI 層
${table ? '\n### 判例\n\n| ID | 日付 | 判断 | 強さ | 上申 | 置き換え |\n|---|---|---|---|---|---|\n| J3 | 2026-10-12 | 前の判断 | 推奨 | ― | ― |\n' : ''}`;

function project(docs) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'saihai-answer-')));
  const goalsDir = join(root, 'goals');
  mkdirSync(goalsDir);
  for (const [name, text] of Object.entries(docs)) writeFileSync(join(goalsDir, name), text);
  return goalsDir;
}

const root0 = doc({ id: 'G0', parent: 'null', qs: [], table: false });
const read = (goalsDir, name) => readFileSync(join(goalsDir, name), 'utf8');

test('applyAnswer: 判断待ちの項目を消し、空になれば節ごと消して、判例の表の末尾に足す（G6.2.E1）', () => {
  const out = applyAnswer(doc(), { qId: 'Q12', jId: 'J7', date: '2026-10-13', decision: 'A にする（推奨どおり）', strength: '推奨' });
  assert.doesNotMatch(out, /判断待ち|Q12 の問い/);
  assert.match(out, /\| J3 \| 2026-10-12 \| 前の判断 \| 推奨 \| ― \| ― \|\n\| J7 \| 2026-10-13 \| A にする（推奨どおり） \| 推奨 \| Q12 \| ― \|/);
});

test('applyAnswer: ほかの判断待ちは残す。判例の表がなければ AI 層の末尾に作る', () => {
  const out = applyAnswer(doc({ qs: ['Q12', 'Q13'], table: false }), { qId: 'Q12', jId: 'J1', date: '2026-10-13', decision: 'A', strength: '推奨' });
  assert.match(out, /## 判断待ち\n\n### Q13 Q13 の問い/);
  assert.doesNotMatch(out, /Q12 の問い/);
  assert.match(out, /### 判例\n\n\| ID \| 日付 \| 判断 \| 強さ \| 上申 \| 置き換え \|\n\|---\|---\|---\|---\|---\|---\|\n\| J1 \| 2026-10-13 \| A \| 推奨 \| Q12 \| ― \|\n$/);
});

test('answerQuestion: 推奨で答えると、推奨の文に「推奨どおり」の印を付け、J の番号はリポジトリ全体の続きにする（G6.2.E1・E2）', () => {
  const goalsDir = project({ 'G0-root.md': root0, 'G1-a.md': doc(), 'G2-b.md': doc({ id: 'G2', qs: ['Q20'] }).replace('| J3 |', '| J9 |') });
  const r = answerQuestion({ goalsDir, id: 'Q12', choice: '推奨', date: '2026-10-13' });
  assert.equal(r.judgmentId, 'J10');
  assert.match(read(goalsDir, 'G1-a.md'), /\| J10 \| 2026-10-13 \| A にする（理由：速い）（推奨どおり） \| 推奨 \| Q12 \| ― \|/);
  assert.deepEqual(checkRepo(loadGoals(goalsDir)), []);
});

test('answerQuestion: 自明な案と自由記述にも印を付ける（G6.2.E2）', () => {
  const goalsDir = project({ 'G0-root.md': root0, 'G1-a.md': doc({ qs: ['Q12', 'Q13'] }) });
  answerQuestion({ goalsDir, id: 'Q12', choice: '自明な案', date: '2026-10-13' });
  answerQuestion({ goalsDir, id: 'Q13', text: 'C にする', date: '2026-10-13' });
  const text = read(goalsDir, 'G1-a.md');
  assert.match(text, /\| B にする（自明な案を選択） \| 推奨 \| Q12 \|/);
  assert.match(text, /\| C にする（推奨と違う回答） \| 推奨 \| Q13 \|/);
});

test('answerQuestion: --adopt は推奨を採用した仮置きで、印は付けない。--asked も印を付けない（G6.2.E3）', () => {
  const goalsDir = project({ 'G0-root.md': root0, 'G1-a.md': doc({ qs: ['Q12', 'Q13'] }) });
  answerQuestion({ goalsDir, id: 'Q12', choice: '推奨', adopt: 'J37', date: '2026-10-13' });
  answerQuestion({ goalsDir, id: 'Q13', choice: '推奨', asked: true, date: '2026-10-13' });
  const text = read(goalsDir, 'G1-a.md');
  assert.match(text, /\| A にする（理由：速い）。推奨を採用（J37） \| 仮置き \| Q12 \|/);
  assert.match(text, /\| A にする（理由：速い） \| 推奨 \| Q13 \|/);
  assert.doesNotMatch(text, /推奨どおり/);
});

test('answerQuestion: 知らない Q や、検査に通らない答え（推奨を採用しただけの不変条件）は、何も書かずに止まる（G6.2.E4）', () => {
  const goalsDir = project({ 'G0-root.md': root0, 'G1-a.md': doc() });
  const before = read(goalsDir, 'G1-a.md');
  assert.throws(() => answerQuestion({ goalsDir, id: 'Q99', choice: '推奨' }), /Q99/);
  assert.throws(() => answerQuestion({ goalsDir, id: 'Q12', choice: '推奨', adopt: 'J37', strength: '不変条件' }), /G1\.2\.E4/);
  assert.equal(read(goalsDir, 'G1-a.md'), before);
});

test('run: 引数から答え、何を記録したかを返す', () => {
  const goalsDir = project({ 'G0-root.md': root0, 'G1-a.md': doc() });
  const r = run({ argv: ['Q12', '推奨'], goalsDir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Q12 に答え、J4 として G1 の判例に移しました/);
  assert.equal(run({ argv: [], goalsDir }).code, 1);
  assert.equal(run({ argv: ['Q12'], goalsDir }).code, 1); // もう答えた
});

test('answerQuestion: 議論中のゴールの最後の判断待ちに答えると、進行中に進める（人が status を書き換えなくてよい）', () => {
  const goalsDir = project({ 'G0-root.md': root0, 'G1-a.md': doc({ qs: ['Q12', 'Q13'] }) });
  const first = answerQuestion({ goalsDir, id: 'Q12', choice: '推奨', date: '2026-10-13' });
  assert.equal(first.advanced, false);
  assert.match(read(goalsDir, 'G1-a.md'), /^status: 議論中$/m);
  const last = answerQuestion({ goalsDir, id: 'Q13', choice: '推奨', date: '2026-10-13' });
  assert.equal(last.advanced, true);
  assert.match(read(goalsDir, 'G1-a.md'), /^status: 進行中$/m);
  assert.match(read(goalsDir, 'G1-a.md'), /^updated: 2026-10-13$/m);
  assert.match(run({ argv: [], goalsDir }).err, /使い方/);
});

test('run: 最後の判断待ちに答えたら、進行中にしたことを伝える', () => {
  const goalsDir = project({ 'G0-root.md': root0, 'G1-a.md': doc() });
  assert.match(run({ argv: ['Q12', '推奨'], goalsDir }).out, /判断待ちがなくなったので、G1 を進行中にしました/);
});
