import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectQuestions, runSplitEvaluation } from './eval-split.mjs';
import { evaluatorArgs } from './eval-goals.mjs';

const GOALS_DIR = fileURLToPath(new URL('../goals/', import.meta.url));

const VALID_GOAL = `---
id: G9
parent: null
status: 進行中
version: 0.1
updated: 2026-10-12
---

# G9 テスト

> 要約

## 意図

- 目的：目的の本文
- 理由：理由の本文
- 望ましい最終状態：最終状態の本文

## 仮説と判定

- 仮説：なし（理由：テスト用）

## 具体例

- E1 \`[機械]\` 例

---

## AI 層
`;
const NO_BOUNDARY = VALID_GOAL.replace('## AI 層', '## 補足');

const PASS = { exit: 0, rules: [], reason: '違反なし' };
const BOUNDARY = { exit: 1, rules: ['G1.E2'], reason: '境界がない' };
const LINES = { exit: 1, rules: ['G1.E3'], reason: '長すぎる' };
const FORMAT = { exit: 1, rules: ['G1.書式'], reason: '書式' };

// 役割（作業フォルダの名前）ごとに振る舞いを変える偽の AI
function fakeLaunch({ cases, answers, calls = [], statusFor = () => 0, logFor = () => '' }) {
  return ({ args, cwd, log }) => {
    const role = basename(cwd);
    calls.push({ role, args, cwd, sawExpected: listAll(join(cwd, 'cases')).some((p) => p.endsWith('expected.json')) });
    writeFileSync(log, logFor(role));
    if (role === 'generator') {
      for (const [name, { goal }] of Object.entries(cases)) {
        mkdirSync(join(cwd, 'cases', name), { recursive: true });
        writeFileSync(join(cwd, 'cases', name, 'G9-test.md'), goal);
        writeFileSync(join(cwd, 'cases', name, 'case.json'), JSON.stringify({ examples: cases[name].examples ?? ['G1.E2'], note: '確かめたいこと' }));
      }
    } else {
      const view = role.endsWith('A') ? 'A' : 'B';
      const index = JSON.parse(readFileSync(join(cwd, 'cases', 'index.json'), 'utf8'));
      for (const c of index) {
        const answer = answers[c.name]?.[view];
        if (answer !== undefined) writeFileSync(join(cwd, 'cases', c.name, 'expected.json'), typeof answer === 'string' ? answer : JSON.stringify(answer));
      }
    }
    return { status: statusFor(role) };
  };
}

function listAll(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listAll(path) : [path];
  });
}

const run = (launch) => runSplitEvaluation({ targetName: 'check-goals', goalsDir: GOALS_DIR, workRoot: mkdtempSync(join(tmpdir(), 'saihai-split-test-')), launch });

test('evaluatorArgs: プロセスごとに費用の上限を渡せる（J26）', () => {
  const args = evaluatorArgs('指示', 1.5);
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '1.5');
});

test('ケースを作る AI、評価 AI A、評価 AI B の順に、別々の作業フォルダで起動する（E1）', () => {
  const calls = [];
  run(fakeLaunch({ cases: { c1: { goal: VALID_GOAL } }, answers: { c1: { A: PASS, B: PASS } }, calls }));
  assert.deepEqual(calls.map((c) => c.role), ['generator', 'predictor-A', 'predictor-B']);
  assert.equal(new Set(calls.map((c) => c.cwd)).size, 3);
  assert.deepEqual(calls.map((c) => c.args[c.args.indexOf('--max-budget-usd') + 1]), ['2', '1.5', '1.5']);
});

test('評価 AI には入力とケースの一覧だけを渡し、他の評価 AI の答えは見せない（E1）', () => {
  const calls = [];
  const result = run(fakeLaunch({ cases: { c1: { goal: VALID_GOAL } }, answers: { c1: { A: PASS, B: PASS } }, calls }));
  assert.deepEqual(calls.map((c) => c.sawExpected), [false, false, false]);
  const index = JSON.parse(readFileSync(join(result.root, 'predictor-B', 'cases', 'index.json'), 'utf8'));
  assert.deepEqual(index, [{ name: 'c1', files: ['G9-test.md'], examples: ['G1.E2'], note: '確かめたいこと' }]);
  assert.ok(calls[1].args[1].includes('文言') && calls[2].args[1].includes('意図'));
});

test('一致したケースは実装と突き合わせ、違えば実装の不具合として報告する。割れは質問にする（E2・E3）', () => {
  const result = run(
    fakeLaunch({
      cases: { ok: { goal: NO_BOUNDARY }, bug: { goal: VALID_GOAL }, split: { goal: VALID_GOAL } },
      answers: { ok: { A: BOUNDARY, B: BOUNDARY }, bug: { A: LINES, B: LINES }, split: { A: PASS, B: LINES } },
    }),
  );
  assert.equal(result.code, 1);
  assert.match(result.summary, /一致 2 件（うち実装の不具合 1 件）・割れ 1 件/);
  const report = readFileSync(join(result.root, 'report.md'), 'utf8');
  assert.match(report, /## 実装の不具合[\s\S]*bug/);
  const questions = JSON.parse(readFileSync(join(result.root, 'questions.json'), 'utf8'));
  const split = questions.find((q) => q.kind === 'split');
  assert.equal(split.name, 'split');
  assert.deepEqual([split.a.exit, split.b.exit, split.actual.exit], [0, 1, 0]);
});

test('一致したケースからも見本の質問を1件作る（E4）', () => {
  const result = run(fakeLaunch({ cases: { ok: { goal: NO_BOUNDARY } }, answers: { ok: { A: BOUNDARY, B: BOUNDARY } } }));
  const questions = JSON.parse(readFileSync(join(result.root, 'questions.json'), 'utf8'));
  assert.deepEqual(questions.map((q) => [q.kind, q.name]), [['sample', 'ok']]);
  assert.equal(result.code, 0);
});

test('selectQuestions: 見本を含めて5件まで。合否が割れたものを先に選び、残りは事後通知にする（J27）', () => {
  const splits = [
    { name: 's1', a: BOUNDARY, b: FORMAT },
    { name: 's2', a: PASS, b: LINES },
    { name: 's3', a: BOUNDARY, b: LINES },
    { name: 's4', a: PASS, b: BOUNDARY },
    { name: 's5', a: LINES, b: FORMAT },
    { name: 's6', a: PASS, b: FORMAT },
  ];
  const agreed = [{ name: 'g1', examples: ['G1.E2'] }, { name: 'g2', examples: ['G1.E3'] }, { name: 'g3', examples: ['G1.E2'] }];
  const { asked, deferred } = selectQuestions({ splits, agreed });
  assert.equal(asked.length, 5);
  assert.deepEqual(asked.filter((q) => q.kind === 'split').map((q) => q.name), ['s2', 's4', 's6', 's1']);
  assert.deepEqual(asked.filter((q) => q.kind === 'sample').map((q) => q.name), ['g2']);
  assert.deepEqual(deferred.map((q) => q.name), ['s3', 's5']);
});

test('評価 AI の出力が崩れていたら、出力の不備として報告する', () => {
  const result = run(fakeLaunch({ cases: { c1: { goal: VALID_GOAL }, c2: { goal: VALID_GOAL } }, answers: { c1: { A: PASS, B: '{' }, c2: { A: PASS } } }));
  assert.equal(result.code, 1);
  assert.match(result.summary, /出力の不備 2 件/);
});

test('どれかが費用の上限で止まったら、残りを起動せずに評価全体を止めて上申する（J26）', () => {
  const calls = [];
  const result = run(
    fakeLaunch({
      cases: { c1: { goal: VALID_GOAL } },
      answers: {},
      calls,
      statusFor: (role) => (role === 'generator' ? 1 : 0),
      logFor: (role) => (role === 'generator' ? `${JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd' })}\n` : ''),
    }),
  );
  assert.deepEqual(calls.map((c) => c.role), ['generator']);
  assert.equal(result.code, 1);
  assert.match(result.summary, /費用の上限/);
});

test('ケースを作る AI がケースを1つも作らなければ、失敗として報告する', () => {
  const result = run(fakeLaunch({ cases: {}, answers: {} }));
  assert.equal(result.code, 1);
  assert.match(result.summary, /ケースが1つもありません/);
});
