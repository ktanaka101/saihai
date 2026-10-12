import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGoal } from './check-goals.mjs';
import {
  collectCheckMetric,
  collectDecisionMetrics,
  collectGitMetrics,
  collectGoalMetrics,
  collectProbeMetrics,
  collectRecordMetrics,
  collectTranscriptMetrics,
  derivedMetrics,
  judgeHypotheses,
  observe,
  observeAll,
  previousValues,
  recordObservation,
  renderReport,
  saveSnapshot,
} from './observe.mjs';

const doc = ({ id, status = '進行中', judgments = [], pending = 0 }) => `---
id: ${id}
parent: null
status: ${status}
version: 0.1
updated: 2026-10-12
---

# ${id} テスト

> 要約

${pending ? `## 判断待ち\n\n${Array.from({ length: pending }, (_, i) => `### Q${90 + i} 問い\n\n- 推奨：A\n- 自明な案：B\n- 取り消し：可能\n`).join('\n')}\n` : ''}## 意図

- 目的：目的の本文
- 理由：理由の本文
- 望ましい最終状態：最終状態の本文

## 仮説と判定

- 仮説：なし（理由：テスト用）

## 具体例

- E1 \`[機械]\` 例

---

## AI 層

| ID | 日付 | 判断 | 強さ | 上申 | 置き換え |
|---|---|---|---|---|---|
${judgments.map((j, i) => `| J${i + 1} | 2026-10-12 | ${j.text} | ${j.text.includes('推奨を採用') ? '仮置き' : '推奨'} | ${j.from} | ${j.replaces ?? '―'} |`).join('\n')}
`;

const goals = [
  parseGoal('goals/G1-a.md', doc({ id: 'G1', status: '達成', judgments: [{ text: '人が決めた', from: 'Q1' }, { text: '会話で決めた', from: '―' }] })),
  parseGoal('goals/G2-b.md', doc({ id: 'G2', judgments: [{ text: 'X とする。推奨を採用（J37）', from: 'Q2' }], pending: 2 })),
];
const metric = (metrics, name) => metrics.find((m) => m.name === name);

test('ゴール文書から、状態と判断の件数を、人が答えたもの・会話で決まったもの・推奨を採用したものに分けて数える（E3）', () => {
  const metrics = collectGoalMetrics(goals);
  assert.equal(metric(metrics, 'ゴールの状態').value, '達成 1・進行中 1');
  assert.equal(metric(metrics, '判断の内訳').value, '人が答えた 1・会話で決まった 1・推奨を採用 1');
  // 導入先の包括的な指示は別の番号になる（G9）
  const other = parseGoal('goals/G3-c.md', doc({ id: 'G3', judgments: [{ text: 'Y とする。推奨を採用（J5）', from: 'Q9' }] }));
  assert.match(metric(collectGoalMetrics([other]), '判断の内訳').value, /推奨を採用 1/);
  assert.equal(metric(metrics, '1ゴールあたりの人の判断').value, '1.0');
  assert.equal(metric(metrics, '判断待ち').value, '2');
});

test('置き換えられた判断の割合を出す。推奨を人が過信していないかを、後から置き換えた判断で確かめる（G2 の事後検証・J67）', () => {
  const replaced = parseGoal('goals/G3-c.md', doc({ id: 'G3', judgments: [{ text: 'A とする。推奨を採用（J37）', from: 'Q3' }, { text: 'B とする', from: '―' }, { text: 'A をやめて C とする', from: 'Q4', replaces: 'J1' }] }));
  const m = metric(collectGoalMetrics([replaced]), '置き換えられた判断の割合');
  assert.equal(m.num, 1 / 3);
  assert.equal(m.value, '0.33（判断 3 件中 1 件）');
  assert.equal(m.count, 3);
  assert.equal(metric(collectGoalMetrics(goals), '置き換えられた判断の割合').num, 0);
});

test('作業記録からは、人の発言と人への質問の件数だけを取る（E4）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saihai-observe-tx-'));
  const lines = [
    { type: 'user', origin: { kind: 'human' }, turnOrigin: 'human', message: { content: '秘密の内容' } },
    { type: 'user', origin: { kind: 'human' }, turnOrigin: 'human', message: { content: [{ type: 'text', text: '秘密' }] } },
    { type: 'user', turnOrigin: 'sdk', message: { content: '非対話セッションの指示' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    { type: 'user', isMeta: true, turnOrigin: 'human', message: { content: 'meta' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{}, {}, {}] } }] } },
    // 観測のツールのソースを読んだ結果にも同じ文字列が入る。回答として数えない（G7 の観測の数え違い）
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r', content: "c.content.includes('questions have been answered')\nmatchAll(/=\"([^\"]*)\"/g)" }] } },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'q',
            content: 'Your questions have been answered: "Q1 秘密の問い？"="A にする（推奨）", "Q2 問い"="B にする", "Q3 問い"="自由に書いた秘密の答え". You can now continue.',
          },
        ],
      },
    },
  ];
  writeFileSync(join(dir, 's.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`);
  const metrics = collectTranscriptMetrics(dir);
  assert.equal(metric(metrics, '人の発言').value, '2');
  assert.equal(metric(metrics, '人への質問').value, '1 回（問い 3 件）');
  assert.equal(metric(metrics, '推奨どおりの割合').num, 1 / 3);
  assert.match(metric(metrics, '推奨どおりの割合').value, /3 件中 1 件/);
  assert.doesNotMatch(JSON.stringify(metrics), /秘密/);
});

test('推奨どおりの割合は、作業記録の回答と、ゴール文書の回答の印（saihai answer）を合わせて数える（G6.2.E2）', () => {
  const answered = parseGoal('goals/G4-d.md', doc({ id: 'G4', judgments: [{ text: 'A にする（推奨どおり）', from: 'Q1' }, { text: 'B にする（自明な案を選択）', from: 'Q2' }, { text: 'C にする（推奨どおり）', from: 'Q3' }] }));
  const { metrics } = observeAll({ goals: [answered], repoDir: tempRepo(), transcriptsDir: '/nonexistent', hidden: () => ({ total: 0 }) });
  const m = metric(metrics, '推奨どおりの割合');
  assert.equal(m.num, 2 / 3);
  assert.equal(m.count, 3);
  assert.match(m.source, /ゴール文書/);
});

test('作業記録がなければ、そのことを値に書く', () => {
  const metrics = collectTranscriptMetrics('/nonexistent/transcripts');
  assert.equal(metric(metrics, '人の発言').value, '作業記録なし');
});

test('git から、門番の通過回数と、文書ができてから達成までの時間を取る', () => {
  const repo = mkdtempSync(join(tmpdir(), 'saihai-observe-git-'));
  const git = (...args) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' });
  const commit = (text, message, date) => {
    writeFileSync(join(repo, 'goals', 'G1-a.md'), text);
    git('add', '.');
    spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'goals'));
  commit(doc({ id: 'G1' }), 'add G1', '2026-10-12T00:00:00Z');
  commit(doc({ id: 'G1', status: '達成', judgments: [{ text: '達成とする', from: 'Q1' }] }), 'close G1', '2026-10-12T06:00:00Z');
  git('commit', '-q', '--allow-empty', '-m', 'Merge work/x (門番を通過)');
  const metrics = collectGitMetrics(repo, [parseGoal('goals/G1-a.md', doc({ id: 'G1', status: '達成' }))]);
  assert.equal(metric(metrics, '門番の通過').value, '1 回');
  assert.equal(metric(metrics, '文書ができてから達成まで').value, '中央値 6.0 時間');
});

test('報告のどの数値にも、出どころと関わる具体例の ID が付き、40行以内に収まる（E2・E5。人が読むのは受信箱なので、報告は D 番号の判断ログのとおり40行まで）', () => {
  const metrics = observe({ goals, repoDir: mkdtempSync(join(tmpdir(), 'saihai-observe-empty-')), transcriptsDir: '/nonexistent', hidden: () => ({ total: 23, failed: 0 }), hiddenTargets: ['check-goals'], ownExamples: true });
  for (const m of metrics) {
    assert.ok(m.source, m.name);
    assert.ok(m.examples.length > 0, m.name);
  }
  const report = renderReport(metrics);
  assert.ok(report.trim().split('\n').length <= 40, report);
  assert.match(report, /隠しシナリオ.*23 件中 23 件が通過/);
  assert.match(report, /判断に使えるか/);
});

test('observe: 仮説の式に出てくるのに観測できない指標は、表に「まだ観測できない」として出す（G7.1.E5）', () => {
  const g = parseGoal('goals/G5-x.md', hypothesisDoc({ id: 'G5', hit: '良い（観測：`誰も測っていない指標 >= 1`）', miss: '悪い' }));
  const { metrics, verdicts } = observeAll({ goals: [g], repoDir: tempRepo(), transcriptsDir: '/nonexistent', hidden: () => ({ total: 0 }) });
  const m = metric(metrics, '誰も測っていない指標');
  assert.match(m.value, /まだ観測できない/);
  assert.deepEqual(m.examples, ['G5（仮説）']);
  assert.equal(verdicts[0].verdict, 'まだ観測できない');
});

test('件数が5件未満の指標は「まだ判断できない」と、決まった手順で判定する（G6.E3・J51）', () => {
  const report = renderReport([
    { name: '少ない', value: '4 回', count: 4, source: 'x', examples: ['G0.E1'] },
    { name: '足りる', value: '5 回', count: 5, source: 'x', examples: ['G0.E1'] },
  ]);
  assert.match(report, /\| 少ない \|.*\| まだ判断できない \|/);
  assert.match(report, /\| 足りる \|.*\| 使える \|/);
});

// --- G7.1：仮説に基づく観測 ---

const hypothesisDoc = ({ id, hit, miss }) =>
  doc({ id }).replace('- 仮説：なし（理由：テスト用）', `- 仮説：何かが良くなる\n- 当たりの判定：${hit}\n- 外れの判定：${miss}`);
const num = (name, value, count = 10) => ({ name, value: String(value), num: value, count, source: 'テスト', examples: ['G5.E1'] });
const verdictOf = (hit, miss, metrics) => judgeHypotheses([parseGoal('goals/G5-x.md', hypothesisDoc({ id: 'G5', hit, miss }))], metrics)[0].verdict;
const tempRepo = () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'saihai-observe-repo-'));
  mkdirSync(join(repoDir, 'goals'));
  return repoDir;
};

test('observeAll: 判定できた仮説の割合には、判断に使える指標の割合で判定する仮説（G7）の判定も数える（G7 の事後検証で見つけた数え漏れ）', () => {
  const g7 = parseGoal('goals/G7-x.md', hypothesisDoc({ id: 'G7', hit: '`判断に使える指標の割合 >= 0`', miss: '`判断に使える指標の割合 < 0`' }));
  const g71 = parseGoal('goals/G7.1-x.md', hypothesisDoc({ id: 'G7.1', hit: '`判定できた仮説の割合 >= 0.5`', miss: '`判定できた仮説の割合 < 0.2`' }));
  const { metrics, verdicts } = observeAll({ goals: [g7, g71], repoDir: tempRepo(), transcriptsDir: '/nonexistent', hidden: () => ({ total: 0 }) });
  assert.equal(verdicts.find((v) => v.goal === 'G7').verdict, '当たり');
  // G7 は判定できた。G7.1 自身は、自分の判定を数える前なので判定できていない側に数える
  assert.equal(metric(metrics, '判定できた仮説の割合').num, 0.5);
});

test('judgeHypotheses: 当たりは式がすべて成り立つとき、外れはどれかが成り立つとき（G7.1.E1・J64）', () => {
  const hit = '良い（観測：`a >= 0.8`、`b <= 2`）';
  const miss = '悪い（観測：`a < 0.5`）';
  assert.equal(verdictOf(hit, miss, [num('a', 0.9), num('b', 1)]), '当たり');
  assert.equal(verdictOf(hit, miss, [num('a', 0.9), num('b', 3)]), 'どちらでもない');
  assert.equal(verdictOf(hit, miss, [num('a', 0.4), num('b', 1)]), '外れ');
});

test('judgeHypotheses: 当たりと外れが両方成り立てば「矛盾」', () => {
  assert.equal(verdictOf('`a >= 0.5`', '`a > 0.4`', [num('a', 0.6)]), '矛盾');
});

test('judgeHypotheses: 件数が5件未満の指標があれば「まだ判断できない」（G7.1 の不変条件・J51）', () => {
  assert.equal(verdictOf('`a >= 0.8`', '`a < 0.5`', [num('a', 0.9, 4)]), 'まだ判断できない');
});

test('judgeHypotheses: 式の指標が観測できなければ「まだ観測できない」（G7.1.E5）', () => {
  assert.equal(verdictOf('`a >= 0.8`', '`z < 0.5`', [num('a', 0.9)]), 'まだ観測できない');
  assert.equal(verdictOf('`a >= 0.8`', '`a < 0.5`', [{ ...num('a', 0), num: undefined }]), 'まだ観測できない');
});

test('judgeHypotheses: 仮説なしのゴールは判定せず、式のない判定は「人が判定」', () => {
  const none = parseGoal('goals/G6-x.md', doc({ id: 'G6' }));
  const words = parseGoal('goals/G7-x.md', hypothesisDoc({ id: 'G7', hit: '使われる', miss: '使われない' }));
  const verdicts = judgeHypotheses([none, words], []);
  assert.deepEqual(verdicts.map((v) => [v.goal, v.verdict]), [['G7', '人が判定']]);
});

test('人の観測を記録し、組み込みにない指標として使う（G7.1.E3）', () => {
  const repoDir = tempRepo();
  recordObservation({ repoDir, name: '評価で見つかった問題', num: 4, count: 4, note: 'G3.E6 で3件、G3.2 で1件', by: 'AI', date: '2026-10-12' });
  const g = parseGoal('goals/G3-x.md', hypothesisDoc({ id: 'G3', hit: '見つかる（観測：`評価で見つかった問題 >= 1`）', miss: '見つからない' }));
  const m = collectRecordMetrics(repoDir, [g], []).find((x) => x.name === '評価で見つかった問題');
  assert.deepEqual([m.num, m.count, m.source], [4, 4, 'AI の記録']);
  assert.deepEqual(m.examples, ['G3（仮説）']);
});

test('mainの検査の失敗は、作業ツリーではなく、main の検査ツールで main のゴール文書を検査する（G7.1 の D6 の指摘）', () => {
  const repoDir = tempRepo();
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repoDir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repoDir, 'tools'));
  for (const name of ['check-goals.mjs', 'decision-log.mjs']) writeFileSync(join(repoDir, 'tools', name), readFileSync(new URL(`./${name}`, import.meta.url)));
  mkdirSync(join(repoDir, 'bin'));
  writeFileSync(join(repoDir, 'bin', 'saihai.mjs'), ''); // saihai 自身のリポジトリに見せる
  writeFileSync(join(repoDir, 'goals', 'G9-x.md'), doc({ id: 'G9' }).replace('## AI 層', '## 補足'));
  git('add', '-A');
  git('commit', '-q', '-m', 'broken');
  git('switch', '-q', '-c', 'work');
  writeFileSync(join(repoDir, 'goals', 'G9-x.md'), doc({ id: 'G9' }));
  const m = collectCheckMetric(repoDir, [parseGoal('goals/G9-x.md', doc({ id: 'G9' }))], []);
  assert.equal(m.num, 1);
  assert.match(m.source, /main/);
  const plain = collectCheckMetric(tempRepo(), [parseGoal('goals/G9-x.md', doc({ id: 'G9' }))], []);
  assert.equal(plain.num, 0);
  assert.match(plain.source, /いまの作業ツリー/);
});

test('導入先の main に tools/ があっても、そこのスクリプトは実行せず、導入した saihai の検査ツールで main を検査する（レビューの指摘）', () => {
  const repoDir = tempRepo();
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repoDir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repoDir, 'tools'));
  writeFileSync(join(repoDir, 'tools', 'check-goals.mjs'), 'process.exit(1)');
  writeFileSync(join(repoDir, 'goals', 'G9-x.md'), doc({ id: 'G9' }));
  git('add', '-A');
  git('commit', '-q', '-m', 'project');
  const m = collectCheckMetric(repoDir, [], []);
  assert.equal(m.num, 0, m.value);
  assert.match(m.source, /main/);
});

test('mainの検査の失敗は、門番を通した各時点の main を、その時点の検査ツールで検査して数える（G5 の仮説を判定できる件数にする）', () => {
  const repoDir = tempRepo();
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repoDir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const commit = (text, subject) => {
    writeFileSync(join(repoDir, 'goals', 'G9-x.md'), text);
    git('add', '-A');
    git('commit', '-q', '-m', subject);
  };
  commit(doc({ id: 'G9' }), 'initial');
  commit(doc({ id: 'G9' }).replace('## AI 層', '## 補足'), 'Merge work/a (門番を通過)');
  commit(doc({ id: 'G9' }), 'Merge work/b (門番を通過)');
  const m = collectCheckMetric(repoDir, [], []);
  assert.equal(m.num, 1);
  assert.equal(m.count, 2);
  assert.match(m.value, /2 個の状態/);
});

test('観測を履歴に残し、報告に前回の値を並べる（G7.1.E4）', () => {
  const repoDir = tempRepo();
  saveSnapshot(repoDir, [num('a', 0.5)], '2026-10-12T00:00:00Z');
  saveSnapshot(repoDir, [num('a', 0.7)], '2026-10-12T01:00:00Z');
  const previous = previousValues(repoDir);
  assert.equal(previous.get('a'), 0.7);
  const report = renderReport([num('a', 0.9)], [], previous);
  assert.match(report, /\| a \| 0\.9 \| 0\.7 \|/);
});

test('観測のコマンドから指標を集める。失敗したら観測できないと報告する（G7.1.E2）', () => {
  const repoDir = tempRepo();
  writeFileSync(join(repoDir, 'saihai.config.json'), JSON.stringify({ probes: { 利用者数: { command: 'echo 12 30', examples: ['G9.E1'] }, 壊れた: { command: 'exit 1' } } }));
  const metrics = collectProbeMetrics(repoDir);
  assert.deepEqual([metric(metrics, '利用者数').num, metric(metrics, '利用者数').count], [12, 30]);
  assert.equal(metric(metrics, '壊れた').num, undefined);
  assert.match(metric(metrics, '壊れた').value, /まだ観測できない/);
});

test('判断ログから、判断の件数と、逸脱・仮置きの変更・指摘の件数を出す', () => {
  const repoDir = tempRepo();
  mkdirSync(join(repoDir, 'decisions'));
  const entry = (id, kind, relation) => JSON.stringify({ id, kind, relation });
  writeFileSync(join(repoDir, 'decisions', 'log.jsonl'), [entry('D1', 'バックブリーフ'), entry('D2', '判断', '従った'), entry('D3', '判断', '逸脱'), entry('D4', '判断', '指摘')].join('\n'));
  const metrics = collectDecisionMetrics(repoDir);
  assert.equal(metric(metrics, '判断ログの件数').num, 3);
  assert.equal(metric(metrics, '逸脱と指摘').num, 2);
});

test('judgeHypotheses: 根拠の指標がすべて他の仮説の根拠に含まれるなら、その ID を付ける。同じ根拠を二重に数えないため（G6 の事後検証・J68）', () => {
  const g = (id, hit, miss = '`a < 0.5`') => parseGoal(`goals/${id}-x.md`, hypothesisDoc({ id, hit, miss }));
  const verdicts = judgeHypotheses([g('G2', '`a >= 0.8`'), g('G6', '`a >= 0.9`'), g('G7', '`a >= 0.8`、`b <= 2`'), g('G8', '`c >= 1`', '`c < 1`')], [num('a', 0.95), num('b', 1), num('c', 1)]);
  assert.deepEqual(verdicts.map((v) => [v.goal, v.sharedWith]), [['G2', ['G6', 'G7']], ['G6', ['G2', 'G7']], ['G7', []], ['G8', []]]);
  const report = renderReport([num('a', 0.95)], verdicts);
  assert.match(report, /\| G2 \| 何かが良くなる \| 当たり \| a = 0\.95（10件）。根拠は G6・G7 と共通 \|/);
});

test('判断に使える指標の割合と、判定できた仮説の割合を出す', () => {
  const metrics = [num('a', 1, 10), num('b', 1, 2)];
  const verdicts = [{ goal: 'G1', verdict: '当たり' }, { goal: 'G2', verdict: 'まだ判断できない' }];
  const derived = derivedMetrics(metrics, verdicts);
  assert.equal(metric(derived, '判断に使える指標の割合').num, 0.5);
  assert.equal(metric(derived, '判定できた仮説の割合').num, 0.5);
});

test('報告の表のセルに「|」があっても、表が崩れない（観測のコマンドの出どころなど）', () => {
  const report = renderReport([{ ...num('a', 1), source: '観測のコマンド（git log | grep -c x）' }]);
  assert.match(report, /\| 観測のコマンド（git log \\\| grep -c x） \|/);
});

test('judgeHypotheses: 中止したゴールは判定しない。「なし」で始まる普通の仮説は判定する', () => {
  const stopped = parseGoal('goals/G5-x.md', hypothesisDoc({ id: 'G5', hit: '`a >= 1`', miss: '`a < 1`' }).replace('status: 進行中', 'status: 中止'));
  const nashi = parseGoal('goals/G6-x.md', hypothesisDoc({ id: 'G6', hit: '`a >= 1`', miss: '`a < 1`' }).replace('- 仮説：何かが良くなる', '- 仮説：なしで済ませていた確認を自動化すると良くなる'));
  assert.deepEqual(judgeHypotheses([stopped, nashi], [num('a', 1)]).map((v) => [v.goal, v.verdict]), [['G6', '当たり']]);
});

test('報告の表のセルの改行は空白にし、具体例の列の「|」もエスケープする', () => {
  const report = renderReport([{ ...num('a', 1), source: '1行目\n2行目', examples: ['G1|x'] }]);
  assert.match(report, /\| 1行目 2行目 \|/);
  assert.match(report, /G1\\\|x/);
});

test('saihai 自身以外のプロジェクトでは、組み込みの指標に saihai の具体例の ID を付けない（導入先に無い ID で混乱させない。G9）', () => {
  const { metrics } = observeAll({ goals, repoDir: tempRepo(), transcriptsDir: '/nonexistent', hidden: () => ({ total: 0 }), ownExamples: false });
  assert.deepEqual(metric(metrics, 'ゴールの状態').examples, []);
  assert.deepEqual(metric(metrics, '判定できた仮説の割合').examples, []);
  assert.match(renderReport(metrics), /\| ゴールの状態 \|.*\| ― \| まだ判断できない \|/);
});

test('報告に、ゴールごとの仮説の判定を根拠つきで並べる', () => {
  const report = renderReport([num('a', 0.9)], [{ goal: 'G5', hypothesis: '何かが良くなる', verdict: '当たり', basis: 'a = 0.9（10件）' }]);
  assert.match(report, /\| G5 \| 何かが良くなる \| 当たり \| a = 0\.9（10件） \|/);
});
