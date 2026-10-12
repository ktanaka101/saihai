#!/usr/bin/env node
// 2つの評価 AI に、同じケースの期待する結果を独立に書かせる。答えが割れたケースだけを人への質問にする（G3.2）。
// どのプロセスも G3.1 と同じ隔離（道具は読み書きの3つ、MCP なし、ホーム以下の読み書き禁止）で起動する。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, compare, evaluatorArgs, launchClaude, prepareWorkspace, resultSubtype } from './eval-goals.mjs';

const GOALS_DIR = fileURLToPath(new URL('../goals/', import.meta.url));
const BUDGETS = { generator: 2, predictor: 1.5 }; // 全体で5ドル（J26）
const MAX_QUESTIONS = 5; // 見本を含む（J27）
const LABELS = { generator: 'ケースを作る AI', 'predictor-A': '評価 AI A', 'predictor-B': '評価 AI B' };

// 同じモデル同士が同じ誤解を共有しないよう、読み方を変える（G3 の既知の落とし穴）
const VIEWPOINTS = {
  A: '仕様の文言に厳密に従って判断してください。書かれていないことは、書かれている規則から最も直接に導ける答えにしてください。',
  B: 'ゴールを書く人の意図（各ゴールの「意図」の節）に沿って判断してください。文言と意図がずれる場合は、意図を優先してください。',
};

const specList = (specFiles) =>
  `仕様のファイルは次のとおり（これ以外にはありません）。\n${specFiles.map((name) => `- spec/${name}`).join('\n')}`;

function generatorPrompt(target, specFiles) {
  return `あなたは「ケースを作る AI」です。実装を見ずに、仕様（spec/ のゴール文書）だけから、評価に使う入力を作ります。

${target.description}

${specList(specFiles)}

## やること

1. spec/ を読み、仕様の \`[機械]\` の具体例と書式の定義から、評価対象が満たすべき振る舞いを洗い出す
2. 振る舞いごとに cases/<ケース名>/ を作り、検査させるゴール文書（*.md）と case.json を置く。20件前後。正しい入力も違反する入力も作り、仕様の読み方によって結果が変わりそうな境界や、紛らわしい書き方を重視する
3. case.json は次の形で書く
   {"examples": ["G1.E3"], "note": "確かめたいこと"}
   - examples：このケースが確かめる具体例
   - note：何を確かめるケースか。期待する結果（違反になるか、どの ID か）は書かない

## 守ること

- 期待する結果は書かないでください。別の評価 AI が、あなたのケースを見て独立に書きます
- あなたは評価対象を実行できません。作業フォルダの外を読もうとしないでください
- 最後に、作ったケースの数を1行で出力してください`;
}

function predictorPrompt(target, specFiles, view) {
  return `あなたは「評価 AI」です。実装を見ずに、仕様（spec/ のゴール文書）だけから、各ケースの期待する結果を書きます。

${target.description}

${specList(specFiles)}

ケースの一覧は cases/index.json にあります。各ケースは cases/<name>/ にあり、files に挙げたゴール文書が検査の入力です。examples と note は、ケースを作った AI が書いた「確かめたいこと」です。

## 判断の観点

${VIEWPOINTS[view]}

## やること

すべてのケースについて、cases/<name>/expected.json に次の形で書く。
{"exit": 1, "rules": ["G1.E3"], "reason": "短い理由"}
- exit と rules：期待する終了コードと、期待する違反の ID の一覧（違反がなければ []）
- reason：その答えにした理由を1〜2文で

## 守ること

- あなたは評価対象を実行できません。期待は仕様だけから導いてください
- 作業フォルダの外を読もうとしないでください
- 最後に、書いた expected.json の数を1行で出力してください`;
}

function readJson(path) {
  if (!existsSync(path)) return { value: null, problem: `${path.split('/').at(-1)} がありません` };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), problem: null };
  } catch (error) {
    return { value: null, problem: `${path.split('/').at(-1)} を読めません：${error.message}` };
  }
}

function listInputs(generatorDir) {
  const casesDir = join(generatorDir, 'cases');
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = join(casesDir, name);
      const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
      const { value, problem } = readJson(join(dir, 'case.json'));
      const shapeOk = value !== null && Array.isArray(value.examples);
      const reason = problem ?? (shapeOk ? (files.length ? null : '入力のゴール文書がありません') : 'case.json の形が違います（examples が必要）');
      return { name, dir, files, examples: shapeOk ? value.examples : [], note: shapeOk ? String(value.note ?? '') : '', problem: reason };
    });
}

function copyInputs(inputs, workDir) {
  for (const input of inputs) {
    mkdirSync(join(workDir, 'cases', input.name), { recursive: true });
    for (const file of input.files) copyFileSync(join(input.dir, file), join(workDir, 'cases', input.name, file));
  }
  const index = inputs.map(({ name, files, examples, note }) => ({ name, files, examples, note }));
  writeFileSync(join(workDir, 'cases', 'index.json'), JSON.stringify(index, null, 2));
}

function readPrediction(path) {
  const { value, problem } = readJson(path);
  if (problem) return { value: null, problem };
  const ok =
    value !== null &&
    typeof value === 'object' &&
    (value.exit === 0 || value.exit === 1) &&
    Array.isArray(value.rules) &&
    value.rules.every((rule) => typeof rule === 'string');
  return ok ? { value, problem: null } : { value: null, problem: 'expected.json の形が違います（exit・rules が必要）' };
}

// 見本は、一致したケースのうち、具体例が最も少なく確かめられているものから選ぶ（偏りを避ける）。
function pickSample(agreed) {
  const count = (id) => agreed.filter((c) => c.examples[0] === id).length;
  return [...agreed].sort((x, y) => count(x.examples[0]) - count(y.examples[0]) || x.name.localeCompare(y.name))[0] ?? null;
}

// 人に届くのは見本を含めて5件まで（J27）。合否（終了コード）が割れたものを、違反の種類だけが割れたものより先に選ぶ。
export function selectQuestions({ splits, agreed }) {
  const exitSplit = (s) => s.a.exit !== s.b.exit;
  const ordered = [...splits.filter(exitSplit), ...splits.filter((s) => !exitSplit(s))];
  const sample = pickSample(agreed);
  const room = MAX_QUESTIONS - (sample ? 1 : 0);
  return {
    asked: [...ordered.slice(0, room).map((s) => ({ ...s, kind: 'split' })), ...(sample ? [{ ...sample, kind: 'sample' }] : [])],
    deferred: ordered.slice(room),
  };
}

const describe = (r) => (r ? `${r.exit} / ${r.rules.length ? r.rules.join('・') : '違反なし'}` : '―');

function renderReport({ summary, results, asked, deferred }) {
  const input = (c) => c.files.map((f) => join(c.dir, f)).join('、');
  const question = (q) =>
    q.kind === 'split'
      ? [
          `### ${q.name}（割れ）`,
          '',
          `- 確かめたいこと：${q.examples.join('・')}　${q.note}`,
          `- 評価 AI A（文言に厳密）：${describe(q.a)}。${q.a.reason ?? ''}`,
          `- 評価 AI B（意図に沿う）：${describe(q.b)}。${q.b.reason ?? ''}`,
          `- 今の実装：${describe(q.actual)}`,
          `- 入力：${input(q)}`,
        ].join('\n')
      : [
          `### ${q.name}（一致した見本）`,
          '',
          `- 確かめたいこと：${q.examples.join('・')}　${q.note}`,
          `- 2つの評価 AI と実装の答え：${describe(q.a)}。${q.a.reason ?? ''}`,
          `- 入力：${input(q)}`,
        ].join('\n');
  const bugs = results.filter((r) => r.kind === 'bug').map((r) => `- ${r.name}：期待 ${describe(r.a)}、実装 ${describe(r.actual)}（入力：${input(r)}）`);
  const problems = results.filter((r) => r.kind === 'problem').map((r) => `- ${r.name}：${r.problem}`);
  const later = deferred.map((s) => `- ${s.name}：A ${describe(s.a)}、B ${describe(s.b)}。仮の答えは今の実装の ${describe(s.actual)}`);
  const orNone = (lines) => (lines.length ? lines : ['なし']);
  return [
    '# 解釈の割れの報告',
    '',
    summary,
    '',
    '答えは「終了コード / 違反の ID」。',
    '',
    '## 人への質問',
    '',
    ...orNone(asked.map(question)).flatMap((q) => [q, '']),
    '## 実装の不具合（2つの評価 AI は一致したが、実装が違う）',
    '',
    ...orNone(bugs),
    '',
    '## 事後通知（質問の上限を超えた割れ。今の実装の振る舞いを仮の答えにする）',
    '',
    ...orNone(later),
    '',
    '## 出力の不備',
    '',
    ...orNone(problems),
    '',
  ].join('\n');
}

function stop(root, summary) {
  writeFileSync(join(root, 'report.md'), `# 解釈の割れの報告\n\n${summary}\n`);
  return { code: 1, summary, root };
}

export function runSplitEvaluation({ targetName, goalsDir = GOALS_DIR, workRoot = tmpdir(), launch = launchClaude }) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`評価対象 ${targetName} はありません（${Object.keys(TARGETS).join('・')} のどれか）`);
  const root = mkdtempSync(join(realpathSync(workRoot), 'saihai-split-'));

  // 1つのプロセスを起動する。問題があれば、評価全体を止める理由を返す
  const step = (role, prompt, budget, prepare = () => {}) => {
    const cwd = join(root, role);
    const specFiles = prepareWorkspace({ goalsDir, specIds: target.specIds, workDir: cwd });
    prepare(cwd);
    const log = `${cwd}.jsonl`;
    const { status } = launch({ args: evaluatorArgs(prompt(specFiles), budget), cwd, log });
    if (/budget/.test(resultSubtype(log))) {
      return `${LABELS[role]}が費用の上限（${budget}ドル）に達したため、評価全体を止めました。人の判断が必要です。作業記録：${log}`;
    }
    return status === 0 ? null : `${LABELS[role]}が異常終了しました（終了コード ${status}）。作業記録：${log}`;
  };

  const generated = step('generator', (specs) => generatorPrompt(target, specs), BUDGETS.generator);
  if (generated) return stop(root, generated);
  const inputs = listInputs(join(root, 'generator'));
  const valid = inputs.filter((i) => !i.problem);
  if (valid.length === 0) return stop(root, 'ケースが1つもありません（ケースを作る AI の出力の不備）');
  for (const view of ['A', 'B']) {
    const predicted = step(`predictor-${view}`, (specs) => predictorPrompt(target, specs, view), BUDGETS.predictor, (cwd) => copyInputs(valid, cwd));
    if (predicted) return stop(root, predicted);
  }

  const results = inputs.map((input) => {
    if (input.problem) return { ...input, kind: 'problem', problem: `ケースを作る AI：${input.problem}` };
    const a = readPrediction(join(root, 'predictor-A', 'cases', input.name, 'expected.json'));
    const b = readPrediction(join(root, 'predictor-B', 'cases', input.name, 'expected.json'));
    if (a.problem || b.problem) {
      return { ...input, kind: 'problem', problem: [a.problem && `評価 AI A：${a.problem}`, b.problem && `評価 AI B：${b.problem}`].filter(Boolean).join('／') };
    }
    const actual = target.run(input.dir);
    if (!compare(a.value, b.value)) return { ...input, kind: 'split', a: a.value, b: b.value, actual };
    return { ...input, kind: compare(a.value, actual) ? 'agreed' : 'bug', a: a.value, b: b.value, actual };
  });

  const of = (kind) => results.filter((r) => r.kind === kind);
  const { asked, deferred } = selectQuestions({ splits: of('split'), agreed: of('agreed') });
  const summary = [
    `ケース ${results.length} 件：一致 ${of('agreed').length + of('bug').length} 件（うち実装の不具合 ${of('bug').length} 件）`,
    `割れ ${of('split').length} 件`,
    `出力の不備 ${of('problem').length} 件。人への質問 ${asked.length} 件・事後通知 ${deferred.length} 件`,
  ].join('・');
  writeFileSync(join(root, 'questions.json'), JSON.stringify(asked, null, 2));
  writeFileSync(join(root, 'report.md'), renderReport({ summary, results, asked, deferred }));
  const clean = of('bug').length + of('split').length + of('problem').length === 0;
  return { code: clean ? 0 : 1, summary, root };
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// node tools/eval-split.mjs [評価対象]
if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { code, summary, root } = runSplitEvaluation({ targetName: process.argv[2] ?? 'check-goals' });
    process.stdout.write(`${summary}\n報告：${join(root, 'report.md')}\n質問：${join(root, 'questions.json')}\n`);
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`評価を実行できませんでした：${error.message}\n`);
    process.exitCode = 1;
  }
}
