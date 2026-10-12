import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditContacts, generateHidden, runHidden } from './eval-hidden.mjs';

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
const NO_BOUNDARY = VALID_GOAL.replace('## AI 層', '## 補足');
const PASS = { exit: 0, rules: [], reason: '違反なし' };
const BOUNDARY = { exit: 1, rules: ['G1.E2'], reason: '境界がない' };
const LINES = { exit: 1, rules: ['G1.E3'], reason: '長すぎる' };

const tempDir = (name) => mkdtempSync(join(tmpdir(), `saihai-hidden-test-${name}-`));

// 役割ごとに振る舞いを変える偽の AI。ケース名には中身を説明する名前を付ける（漏れないことを確かめるため）
function fakeLaunch({ cases, answers, statusFor = () => 0, logFor = () => '{"type":"system"}\n' }) {
  return ({ cwd, log }) => {
    const role = basename(cwd);
    writeFileSync(log, logFor(role));
    if (role === 'generator') {
      for (const [name, { goal, examples }] of Object.entries(cases)) {
        mkdirSync(join(cwd, 'cases', name), { recursive: true });
        writeFileSync(join(cwd, 'cases', name, 'G9-test.md'), goal);
        writeFileSync(join(cwd, 'cases', name, 'case.json'), JSON.stringify({ examples, note: `${name} を確かめる` }));
      }
    } else {
      const view = role.endsWith('A') ? 'A' : 'B';
      const index = JSON.parse(readFileSync(join(cwd, 'cases', 'index.json'), 'utf8'));
      for (const c of index) writeFileSync(join(cwd, 'cases', c.name, 'expected.json'), JSON.stringify(answers[c.name][view]));
    }
    return { status: statusFor(role) };
  };
}

const CASES = {
  'secret-boundary-missing': { goal: NO_BOUNDARY, examples: ['G1.E2'] },
  'secret-lines-bug': { goal: VALID_GOAL, examples: ['G1.E3'] },
  'secret-split': { goal: VALID_GOAL, examples: ['G1.E1'] },
};
const ANSWERS = {
  'secret-boundary-missing': { A: BOUNDARY, B: BOUNDARY },
  'secret-lines-bug': { A: LINES, B: LINES },
  'secret-split': { A: PASS, B: LINES },
};

function generate({ storeDir = tempDir('store'), workRoot = tempDir('work'), launch = fakeLaunch({ cases: CASES, answers: ANSWERS }) } = {}) {
  const result = generateHidden({ targetName: 'check-goals', goalsDir: GOALS_DIR, workRoot, storeDir, launch });
  return { ...result, storeDir, workRoot };
}

test('一致したケースだけを、通し番号を付けて保管場所に移す（E1）', () => {
  const { storeDir } = generate();
  const dir = join(storeDir, 'check-goals');
  assert.deepEqual(readdirSync(dir).filter((n) => /^h\d+$/.test(n)), ['h001', 'h002']);
  const expected = JSON.parse(readFileSync(join(dir, 'h001', 'expected.json'), 'utf8'));
  assert.deepEqual([expected.origin, expected.exit, expected.rules], ['secret-boundary-missing', 1, ['G1.E2']]);
  assert.ok(existsSync(join(dir, 'h001', 'G9-test.md')));
});

test('実装側に伝わる要約には、件数と具体例の ID だけが出る。ケース名は出ない（E1）', () => {
  const { summary } = generate();
  assert.match(summary, /隠しシナリオを 2 件追加/);
  assert.match(summary, /G1\.E2/);
  assert.doesNotMatch(summary, /secret-/);
});

test('割れたケースは隠しシナリオにせず、質問として見える場所に出す（E2）', () => {
  const { storeDir, reportDir } = generate();
  const stored = readdirSync(join(storeDir, 'check-goals')).filter((n) => /^h\d+$/.test(n)).map((n) => JSON.parse(readFileSync(join(storeDir, 'check-goals', n, 'expected.json'), 'utf8')).origin);
  assert.ok(!stored.includes('secret-split'));
  const questions = JSON.parse(readFileSync(join(reportDir, 'questions.json'), 'utf8'));
  assert.deepEqual(questions.map((q) => [q.kind, q.name]), [['split', 'secret-split']]);
});

test('保管が終わったら一時作業フォルダを消し、作業記録は保管場所に移す', () => {
  const { storeDir, workRoot } = generate();
  assert.deepEqual(readdirSync(workRoot), []);
  const logs = readdirSync(join(storeDir, 'check-goals', 'logs'));
  assert.equal(logs.length, 1);
  assert.deepEqual(readdirSync(join(storeDir, 'check-goals', 'logs', logs[0])).sort(), ['generator.jsonl', 'predictor-A.jsonl', 'predictor-B.jsonl']);
});

test('保管場所は git で管理され、追加が記録に残る（E5）', () => {
  const { storeDir } = generate();
  const log = spawnSync('git', ['log', '--oneline'], { cwd: storeDir, encoding: 'utf8' });
  assert.equal(log.status, 0);
  assert.equal(log.stdout.trim().split('\n').length, 1);
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: storeDir, encoding: 'utf8' });
  assert.equal(status.stdout, '');
});

test('2回目の追加は、続きの通し番号になる', () => {
  const storeDir = tempDir('store');
  generate({ storeDir });
  generate({ storeDir });
  assert.deepEqual(readdirSync(join(storeDir, 'check-goals')).filter((n) => /^h\d+$/.test(n)), ['h001', 'h002', 'h003', 'h004']);
});

test('隠しシナリオを実行すると、通った件数と落ちたものの通し番号・具体例の ID だけが出る（E3）', () => {
  const { storeDir } = generate();
  const r = runHidden({ targetName: 'check-goals', storeDir });
  assert.equal(r.code, 1);
  assert.match(r.summary, /隠しシナリオ 2 件：通過 1 件・失敗 1 件/);
  assert.match(r.summary, /h002（G1\.E3）/);
  assert.doesNotMatch(r.summary, /secret-|G9-test|## AI 層/);
});

test('隠しシナリオがすべて通れば終了コード0', () => {
  const storeDir = tempDir('store');
  generate({ storeDir, launch: fakeLaunch({ cases: { a: CASES['secret-boundary-missing'] }, answers: { a: ANSWERS['secret-boundary-missing'] } }) });
  assert.equal(runHidden({ targetName: 'check-goals', storeDir }).code, 0);
});

test('隠しシナリオがなければ、そのことを伝える', () => {
  const r = runHidden({ targetName: 'check-goals', storeDir: tempDir('store') });
  assert.equal(r.code, 1);
  assert.match(r.summary, /隠しシナリオがありません/);
});

test('途中で止まったら保管せず、一時作業フォルダは消して作業記録だけ保管場所に移す', () => {
  const launch = fakeLaunch({
    cases: CASES,
    answers: ANSWERS,
    statusFor: (role) => (role === 'generator' ? 1 : 0),
    logFor: (role) => (role === 'generator' ? `${JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd' })}\n` : ''),
  });
  const { code, summary, storeDir, workRoot } = generate({ launch });
  assert.equal(code, 1);
  assert.match(summary, /費用の上限/);
  assert.deepEqual(readdirSync(join(storeDir, 'check-goals')), ['logs']);
  assert.deepEqual(readdirSync(workRoot), []);
});

// 監査用の作業記録を作る。各道具の使用には、結果（許可・拒否・失敗・なし）を付けられる
function writeTranscript(entries) {
  const transcriptsDir = tempDir('transcripts');
  mkdirSync(join(transcriptsDir, 'project'), { recursive: true });
  const lines = entries.flatMap(({ tool, input, result }, i) => {
    const id = `toolu_${i}`;
    const use = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input }] } });
    if (result === undefined) return [use];
    const content = result === 'allowed' ? 'ok' : result === 'denied' ? 'Permission to use Bash has been denied.' : 'Error: No such tool available';
    const res = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: result !== 'allowed', content }] } });
    return [use, res];
  });
  writeFileSync(join(transcriptsDir, 'project', 'session-1.jsonl'), [...lines, 'not json'].join('\n'));
  return transcriptsDir;
}

const STORE = '/home/u/codes/saihai-evals';
const audit = (entries) => auditContacts({ transcriptsDir: writeTranscript(entries), storeDir: STORE, home: '/home/u' });

test('auditContacts: 保管場所を指す道具の使用と、保管場所のパスを含む Bash を一覧にする（J31）', () => {
  const { contacts, summary } = audit([
    { tool: 'Read', input: { file_path: `${STORE}/check-goals/h001/expected.json` }, result: 'denied' },
    { tool: 'Bash', input: { command: 'cat ~/codes/saihai-evals/check-goals/h001/G9-test.md' }, result: 'denied' },
    { tool: 'Grep', input: { pattern: 'x', path: `${STORE}/check-goals` }, result: 'denied' },
    { tool: 'Edit', input: { file_path: '/repo/.claude/settings.json', new_string: '"Read(~/codes/saihai-evals/**)"' }, result: 'allowed' },
    { tool: 'Read', input: { file_path: '/repo/goals/G1-goal-format.md' }, result: 'allowed' },
  ]);
  assert.deepEqual(contacts.map((c) => c.tool), ['Read', 'Bash', 'Grep']);
  assert.match(summary, /接触 3 件/);
});

test('auditContacts: 許可・拒否・失敗・結果不明を区別する（G5.E4）', () => {
  const { contacts, allowed, summary } = audit([
    { tool: 'Read', input: { file_path: `${STORE}/a` }, result: 'allowed' },
    { tool: 'Read', input: { file_path: `${STORE}/b` }, result: 'denied' },
    { tool: 'Grep', input: { path: STORE }, result: 'failed' },
    { tool: 'Read', input: { file_path: `${STORE}/c` } },
  ]);
  assert.deepEqual(contacts.map((c) => c.outcome), ['allowed', 'denied', 'failed', 'unknown']);
  assert.equal(allowed, 2);
  assert.match(summary, /許可 1 件・拒否 1 件・失敗 1 件・不明 1 件/);
});

test('auditContacts: 名前が似た別のパスと、ヒアドキュメントの本文は接触とみなさない', () => {
  const { contacts } = audit([
    { tool: 'Bash', input: { command: 'mkdir -p /tmp/x/saihai-evals-probe' }, result: 'allowed' },
    { tool: 'Bash', input: { command: "git commit -F - <<'EOF'\n隠しシナリオを ~/codes/saihai-evals に保管\nEOF" }, result: 'allowed' },
    { tool: 'Bash', input: { command: 'ls ~/codes/saihai-evals' }, result: 'denied' },
  ]);
  assert.deepEqual(contacts.map((c) => c.outcome), ['denied']);
});
