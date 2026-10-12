import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as runCheck } from './check-goals.mjs';
import { appendDecision, checkDecisions, confirmReviews, parseDecisions, run, runConfirm } from './decision-log.mjs';

const GOAL = `---
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

const judgment = (id, extra = {}) => ({
  id,
  date: '2026-10-12',
  goal: 'G9',
  kind: '判断',
  decision: '検査ツールを Node で書く',
  related: ['G9.E1'],
  reason: '依存を増やさない',
  rejected: 'Python（実行環境が増える）',
  relation: '従った',
  reversibility: '容易',
  impact: ['実装の言語'],
  ...extra,
});
const jsonl = (entries) => `${entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')}\n`;
const check = (entries) => checkDecisions(parseDecisions(jsonl(entries)), ['G9']);
const messages = (violations) => violations.map((v) => v.message).join('\n');

function repo(entries = []) {
  const root = mkdtempSync(join(tmpdir(), 'saihai-decisions-'));
  mkdirSync(join(root, 'goals'));
  writeFileSync(join(root, 'goals', 'G9-test.md'), GOAL);
  if (entries.length) {
    mkdirSync(join(root, 'decisions'));
    writeFileSync(join(root, 'decisions', 'log.jsonl'), jsonl(entries));
  }
  return { root, goalsDir: join(root, 'goals'), decisionsPath: join(root, 'decisions', 'log.jsonl') };
}

test('4つの種類の記録が、決まった項目を持っていれば違反なし（G8.E3）', () => {
  const entries = [
    { id: 'D1', date: '2026-10-12', goal: 'G9', kind: 'バックブリーフ', decision: 'G9 は〇〇と解釈した' },
    judgment('D2'),
    judgment('D3', { relation: '逸脱', reason: '推奨の X は目的と衝突する。守ると Y を失う' }),
    { id: 'D4', date: '2026-10-12', goal: 'G9', kind: '報告', decision: '不変条件と衝突する', reason: 'Z が必要' },
    { id: 'D5', date: '2026-10-12', goal: 'G9', kind: '確認', targets: ['D3', 'D4'], note: '人が見た' },
  ];
  assert.deepEqual(check(entries), []);
});

test('壊れた行・ID の重複・日付・存在しないゴール・知らない種類は違反', () => {
  const v = check(['{bad', judgment('D1'), judgment('D1'), judgment('D2', { date: '昨日' }), judgment('D3', { goal: 'G99' }), judgment('D4', { kind: '雑談' })]);
  assert.equal(v.length, 5);
  assert.ok(v.every((x) => x.rule === 'G8.E3'));
  assert.match(messages(v), /1 行目/);
  assert.match(messages(v), /D1 が重複/);
  assert.match(messages(v), /G99/);
});

test('判断に必要な項目が欠けていたり、選択肢にない値なら違反', () => {
  const v = check([judgment('D1', { reason: '' }), judgment('D2', { relation: 'なんとなく' }), judgment('D3', { reversibility: 'たぶん' }), judgment('D4', { impact: 'データ' })]);
  assert.equal(v.length, 4);
  assert.match(messages(v), /reason/);
  assert.match(messages(v), /relation/);
  assert.match(messages(v), /reversibility/);
  assert.match(messages(v), /impact/);
});

test('確認の対象が判断ログにない ID なら違反', () => {
  const v = check([judgment('D1'), { id: 'D2', date: '2026-10-12', goal: 'G9', kind: '確認', targets: ['D9'] }]);
  assert.match(messages(v), /D9/);
});

test('appendDecision: 通し番号と今日の日付を付けて1件足す（G8.E4）', () => {
  const r = repo();
  const { id, ...entry } = judgment('D0');
  assert.equal(appendDecision({ ...r, entry, today: '2026-10-13' }).id, 'D1');
  assert.equal(appendDecision({ ...r, entry, today: '2026-10-13' }).id, 'D2');
  const saved = parseDecisions(readFileSync(r.decisionsPath, 'utf8'));
  assert.deepEqual(saved.map((e) => [e.value.id, e.value.date]), [['D1', '2026-10-13'], ['D2', '2026-10-13']]);
});

test('appendDecision: 項目が足りなければ書かずに失敗する', () => {
  const r = repo();
  assert.throws(() => appendDecision({ ...r, entry: { goal: 'G9', kind: '判断', decision: 'x' } }), /reason/);
  assert.equal(existsSync(r.decisionsPath), false);
});

test('run: 引数から1件足し、ID を伝える', () => {
  const r = repo();
  const out = run({
    argv: ['--goal', 'G9', '--kind', '判断', '--decision', 'Node で書く', '--related', 'G9.E1,J1', '--reason', '依存を増やさない', '--rejected', 'Python', '--relation', '従った', '--reversibility', '容易', '--impact', '実装の言語'],
    ...r,
  });
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /D1 を判断ログに記録しました/);
  assert.deepEqual(parseDecisions(readFileSync(r.decisionsPath, 'utf8'))[0].value.related, ['G9.E1', 'J1']);
});

test('run: 項目が足りなければ使い方を伝えて失敗する', () => {
  const out = run({ argv: ['--goal', 'G9'], ...repo() });
  assert.equal(out.code, 1);
  assert.match(out.err, /使い方/);
});

test('ゴール文書の検査は、判断ログも検査する', () => {
  const r = repo([judgment('D1', { relation: 'なんとなく' })]);
  const out = runCheck({ goalsDir: r.goalsDir });
  assert.equal(out.code, 1);
  assert.match(out.err, /decisions\/log\.jsonl: \[G8\.E3\]/);
});

test('confirmReviews: 見た判断をまとめて確認済みにする。確認はゴールの根（G0 にあたるもの）に記録する（受信箱の人の手間を1回にする）', () => {
  const r = repo([judgment('D1', { relation: '指摘' }), judgment('D2', { relation: '逸脱' })]);
  const saved = confirmReviews({ ...r, ids: ['D1', 'D2'], today: '2026-10-13' });
  assert.deepEqual([saved.id, saved.goal, saved.kind, saved.targets], ['D3', 'G9', '確認', ['D1', 'D2']]);
  assert.throws(() => confirmReviews({ ...r, ids: ['D99'] }), /D99/);
});

test('runConfirm: 引数の D を確認済みにし、何を記録したかを返す', () => {
  const r = repo([judgment('D1', { relation: '指摘' })]);
  const ok = runConfirm({ argv: ['D1'], goalsDir: r.goalsDir });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /D1 を確認済みにしました（D2）/);
  assert.match(runConfirm({ argv: [], goalsDir: r.goalsDir }).err, /使い方/);
});
