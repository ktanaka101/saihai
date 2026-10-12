import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGoal } from './check-goals.mjs';
import { collectGitMetrics, collectGoalMetrics, collectTranscriptMetrics, observe, renderReport } from './observe.mjs';

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

理由

## 具体例

- E1 \`[機械]\` 例

---

## AI 層

| ID | 日付 | 判断 | 上申 | 置き換え |
|---|---|---|---|---|
${judgments.map((j, i) => `| J${i + 1} | 2026-10-12 | ${j.text} | ${j.from} | ― |`).join('\n')}
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
  assert.equal(metric(metrics, '1ゴールあたりの人の判断').value, '1.0');
  assert.equal(metric(metrics, '判断待ち').value, '2');
});

test('作業記録からは、人の発言と人への質問の件数だけを取る（E4）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saihai-observe-tx-'));
  const lines = [
    { type: 'user', origin: { kind: 'human' }, turnOrigin: 'human', message: { content: '秘密の内容' } },
    { type: 'user', origin: { kind: 'human' }, turnOrigin: 'human', message: { content: [{ type: 'text', text: '秘密' }] } },
    { type: 'user', turnOrigin: 'sdk', message: { content: '非対話セッションの指示' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    { type: 'user', isMeta: true, turnOrigin: 'human', message: { content: 'meta' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{}, {}, {}] } }] } },
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
  assert.equal(metric(metrics, '推奨どおりの回答').value, '3 件中 1 件');
  assert.doesNotMatch(JSON.stringify(metrics), /秘密/);
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

test('報告のどの数値にも、出どころと関わる具体例の ID が付き、20行以内に収まる（E2・E5）', () => {
  const metrics = observe({ goals, repoDir: mkdtempSync(join(tmpdir(), 'saihai-observe-empty-')), transcriptsDir: '/nonexistent', hidden: () => ({ total: 23, failed: 0 }) });
  for (const m of metrics) {
    assert.ok(m.source, m.name);
    assert.ok(m.examples.length > 0, m.name);
  }
  const report = renderReport(metrics);
  assert.ok(report.trim().split('\n').length <= 20, report);
  assert.match(report, /隠しシナリオ.*23 件中 23 件が通過/);
  assert.match(report, /まだ観測できない/);
});

test('件数が5件未満の指標は「まだ判断できない」と、決まった手順で判定する（G6.E3・J51）', () => {
  const report = renderReport([
    { name: '少ない', value: '4 回', count: 4, source: 'x', examples: ['G0.E1'] },
    { name: '足りる', value: '5 回', count: 5, source: 'x', examples: ['G0.E1'] },
  ]);
  assert.match(report, /\| 少ない \|.*\| まだ判断できない \|/);
  assert.match(report, /\| 足りる \|.*\| 使える \|/);
});
