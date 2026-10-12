#!/usr/bin/env node
// 評価 AI を、ゴール文書だけを見せて、実行の手段を持たせずに起動する（G3.1）。
// 評価 AI が書いたケースは、評価 AI が終わってから決まった手順で実行し、期待と突き合わせる。
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOALS_DIR = fileURLToPath(new URL('../goals/', import.meta.url));
const CHECKER = fileURLToPath(new URL('./check-goals.mjs', import.meta.url));
const BUDGET_USD = 3; // 評価1回あたりの費用の上限。超えたら止めて上申する（J25）

export function parseRules(stderr) {
  const ids = stderr
    .split('\n')
    .map((line) => line.match(/^goals\/[^:]+: \[([^\]]+)\]/)?.[1])
    .filter(Boolean);
  return [...new Set(ids)];
}

export const TARGETS = {
  'check-goals': {
    specIds: ['G1', 'G1.1', 'G1.2'],
    description: [
      '評価対象は「ゴール文書の検査ツール」。仕様は spec/ の G1（ゴール文書の書式）、G1.1（検査ツール）、G1.2（書式 v2）。',
      '検査ツールは、ケースのフォルダにある *.md をすべてゴール文書として検査する。',
      '違反がなければ終了コード0、違反があれば終了コード1。',
      '違反は、どの具体例に反しているかを ID で報告する。G1 の具体例は G1.E1 など、G1.2（書式 v2）の具体例は G1.2.E1 など、書式の定義に関するものは G1.書式。',
    ].join('\n'),
    run(caseDir) {
      const r = spawnSync(process.execPath, [CHECKER, '--goals-dir', caseDir], { encoding: 'utf8' });
      return { exit: r.status, rules: parseRules(r.stderr ?? '') };
    },
  },
};

// 評価 AI はファイルの一覧を見る道具を持たないので、読むべき仕様のファイル名をここで伝える。
function evaluatorPrompt(target, specFiles) {
  return `あなたは「評価 AI」です。実装を見ずに、仕様（spec/ のゴール文書）だけから評価を作ります。

${target.description}

仕様のファイルは次のとおり（これ以外にはありません）。
${specFiles.map((name) => `- spec/${name}`).join('\n')}

## やること

1. spec/ を読み、仕様の \`[機械]\` の具体例と書式の定義から、評価対象が満たすべき振る舞いを洗い出す
2. 振る舞いごとに、cases/<ケース名>/ にケースを作る。ケースのフォルダには、検査させるゴール文書（*.md）と expected.json を置く。正しい入力も違反する入力も作り、境界値や紛らわしい書き方を重視する。25件前後
3. expected.json には、仕様から導いた期待を次の形で書く
   {"examples": ["G1.E1"], "exit": 1, "rules": ["G1.E1"], "ambiguity": null}
   - examples：このケースが確かめる具体例
   - exit と rules：期待する終了コードと、期待する違反の ID の一覧（違反がなければ []）
   - ambiguity：仕様から期待が一つに決まらないときは、その説明。決まるなら null
4. 仕様から期待が一つに決まらなかった点を、questions.md に「この入力ならこうなるべき？（はい／いいえ）」の形で書く

## 守ること

- あなたは評価対象を実行できません。期待は仕様の文言だけから導いてください
- 作業フォルダの外を読もうとしないでください
- 最後に、作ったケースの数と、曖昧な点の数を1行で出力してください`;
}

// 使える道具そのものを読み書きの3つに絞る。--allowedTools と違い、利用者の設定の許可が引き継がれても
// Bash は存在しない（G3.E6 で分かった穴）。ホーム以下（このリポジトリを含む）は読み書きを禁止する。
export function evaluatorArgs(prompt, budgetUsd = BUDGET_USD) {
  return [
    '-p',
    prompt,
    '--tools',
    'Read,Write,Edit',
    '--allowedTools',
    'Read(./**)',
    'Edit(./**)',
    '--disallowedTools',
    'Read(~/**)',
    'Edit(~/**)',
    '--strict-mcp-config',
    '--max-budget-usd',
    String(budgetUsd),
    '--max-turns',
    '80',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
}

export function prepareWorkspace({ goalsDir, specIds, workDir }) {
  const names = readdirSync(goalsDir);
  const files = specIds.map((id) => {
    const name = names.find((n) => n.startsWith(`${id}-`) && n.endsWith('.md'));
    if (!name) throw new Error(`仕様のゴール ${id} が ${goalsDir} に見つかりません`);
    return name;
  });
  mkdirSync(join(workDir, 'spec'), { recursive: true });
  for (const name of files) copyFileSync(join(goalsDir, name), join(workDir, 'spec', name));
  return files;
}

function readExpected(path) {
  if (!existsSync(path)) return { expected: null, problem: 'expected.json がありません' };
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { expected: null, problem: `expected.json を読めません：${error.message}` };
  }
  const ok =
    value !== null &&
    typeof value === 'object' &&
    (value.exit === 0 || value.exit === 1) &&
    Array.isArray(value.rules) &&
    value.rules.every((rule) => typeof rule === 'string') &&
    Array.isArray(value.examples);
  return ok ? { expected: value, problem: null } : { expected: null, problem: 'expected.json の形が違います（examples・exit・rules が必要）' };
}

export function loadCases(workDir) {
  const casesDir = join(workDir, 'cases');
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = join(casesDir, name);
      return { name, dir, ...readExpected(join(dir, 'expected.json')) };
    });
}

export function compare(expected, actual) {
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  return expected.exit === actual.exit && same([...new Set(expected.rules)], [...new Set(actual.rules)]);
}

const describe = (r) => (r ? `${r.exit} / ${r.rules.length ? r.rules.join('・') : '違反なし'}` : '―');

function renderReport({ summary, results, questions }) {
  const rows = results.map(
    (r) => `| ${r.name} | ${r.expected?.examples.join('・') ?? '―'} | ${describe(r.expected)} | ${describe(r.actual)} | ${r.match ? '○' : '✗'} |`,
  );
  const mismatches = results
    .filter((r) => !r.match && !r.problem)
    .map((r) =>
      [
        `### ${r.name}`,
        '',
        `- 期待：${describe(r.expected)}`,
        `- 実際：${describe(r.actual)}`,
        ...(r.expected.ambiguity ? [`- 評価 AI の注記（仕様から期待が一つに決まらない）：${r.expected.ambiguity}`] : []),
        `- ケース：${r.dir}`,
      ].join('\n'),
    );
  const problems = results.filter((r) => r.problem).map((r) => `- ${r.name}：${r.problem}`);
  return [
    '# 評価の報告',
    '',
    summary,
    '',
    '期待と実際は「終了コード / 違反の ID」。',
    '',
    '## ケース',
    '',
    '| ケース | 具体例 | 期待 | 実際 | 一致 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '## 不一致',
    '',
    ...(mismatches.length ? mismatches.flatMap((m) => [m, '']) : ['なし', '']),
    '## 評価 AI の出力の不備',
    '',
    ...(problems.length ? problems : ['なし']),
    '',
    '## 曖昧な点（評価 AI からの質問）',
    '',
    questions.trim() || 'なし',
    '',
  ].join('\n');
}

export function evaluate({ workDir, target }) {
  const cases = loadCases(workDir);
  if (cases.length === 0) {
    const summary = 'ケースが1つもありません（評価 AI の出力の不備）';
    writeFileSync(join(workDir, 'report.md'), `# 評価の報告\n\n${summary}\n`);
    return { code: 1, summary };
  }
  const results = cases.map((c) => {
    if (c.problem) return { ...c, actual: null, match: false };
    const actual = target.run(c.dir);
    return { ...c, actual, match: compare(c.expected, actual) };
  });
  const matched = results.filter((r) => r.match).length;
  const broken = results.filter((r) => r.problem).length;
  const summary = `ケース ${results.length} 件：一致 ${matched} 件・不一致 ${results.length - matched - broken} 件・出力の不備 ${broken} 件`;
  const questionsPath = join(workDir, 'questions.md');
  const questions = existsSync(questionsPath) ? readFileSync(questionsPath, 'utf8') : '';
  writeFileSync(join(workDir, 'report.md'), renderReport({ summary, results, questions }));
  return { code: matched === results.length ? 0 : 1, summary };
}

// 作業記録は作業フォルダの外に置き、評価 AI からは読めないようにする。
export function launchClaude({ args, cwd, log }) {
  const fd = openSync(log, 'w');
  try {
    const r = spawnSync('claude', args, { cwd, stdio: ['ignore', fd, fd] });
    return { status: r.error ? 1 : r.status };
  } finally {
    closeSync(fd);
  }
}

export function runEvaluation({ targetName, goalsDir = GOALS_DIR, workRoot = tmpdir(), launch = launchClaude }) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`評価対象 ${targetName} はありません（${Object.keys(TARGETS).join('・')} のどれか）`);
  const workDir = mkdtempSync(join(realpathSync(workRoot), 'saihai-eval-'));
  const specFiles = prepareWorkspace({ goalsDir, specIds: target.specIds, workDir });
  const log = `${workDir}.jsonl`;
  const { status } = launch({ args: evaluatorArgs(evaluatorPrompt(target, specFiles)), cwd: workDir, log });
  if (/budget/.test(resultSubtype(log))) {
    return { code: 1, workDir, summary: `費用の上限（${BUDGET_USD}ドル）に達したため、評価を止めました。人の判断が必要です。作業記録：${log}` };
  }
  if (status !== 0) return { code: 1, workDir, summary: `評価 AI が異常終了しました（終了コード ${status}）。作業記録：${log}` };
  return { ...evaluate({ workDir, target }), workDir };
}

// 作業記録の最後の result 行から、評価 AI がどう終わったかを読む。
export function resultSubtype(log) {
  if (!existsSync(log)) return '';
  const results = readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{') && line.includes('"type":"result"'))
    .map((line) => {
      try {
        return JSON.parse(line).subtype ?? '';
      } catch {
        return '';
      }
    });
  return results.at(-1) ?? '';
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// node tools/eval-goals.mjs [評価対象]            評価 AI を起動して評価する
// node tools/eval-goals.mjs --run-only <作業フォルダ>  評価 AI を起動せず、評価だけをやり直す
if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    const at = argv.indexOf('--run-only');
    const result =
      at === -1
        ? runEvaluation({ targetName: argv[0] ?? 'check-goals' })
        : { ...evaluate({ workDir: resolve(argv[at + 1]), target: TARGETS['check-goals'] }), workDir: resolve(argv[at + 1]) };
    process.stdout.write(`${result.summary}\n報告：${join(result.workDir, 'report.md')}\n`);
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`評価を実行できませんでした：${error.message}\n`);
    process.exitCode = 1;
  }
}
