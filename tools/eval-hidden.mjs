#!/usr/bin/env node
// 実装からは見えない評価（隠しシナリオ）を作って保管し、実行する（G3.3）。
// 実装側の AI に伝えるのは、件数と、通し番号・具体例の ID だけ。中身は保管場所の外に出さない。
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, compare } from './eval-goals.mjs';
import { generateAndPredict, selectQuestions } from './eval-split.mjs';

const GOALS_DIR = fileURLToPath(new URL('../goals/', import.meta.url));
const STORE_DIR = join(homedir(), 'codes', 'saihai-evals'); // J32
const TRANSCRIPTS_DIR = join(homedir(), '.claude', 'projects');
const SCENARIO = /^h(\d+)$/;

const scenarioIds = (targetDir) => (existsSync(targetDir) ? readdirSync(targetDir).filter((n) => SCENARIO.test(n)).sort() : []);
const scenarioName = (n) => `h${String(n).padStart(3, '0')}`;
const label = ({ id, examples }) => `${id}（${examples.join('・') || '具体例不明'}）`;

function countExamples(stored) {
  const counts = stored.flatMap((s) => s.examples).reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map());
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, n]) => `${id} ×${n}`).join('・');
}

// 2つの評価 AI が一致したケース（実装と違ったものも含む）を、中身の分からない通し番号で保管する
function storeScenarios(results, targetDir) {
  const ids = scenarioIds(targetDir).map((n) => Number(n.match(SCENARIO)[1]));
  const first = ids.length ? Math.max(...ids) + 1 : 1;
  return results
    .filter((r) => r.kind === 'agreed' || r.kind === 'bug')
    .map((r, i) => {
      const id = scenarioName(first + i);
      const dir = join(targetDir, id);
      mkdirSync(dir, { recursive: true });
      for (const file of r.files) copyFileSync(join(r.dir, file), join(dir, file));
      const expected = { examples: r.examples, exit: r.a.exit, rules: r.a.rules, origin: r.name, note: r.note, reasons: { A: r.a.reason, B: r.b.reason } };
      writeFileSync(join(dir, 'expected.json'), JSON.stringify(expected, null, 2));
      return { id, examples: r.examples, passed: r.kind === 'agreed' };
    });
}

// 評価 AI の作業記録には、書いたファイルの中身が残る。保管場所に移して、実装側から隔てる
function moveLogs(root, targetDir) {
  const dest = join(targetDir, 'logs', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(root).filter((n) => n.endsWith('.jsonl'))) copyFileSync(join(root, name), join(dest, name));
}

// 保管場所のコミットでは利用者のフックを動かさず、git の出力も捨てる（フックやメッセージから中身が漏れないように）
function commitStore(storeDir, message) {
  const git = (...args) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: storeDir, stdio: 'ignore' }).status;
  if (!existsSync(join(storeDir, '.git')) && git('init', '-q') !== 0) return false;
  return git('add', '-A') === 0 && git('commit', '-q', '-m', message) === 0;
}

// 割れたケースは仕様が曖昧なので隠さない。質問として、見える場所に入力の写しと一緒に出す（E2）
function writeVisibleReport({ splits, problems }) {
  const reportDir = mkdtempSync(join(realpathSync(tmpdir()), 'saihai-hidden-report-'));
  const copied = splits.map((s) => {
    const dir = join(reportDir, 'cases', s.name);
    mkdirSync(dir, { recursive: true });
    for (const file of s.files) copyFileSync(join(s.dir, file), join(dir, file));
    return { ...s, dir };
  });
  const { asked, deferred } = selectQuestions({ splits: copied, agreed: [] });
  const describe = (r) => `${r.exit} / ${r.rules.length ? r.rules.join('・') : '違反なし'}`;
  const lines = [
    '# 隠しシナリオづくりで割れたケース',
    '',
    '割れたケースは隠しシナリオにしていない。答えは「終了コード / 違反の ID」。',
    '',
    '## 人への質問',
    '',
    ...(asked.length
      ? asked.flatMap((q) => [
          `### ${q.name}`,
          '',
          `- 確かめたいこと：${q.examples.join('・')}　${q.note}`,
          `- 評価 AI A（文言に厳密）：${describe(q.a)}。${q.a.reason ?? ''}`,
          `- 評価 AI B（意図に沿う）：${describe(q.b)}。${q.b.reason ?? ''}`,
          `- 今の実装：${describe(q.actual)}`,
          `- 入力：${q.files.map((f) => join(q.dir, f)).join('、')}`,
          '',
        ])
      : ['なし', '']),
    '## 事後通知（質問の上限を超えた割れ）',
    '',
    ...(deferred.length ? deferred.map((s) => `- ${s.name}：今の実装の ${describe(s.actual)} を仮の答えにする`) : ['なし']),
    '',
    '## 出力の不備',
    '',
    ...(problems.length ? problems.map((p) => `- ${p.name}：${p.problem}`) : ['なし']),
    '',
  ];
  writeFileSync(join(reportDir, 'questions.json'), JSON.stringify(asked, null, 2));
  writeFileSync(join(reportDir, 'report.md'), lines.join('\n'));
  return reportDir;
}

export function generateHidden({ targetName, goalsDir = GOALS_DIR, workRoot = tmpdir(), storeDir = STORE_DIR, launch }) {
  const targetDir = join(storeDir, targetName);
  mkdirSync(targetDir, { recursive: true });
  const { root, results, stopped } = generateAndPredict({ targetName, goalsDir, workRoot, launch, prefix: 'saihai-hidden-' });
  try {
    if (stopped) {
      moveLogs(root, targetDir);
      commitStore(storeDir, `隠しシナリオづくりが途中で止まった記録（${targetName}）`);
      return { code: 1, summary: `${stopped}（作業記録は保管場所に移しました）`, reportDir: null };
    }
    const stored = storeScenarios(results, targetDir);
    const splits = results.filter((r) => r.kind === 'split');
    const problems = results.filter((r) => r.kind === 'problem');
    const reportDir = splits.length || problems.length ? writeVisibleReport({ splits, problems }) : null;
    moveLogs(root, targetDir);
    const committed = commitStore(storeDir, `隠しシナリオを ${stored.length} 件追加（${targetName}）`);
    const failed = stored.filter((s) => !s.passed);
    const summary = [
      `隠しシナリオを ${stored.length} 件追加しました（${countExamples(stored) || 'なし'}）`,
      `今の実装で通ったのは ${stored.length - failed.length} 件、落ちたのは ${failed.length} 件${failed.length ? `：${failed.map(label).join('、')}` : ''}`,
      `割れ ${splits.length} 件・出力の不備 ${problems.length} 件${reportDir ? `（${join(reportDir, 'report.md')}）` : ''}`,
      ...(committed ? [] : ['保管場所の git への記録に失敗しました']),
    ].join('。');
    const clean = failed.length === 0 && splits.length === 0 && problems.length === 0 && committed;
    return { code: clean ? 0 : 1, summary, reportDir };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function runHidden({ targetName, storeDir = STORE_DIR }) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`評価対象 ${targetName} はありません（${Object.keys(TARGETS).join('・')} のどれか）`);
  const targetDir = join(storeDir, targetName);
  const ids = scenarioIds(targetDir);
  if (ids.length === 0) return { code: 1, summary: `隠しシナリオがありません（${targetName}）` };
  const failures = ids.flatMap((id) => {
    const dir = join(targetDir, id);
    try {
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
      return compare(expected, target.run(dir)) ? [] : [{ id, examples: expected.examples ?? [] }];
    } catch {
      return [{ id, examples: [] }];
    }
  });
  const summary = [
    `隠しシナリオ ${ids.length} 件：通過 ${ids.length - failures.length} 件・失敗 ${failures.length} 件`,
    ...failures.map((f) => `- ${label(f)}`),
  ].join('\n');
  return { code: failures.length ? 1 : 0, summary, total: ids.length, failed: failures.length };
}

function listTranscripts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listTranscripts(path) : name.endsWith('.jsonl') ? [path] : [];
  });
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 保管場所のパスそのもの（絶対パスか ~ からのパス）に一致させる。saihai-evals-probe のような別のパスは拾わない
function storePattern(storeDir, home) {
  const forms = [storeDir, ...(storeDir.startsWith(`${home}/`) ? [`~${storeDir.slice(home.length)}`] : [])];
  return new RegExp(`(${forms.map(escapeRegExp).join('|')})(?=$|[/\\s"'\`)])`);
}

// ヒアドキュメントの本文（コミットメッセージなど）はデータなので、最初の << より前だけを見る
const commandHead = (command) => command.split('<<')[0];

function readEntries(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function outcomeOf(result) {
  if (!result) return 'unknown';
  if (!result.is_error) return 'allowed';
  return /denied|permission/i.test(JSON.stringify(result.content ?? '')) ? 'denied' : 'failed';
}

// 作業記録を走査し、保管場所への接触（保管場所を指す道具の使用と、保管場所のパスを含む Bash）を一覧にする（J31）。
// 道具の使用と結果を突き合わせ、許可・拒否・失敗・結果不明に分ける。門番は許可と不明を問題にする（G5.E4）。
// ファイルに書き込む中身（設定やゴール文書に保管場所の名前を書くこと）は接触とみなさない。
export function auditContacts({ transcriptsDir = TRANSCRIPTS_DIR, storeDir = STORE_DIR, home = homedir() } = {}) {
  const pattern = storePattern(storeDir, home);
  const touches = (input = {}) =>
    [input.file_path, input.path, input.notebook_path].some((v) => typeof v === 'string' && pattern.test(v)) ||
    (typeof input.command === 'string' && pattern.test(commandHead(input.command)));
  const files = listTranscripts(transcriptsDir);
  const contacts = files.flatMap((file) => {
    const entries = readEntries(file);
    const contentOf = (type) => entries.filter((e) => e.type === type).flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
    const results = new Map(contentOf('user').filter((i) => i.type === 'tool_result').map((i) => [i.tool_use_id, i]));
    return contentOf('assistant')
      .filter((i) => i.type === 'tool_use' && touches(i.input))
      .map((i) => ({ file, tool: i.name, outcome: outcomeOf(results.get(i.id)) }));
  });
  const count = (outcome) => contacts.filter((c) => c.outcome === outcome).length;
  const byFile = [...new Set(contacts.map((c) => c.file))].map((file) => `- ${file}：${contacts.filter((c) => c.file === file).length} 件`);
  const summary = [
    `作業記録 ${files.length} 件を調べ、保管場所への接触 ${contacts.length} 件（許可 ${count('allowed')} 件・拒否 ${count('denied')} 件・失敗 ${count('failed')} 件・不明 ${count('unknown')} 件）`,
    ...byFile,
  ].join('\n');
  return { contacts, allowed: count('allowed') + count('unknown'), summary };
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// node tools/eval-hidden.mjs generate [評価対象]   隠しシナリオを作って保管する
// node tools/eval-hidden.mjs run [評価対象]        隠しシナリオを実行する
// node tools/eval-hidden.mjs audit                 保管場所への接触を作業記録から探す
if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, targetName = 'check-goals'] = process.argv.slice(2);
  try {
    const result =
      command === 'generate'
        ? generateHidden({ targetName })
        : command === 'run'
          ? runHidden({ targetName })
          : command === 'audit'
            ? (({ summary, allowed }) => ({ summary, code: allowed ? 1 : 0 }))(auditContacts())
            : { code: 1, summary: '使い方：eval-hidden.mjs generate|run [評価対象] または eval-hidden.mjs audit' };
    process.stdout.write(`${result.summary}\n`);
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`実行できませんでした：${error.message}\n`);
    process.exitCode = 1;
  }
}
