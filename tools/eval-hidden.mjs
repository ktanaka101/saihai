#!/usr/bin/env node
// 実装からは見えない評価（隠しシナリオ）を作って保管し、実行する（G3.3）。
// 実装側の AI に伝えるのは、件数と、通し番号・具体例の ID だけ。中身は保管場所の外に出さない。
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, compare, evaluatorArgs, launchClaude, prepareWorkspace } from './eval-goals.mjs';
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
// 引退したものも含めて、使った番号の続きを振る（記録の上で番号が重ならないように）
function usedNumbers(targetDir) {
  const retiredDir = join(targetDir, 'retired');
  const retired = existsSync(retiredDir) ? readdirSync(retiredDir).flatMap((stamp) => scenarioIds(join(retiredDir, stamp))) : [];
  return [...scenarioIds(targetDir), ...retired].map((n) => Number(n.match(SCENARIO)[1]));
}

function storeScenarios(results, targetDir) {
  const ids = usedNumbers(targetDir);
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

// 仕様を意図して変えたら、古い隠しシナリオは引退させる（retired/<日時>/ に移す）。中身は実装側に出さない
// only を渡すと、そのシナリオだけを引退させる（裁定の結果など）
export function retireHidden({ targetName, storeDir = STORE_DIR, reason = '仕様の変更', only }) {
  const targetDir = join(storeDir, targetName);
  const ids = scenarioIds(targetDir).filter((id) => !only || only.includes(id));
  if (ids.length === 0) return { code: 0, count: 0, summary: `引退させる隠しシナリオがありません（${targetName}）` };
  const dest = join(targetDir, 'retired', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dest, { recursive: true });
  for (const id of ids) renameSync(join(targetDir, id), join(dest, id));
  const what = only ? `${ids.join('・')} ` : `${ids.length} 件`;
  const committed = commitStore(storeDir, `隠しシナリオ ${what}を引退（${targetName}、${reason}）`);
  return {
    code: committed ? 0 : 1,
    count: ids.length,
    dest,
    summary: `隠しシナリオ ${what}を引退させました（理由：${reason}）${committed ? '' : '。保管場所の git への記録に失敗しました'}`,
  };
}

// --- 裁定（G3.4）：落ちた隠しシナリオの期待が仕様から導けるかを、実装を見ない別の AI が確かめる ---
// 2つの評価 AI は同じモデルなので、同じ読み違いで一致しうる。実装側が原因を見つけられないとき、推測で直し続けずにここで決着させる

const APPEAL_BUDGET_USD = 1.5;
const VERDICTS = ['期待が正しい', '実装が正しい', '仕様から決まらない'];

function adjudicatorPrompt(target, specFiles) {
  return `あなたは「裁定役」です。実装は見ずに、仕様（spec/ のゴール文書）だけを根拠に裁定します。

${target.description}

仕様のファイルは次のとおり（これ以外にはありません）。
${specFiles.map((name) => `- spec/${name}`).join('\n')}

case/ には、評価対象に検査させた入力（*.md）と、2つの評価 AI が独立に仕様から導いて一致した期待（case/expected.json の exit と rules。reasons は2つの評価 AI の理由）があります。
actual.json は、今の実装が同じ入力に返した結果です。期待と実装が食い違っています。

## やること

1. spec/ と case/ と actual.json を読む
2. 仕様の文言だけから、どちらが正しいかを裁定する。2つの評価 AI が同じ読み違いをしている可能性も疑う
   - 期待が正しい：仕様の文言から期待が導け、実装はそれに反している
   - 実装が正しい：仕様の文言から実装の結果が導け、期待は仕様に反している
   - 仕様から決まらない：仕様の文言からはどちらとも決められない（人が仕様を決める必要がある）
3. verdict.json に次の形で書く
   {"verdict": "期待が正しい", "quote": "根拠にした仕様の一文", "question": "仕様から決まらないときだけ、人に聞く問い（それ以外は空）"}

## 守ること

- quote には、spec/ のどれかのファイルの1行から、根拠の部分をそのまま写す（言い換え・要約・入力の説明を混ぜない）。quote 以外は実装側に伝わらない
- spec/・case/・actual.json 以外のファイルを読まない。verdict.json 以外のファイルを書かない
`;
}

function readVerdict(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return VERDICTS.includes(v.verdict) && typeof v.quote === 'string' ? v : null;
  } catch {
    return null;
  }
}

// 実装側に返すのは、仕様にそのまま書かれている1行の中の文だけ（隠しシナリオの中身を混ぜさせない）。
// 裁定役は作業フォルダの仕様の写しを書き換えられるので、照合はリポジトリの原本で行う
function quotedFromSpec(quote, goalsDir, specFiles) {
  const q = quote.trim();
  if (q.length < 8 || /[\r\n]/.test(q)) return null;
  return specFiles.some((name) => readFileSync(join(goalsDir, name), 'utf8').includes(q)) ? q : null;
}

function writeAppealReport({ id, scenarioDir, verdict }) {
  const reportDir = mkdtempSync(join(realpathSync(tmpdir()), 'saihai-appeal-report-'));
  const caseDir = join(reportDir, 'case');
  mkdirSync(caseDir, { recursive: true });
  for (const name of readdirSync(scenarioDir)) copyFileSync(join(scenarioDir, name), join(caseDir, name));
  const lines = [
    `# 仕様から決まらなかった隠しシナリオ（${id}。引退済み）`,
    '',
    `- 人への問い：${verdict.question || '（裁定役が問いを書かなかった）'}`,
    `- 関わる仕様：${verdict.quote}`,
    `- 入力と、2つの評価 AI の期待：${caseDir}`,
    '',
  ];
  writeFileSync(join(reportDir, 'report.md'), lines.join('\n'));
  return reportDir;
}

export function appealHidden({ targetName, id, goalsDir = GOALS_DIR, workRoot = tmpdir(), storeDir = STORE_DIR, launch = launchClaude }) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`評価対象 ${targetName} はありません（${Object.keys(TARGETS).join('・')} のどれか）`);
  const targetDir = join(storeDir, targetName);
  const scenarioDir = join(targetDir, id ?? '');
  if (!id || !scenarioIds(targetDir).includes(id)) return { code: 1, summary: `隠しシナリオ ${id} がありません（${targetName}）` };
  let expected;
  try {
    expected = JSON.parse(readFileSync(join(scenarioDir, 'expected.json'), 'utf8'));
  } catch {
    // 例外の文には中身の一部が混ざるので、決まった文言だけを返す
    return { code: 1, summary: `${id} の expected.json を読めません。保管場所の記録を確かめてください` };
  }
  const actual = target.run(scenarioDir);
  if (compare(expected, actual)) return { code: 0, summary: `${id} は今の実装で通っているので、裁定は要りません` };

  const root = mkdtempSync(join(realpathSync(workRoot), 'saihai-appeal-'));
  const workDir = join(root, 'adjudicator');
  try {
    mkdirSync(join(workDir, 'case'), { recursive: true });
    const specFiles = prepareWorkspace({ goalsDir, specIds: target.specIds, workDir });
    for (const name of readdirSync(scenarioDir)) copyFileSync(join(scenarioDir, name), join(workDir, 'case', name));
    writeFileSync(join(workDir, 'actual.json'), JSON.stringify(actual, null, 2));
    const { status } = launch({ args: evaluatorArgs(adjudicatorPrompt(target, specFiles), APPEAL_BUDGET_USD), cwd: workDir, log: join(root, 'adjudicator.jsonl') });
    const verdict = status === 0 ? readVerdict(join(workDir, 'verdict.json')) : null;
    const quote = verdict && quotedFromSpec(verdict.quote, goalsDir, specFiles);
    moveLogs(root, targetDir);
    commitStore(storeDir, `隠しシナリオ ${id} の裁定の記録（${targetName}）`);
    if (!verdict) return { code: 1, summary: `${id} の裁定ができませんでした（裁定役の終了コード ${status}、または verdict.json の不備）` };
    if (!quote) return { code: 1, summary: `${id} の裁定は「${verdict.verdict}」でしたが、根拠の一文が仕様にありません。中身が漏れうるので根拠は返しません` };
    if (verdict.verdict === '期待が正しい') {
      return { code: 1, summary: `${id} の裁定：期待が仕様どおりです。実装を直してください。根拠の仕様：「${quote}」` };
    }
    if (verdict.verdict === '実装が正しい') {
      const r = retireHidden({ targetName, storeDir, reason: `裁定で期待が仕様に反していた（根拠：${quote}）`, only: [id] });
      return { code: r.code, summary: `${id} の裁定：期待が仕様に反していたので、${id} を引退させました。根拠の仕様：「${quote}」` };
    }
    const retired = retireHidden({ targetName, storeDir, reason: '裁定で仕様から決まらなかった', only: [id] });
    const reportDir = writeAppealReport({ id, scenarioDir: join(retired.dest, id), verdict: { ...verdict, quote } });
    const note = retired.code === 0 ? '' : '。保管場所の git への記録に失敗しました';
    return { code: 1, reportDir, summary: `${id} の裁定：仕様から決まらないので引退させ、人への問いにしました（${join(reportDir, 'report.md')}）${note}` };
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
// node tools/eval-hidden.mjs retire [評価対象] [理由] 隠しシナリオをすべて引退させる
// node tools/eval-hidden.mjs appeal [評価対象] [h番号] 落ちた隠しシナリオを裁定する（G3.4）
// node tools/eval-hidden.mjs audit                 保管場所への接触を作業記録から探す
if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, targetName = 'check-goals'] = process.argv.slice(2);
  try {
    const result =
      command === 'generate'
        ? generateHidden({ targetName })
        : command === 'run'
          ? runHidden({ targetName })
          : command === 'retire'
            ? retireHidden({ targetName, reason: process.argv[4] })
          : command === 'appeal'
            ? appealHidden({ targetName, id: process.argv[4] })
          : command === 'audit'
            ? (({ summary, allowed }) => ({ summary, code: allowed ? 1 : 0 }))(auditContacts())
            : { code: 1, summary: '使い方：eval-hidden.mjs generate|run|retire|appeal [評価対象] または eval-hidden.mjs audit' };
    process.stdout.write(`${result.summary}\n`);
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`実行できませんでした：${error.message}\n`);
    process.exitCode = 1;
  }
}
