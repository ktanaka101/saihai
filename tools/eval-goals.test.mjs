import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compare,
  evaluate,
  evaluatorArgs,
  loadCases,
  parseRules,
  prepareWorkspace,
  runEvaluation,
  TARGETS,
} from './eval-goals.mjs';

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

理由

## 具体例

- E1 \`[機械]\` 例

---

## AI 層
`;

const tempDir = () => mkdtempSync(join(tmpdir(), 'saihai-eval-test-'));

function writeCase(workDir, name, { goal = VALID_GOAL, expected }) {
  const dir = join(workDir, 'cases', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'G9-test.md'), goal);
  writeFileSync(join(dir, 'expected.json'), typeof expected === 'string' ? expected : JSON.stringify(expected));
}

test('prepareWorkspace: 仕様のゴール文書の写しだけを spec/ に置く', () => {
  const workDir = tempDir();
  const copied = prepareWorkspace({ goalsDir: GOALS_DIR, specIds: ['G1', 'G1.1'], workDir });
  assert.deepEqual(copied, ['G1-goal-format.md', 'G1.1-format-check.md']);
  assert.ok(existsSync(join(workDir, 'spec', 'G1-goal-format.md')));
  assert.ok(!existsSync(join(workDir, 'spec', 'G0-goal-factory.md')));
});

test('prepareWorkspace: 見つからないゴールがあれば失敗する', () => {
  assert.throws(() => prepareWorkspace({ goalsDir: GOALS_DIR, specIds: ['G99'], workDir: tempDir() }), /G99/);
});

test('evaluatorArgs: 道具は読み書きの3つだけ。Bash と外部の道具はなく、ホーム以下は読めない（E2）', () => {
  const args = evaluatorArgs('指示');
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], '-p');
  assert.equal(args[1], '指示');
  assert.equal(after('--tools'), 'Read,Write,Edit');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('Read(~/**)'));
  assert.ok(args.includes('Edit(~/**)'));
  assert.ok(!args.some((a) => /^Bash/.test(a)));
});

test('parseRules: 違反の行から ID の集合を取り出す', () => {
  const stderr = 'goals/G9-a.md: [G1.E1] x\ngoals/G9-a.md: [G1.書式] y\ngoals/G9-b.md: [G1.E1] z\nゴール文書 2 件：違反 3 件\n';
  assert.deepEqual(parseRules(stderr), ['G1.E1', 'G1.書式']);
});

test('compare: 終了コードと違反の ID の集合が同じなら一致（順不同）', () => {
  assert.equal(compare({ exit: 1, rules: ['G1.E2', 'G1.E1'] }, { exit: 1, rules: ['G1.E1', 'G1.E2'] }), true);
  assert.equal(compare({ exit: 1, rules: ['G1.E1'] }, { exit: 1, rules: ['G1.E1', 'G1.E2'] }), false);
  assert.equal(compare({ exit: 0, rules: [] }, { exit: 1, rules: [] }), false);
});

test('loadCases: 形の崩れた expected.json は「評価 AI の出力の不備」として扱う', () => {
  const workDir = tempDir();
  writeCase(workDir, 'ok', { expected: { examples: ['G1.E2'], exit: 0, rules: [], ambiguity: null } });
  writeCase(workDir, 'broken-json', { expected: '{' });
  writeCase(workDir, 'bad-shape', { expected: { exit: '0' } });
  const cases = loadCases(workDir);
  assert.deepEqual(cases.map((c) => [c.name, c.problem === null]), [['bad-shape', false], ['broken-json', false], ['ok', true]]);
});

test('evaluate: 決まった手順でケースを実行し、不一致と曖昧な点を報告する（E4）', () => {
  const workDir = tempDir();
  writeCase(workDir, 'match', { expected: { examples: ['G1.E2'], exit: 0, rules: [], ambiguity: null } });
  writeCase(workDir, 'mismatch', {
    goal: VALID_GOAL.replace('## AI 層', '## 補足'),
    expected: { examples: ['G1.E2'], exit: 0, rules: [], ambiguity: '境界の見出しの書き方が仕様から決まらない' },
  });
  writeFileSync(join(workDir, 'questions.md'), '- この入力ならこうなるべき？\n');
  const { code, summary } = evaluate({ workDir, target: TARGETS['check-goals'] });
  assert.equal(code, 1);
  assert.match(summary, /一致 1 件・不一致 1 件/);
  const report = readFileSync(join(workDir, 'report.md'), 'utf8');
  assert.match(report, /mismatch/);
  assert.match(report, /G1\.E2/);
  assert.match(report, /境界の見出しの書き方/);
  assert.match(report, /この入力ならこうなるべき？/);
});

test('evaluate: すべて一致すれば終了コード0', () => {
  const workDir = tempDir();
  writeCase(workDir, 'match', { expected: { examples: ['G1.E2'], exit: 0, rules: [], ambiguity: null } });
  assert.equal(evaluate({ workDir, target: TARGETS['check-goals'] }).code, 0);
});

test('evaluate: ケースが1つもなければ、評価 AI の出力の不備として失敗する', () => {
  const r = evaluate({ workDir: tempDir(), target: TARGETS['check-goals'] });
  assert.equal(r.code, 1);
  assert.match(r.summary, /ケースが1つもありません/);
});

test('runEvaluation: 評価 AI を作業フォルダで起動し、終わってから評価を実行する（E1・E3）', () => {
  const calls = [];
  const launch = ({ args, cwd }) => {
    calls.push({ args, cwd, specs: existsSync(join(cwd, 'spec', 'G1-goal-format.md')), reportBefore: existsSync(join(cwd, 'report.md')) });
    writeCase(cwd, 'match', { expected: { examples: ['G1.E2'], exit: 0, rules: [], ambiguity: null } });
    return { status: 0 };
  };
  const r = runEvaluation({ targetName: 'check-goals', goalsDir: GOALS_DIR, workRoot: tempDir(), launch });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].specs, true);
  assert.equal(calls[0].reportBefore, false);
  assert.ok(calls[0].args.includes('--strict-mcp-config'));
  assert.ok(existsSync(join(r.workDir, 'report.md')));
  // 評価 AI はファイルの一覧を見る道具を持たないので、仕様のファイル名を指示文で伝える
  assert.match(calls[0].args[1], /spec\/G1-goal-format\.md/);
  assert.match(calls[0].args[1], /spec\/G1\.1-format-check\.md/);
});

test('runEvaluation: 評価 AI が異常終了したら、評価せずに失敗を報告する', () => {
  const r = runEvaluation({ targetName: 'check-goals', goalsDir: GOALS_DIR, workRoot: tempDir(), launch: () => ({ status: 1 }) });
  assert.equal(r.code, 1);
  assert.match(r.summary, /評価 AI が異常終了/);
});

test('evaluatorArgs: 評価1回あたりの費用の上限は3ドル（J25）', () => {
  const args = evaluatorArgs('指示');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '3');
});

test('runEvaluation: 費用の上限で止まったら、そのことを報告して上申する', () => {
  const launch = ({ log }) => {
    writeFileSync(log, `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd' })}\n`);
    return { status: 1 };
  };
  const r = runEvaluation({ targetName: 'check-goals', goalsDir: GOALS_DIR, workRoot: tempDir(), launch });
  assert.equal(r.code, 1);
  assert.match(r.summary, /費用の上限（3ドル）/);
});

test('runEvaluation: 知らない評価対象なら失敗する', () => {
  assert.throws(() => runEvaluation({ targetName: 'unknown', goalsDir: GOALS_DIR, workRoot: tempDir(), launch: () => ({ status: 0 }) }), /unknown/);
});
