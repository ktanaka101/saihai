import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoal } from './check-goals.mjs';
import { collectInboxItems, countProvisional, oldestProvisional, renderInbox, stageOf } from './inbox.mjs';
import { buildAAR } from './aar.mjs';

const doc = ({ id, status = '進行中', pending = [], hypothesis = '- 仮説：なし（理由：テスト用）', extra = '', ai = '' }) => `---
id: ${id}
parent: null
status: ${status}
version: 0.1
updated: 2026-10-12
---

# ${id} テスト

> 要約

${pending.length ? `## 判断待ち\n\n${pending.map((q) => `### ${q} 問いの題名\n\n- 推奨：A にする\n- 自明な案：B\n- 取り消し：可能\n`).join('\n')}\n` : ''}## 意図

- 目的：目的の本文
- 理由：理由の本文
- 望ましい最終状態：最終状態の本文

## 仮説と判定

${hypothesis}

## 具体例

- E1 \`[機械]\` 例
${extra}
---

## AI 層
${ai}
`;
const HYPO = '- 仮説：使われるはず\n- 当たりの判定：使われる（観測：`a >= 1`）\n- 外れの判定：使われない（観測：`a < 1`）';
const judgment = (id, extra = {}) => ({ id, goal: 'G1', kind: '判断', decision: `${id} の判断`, related: ['G1.E1'], reason: '理由', rejected: '―', relation: '従った', reversibility: '容易', impact: [], ...extra });

test('受信箱は、報告 → 判断待ち → 仮説の外れと矛盾 → 事後確認の順に並ぶ（G6.1.E1）', () => {
  const goals = [parseGoal('goals/G1-a.md', doc({ id: 'G1', pending: ['Q90'] })), parseGoal('goals/G2-b.md', doc({ id: 'G2', status: '達成', hypothesis: HYPO }))];
  const decisions = [judgment('D1', { relation: '逸脱' }), { id: 'D2', goal: 'G1', kind: '報告', decision: '不変条件と衝突する', reason: 'X が必要' }];
  const items = collectInboxItems({ goals, decisions, verdicts: [{ goal: 'G2', hypothesis: '使われるはず', verdict: '外れ', basis: 'a = 0（10件）' }] });
  assert.deepEqual(items.map((i) => [i.kind, i.id]), [['報告', 'D2'], ['判断待ち', 'Q90'], ['仮説', 'G2'], ['事後確認', 'D1']]);
  assert.match(items[1].detail, /A にする/);
});

test('受信箱に出すのは5件まで。上がらなかった件数を種類ごとに示す（G6.1 の不変条件）', () => {
  const goals = [parseGoal('goals/G1-a.md', doc({ id: 'G1', pending: ['Q90', 'Q91', 'Q92', 'Q93'] }))];
  const decisions = [judgment('D1', { relation: '逸脱' }), judgment('D2', { reversibility: '困難' }), judgment('D3', { relation: '指摘' })];
  const items = collectInboxItems({ goals, decisions, verdicts: [] });
  const text = renderInbox({ items, stages: [], provisional: 0 });
  assert.equal((text.match(/^\d+\. /gm) ?? []).length, 5);
  assert.match(text, /ほかに 2 件（事後確認 2 件）/);
});

test('事後確認に上がるのは、逸脱・仮置きの変更・指摘・戻しにくい・紐づかない判断だけ。確認したものは上がらない（G6.1.E3）', () => {
  const goals = [parseGoal('goals/G1-a.md', doc({ id: 'G1' }))];
  const decisions = [
    judgment('D1'),
    judgment('D2', { relation: '逸脱' }),
    judgment('D3', { relation: '仮置きの変更' }),
    judgment('D4', { relation: '指摘' }),
    judgment('D5', { reversibility: '困難' }),
    judgment('D6', { related: [] }),
    judgment('D7', { relation: '逸脱' }),
    { id: 'D8', goal: 'G1', kind: '確認', targets: ['D7'] },
    { id: 'D9', goal: 'G1', kind: 'バックブリーフ', decision: '解釈' },
  ];
  const ids = collectInboxItems({ goals, decisions, verdicts: [] }).map((i) => i.id);
  assert.deepEqual(ids, ['D2', 'D3', 'D4', 'D5', 'D6']);
});

test('事後確認の項目には、その判断を関連に挙げた後の判断（対応）を添える。人が判断ログを読みに行かずに済むように', () => {
  const goals = [parseGoal('goals/G1-a.md', doc({ id: 'G1' }))];
  const decisions = [judgment('D1', { relation: '指摘' }), judgment('D2', { related: ['G1.E1', 'D1'] }), judgment('D3', { relation: '逸脱' })];
  const items = collectInboxItems({ goals, decisions, verdicts: [] });
  assert.match(items.find((i) => i.id === 'D1').detail, /対応：D2/);
  assert.doesNotMatch(items.find((i) => i.id === 'D3').detail, /対応：/);
});

test('受信箱の「見たら」「事後検証の材料」のコマンドは、プロジェクトの呼び方で出す（G9）', () => {
  const goals = [parseGoal('goals/G1-a.md', doc({ id: 'G1' }))];
  const items = collectInboxItems({ goals, decisions: [judgment('D1', { relation: '指摘' })], verdicts: [{ goal: 'G1', verdict: '外れ', hypothesis: 'h', basis: 'b' }], command: 'node "/opt/saihai/bin/saihai.mjs"' });
  assert.deepEqual(items.map((i) => i.action), ['事後検証の材料：node "/opt/saihai/bin/saihai.mjs" aar G1', '見たら：node "/opt/saihai/bin/saihai.mjs" confirm D1']);
});

test('確認した報告は上がらない', () => {
  const goals = [parseGoal('goals/G1-a.md', doc({ id: 'G1' }))];
  const decisions = [{ id: 'D1', goal: 'G1', kind: '報告', decision: 'x', reason: 'y' }, { id: 'D2', goal: 'G1', kind: '確認', targets: ['D1'] }];
  assert.deepEqual(collectInboxItems({ goals, decisions, verdicts: [] }), []);
});

test('ゴールの段階を決める（G6.1.E2）', () => {
  const g = (opts) => parseGoal('goals/G1-a.md', doc({ id: 'G1', ...opts }));
  assert.equal(stageOf(g({ status: '議論中' })), 'ゴール設定');
  assert.equal(stageOf(g({ pending: ['Q90'] })), 'ゴール設定');
  assert.equal(stageOf(g({})), '実装');
  assert.equal(stageOf(g({ status: '達成' })), '完了');
  assert.equal(stageOf(g({ status: '達成', hypothesis: HYPO }), { verdict: 'まだ判断できない' }), '観測');
  assert.equal(stageOf(g({ status: '達成', hypothesis: HYPO }), { verdict: '外れ' }), '解釈待ち');
  assert.equal(stageOf(g({ status: '達成', hypothesis: HYPO, ai: '\n### 事後検証\n\n- 2026-10-12：外れ。次は G9 で直す\n' }), { verdict: '外れ' }), '完了');
});

test('達成したゴールの判断待ちと「人が判定」の仮説は、解釈待ちに並ぶ（ゴール設定に戻さない）', () => {
  const g = (opts) => parseGoal('goals/G1-a.md', doc({ id: 'G1', ...opts }));
  const words = '- 仮説：使われるはず\n- 当たりの判定：使われる\n- 外れの判定：使われない';
  assert.equal(stageOf(g({ status: '達成', hypothesis: HYPO, pending: ['Q90'] }), { verdict: '当たり' }), '解釈待ち');
  assert.equal(stageOf(g({ status: '達成', hypothesis: words }), { verdict: '人が判定' }), '解釈待ち');
  assert.equal(stageOf(g({ status: '達成', hypothesis: words, ai: '\n### 事後検証\n\n- 2026-10-12：人が当たりと判定\n' }), { verdict: '人が判定' }), '完了');
});

test('中止したゴールは、仮説があっても「完了」に並ぶ。「なし」で始まる普通の仮説は仮説として扱う', () => {
  const g = (opts) => parseGoal('goals/G1-a.md', doc({ id: 'G1', ...opts }));
  assert.equal(stageOf(g({ status: '中止', hypothesis: HYPO }), { verdict: '外れ' }), '完了');
  const nashi = '- 仮説：なしで済ませていた確認を自動化すると良くなる\n- 当たりの判定：良い（観測：`a >= 1`）\n- 外れの判定：悪い（観測：`a < 1`）';
  assert.equal(stageOf(g({ status: '達成', hypothesis: nashi }), { verdict: 'まだ判断できない' }), '観測');
});

test('残っている仮置きは、検査が制約として扱う箇条（*・番号）も数える', () => {
  const goals = [parseGoal('goals/G1-a.md', doc({ id: 'G1', extra: '\n## 仮置き\n\n- A — 理由：G0\n* B — 理由：G0\n1. C — 理由：G0\n' }))];
  assert.equal(countProvisional(goals), 3);
});

test('残っている仮置きを数える（制約と判例）（G6.1.E5）', () => {
  const ai = '\n| ID | 日付 | 判断 | 強さ | 上申 | 置き換え |\n|---|---|---|---|---|---|\n| J1 | 2026-10-12 | x。推奨を採用（J37） | 仮置き | Q1 | ― |\n| J2 | 2026-10-12 | y | 推奨 | ― | ― |\n';
  const g = parseGoal('goals/G1-a.md', doc({ id: 'G1', extra: '\n## 仮置き\n\n- JSON で保存 — 理由：読みやすい（G1.E1）\n', ai }));
  assert.equal(countProvisional([g]), 2);
});

test('受信箱が空なら、そう伝える。段階の一覧と仮置きの数は出す', () => {
  const text = renderInbox({ items: [], stages: [{ goal: 'G1', stage: '実装', title: 'テスト' }], provisional: 3 });
  assert.match(text, /いま判断すべきことはありません/);
  assert.match(text, /実装：G1/);
  assert.match(text, /仮置き 3 件/);
});

test('判断待ちの項目には、1つのコマンドで答える方法が出る（G6.2.E5）', () => {
  const goals = [parseGoal('goals/G1-a.md', doc({ id: 'G1', pending: ['Q90'] }))];
  const [item] = collectInboxItems({ goals, decisions: [], verdicts: [], command: 'saihai' });
  assert.match(item.action, /saihai answer Q90 推奨/);
  assert.match(item.action, /自明な案/);
});

test('受信箱に出した事後確認は、1つのコマンドでまとめて確認済みにできる', () => {
  const goals = [parseGoal('goals/G1-a.md', doc({ id: 'G1' }))];
  const items = collectInboxItems({ goals, decisions: [judgment('D1', { relation: '指摘' }), judgment('D2', { relation: '逸脱' })], verdicts: [], command: 'saihai' });
  const text = renderInbox({ items, stages: [], provisional: 0, command: 'saihai' });
  assert.match(text, /まとめて確認済みにする：saihai confirm D1 D2/);
  assert.doesNotMatch(renderInbox({ items: [], stages: [], provisional: 0 }), /まとめて/);
});

test('見直しの節に、古い仮置きを項目で出す（G6.2.E5）', () => {
  const table = '\n### 判例\n\n| ID | 日付 | 判断 | 強さ | 上申 | 置き換え |\n|---|---|---|---|---|---|\n| J2 | 2026-10-12 | 二番目の仮置き。推奨を採用（J37） | 仮置き | ― | ― |\n| J1 | 2026-10-11 | 一番目の仮置き | 仮置き | ― | ― |\n| J3 | 2026-10-12 | 推奨の判断 | 推奨 | ― | ― |\n';
  const goals = [parseGoal('goals/G1-a.md', doc({ id: 'G1', ai: table }))];
  const oldest = oldestProvisional(goals, 2);
  assert.deepEqual(oldest.map((p) => p.id), ['J1', 'J2']);
  const text = renderInbox({ items: [], stages: [], provisional: 2, oldest });
  assert.match(text, /- J1（G1）：一番目の仮置き/);
  assert.match(text, /- J2（G1）：二番目の仮置き/);
});

test('事後検証の材料に、起きるはずだったこと・起きたこと・判断ログの要点が入る（G6.1.E4）', () => {
  const goal = parseGoal('goals/G2-b.md', doc({ id: 'G2', status: '達成', hypothesis: HYPO }));
  const decisions = [judgment('D1', { goal: 'G2' }), judgment('D2', { goal: 'G2', relation: '逸脱', decision: '20行を40行に' }), judgment('D3', { goal: 'G9' })];
  const text = buildAAR({ goal, verdict: { verdict: '外れ', basis: 'a = 0（10件）' }, decisions });
  for (const s of ['## 起きるはずだったこと', '最終状態の本文', '仮説：使われるはず', '当たりの判定', '## 起きたこと', '外れ', 'a = 0（10件）', '判断 2 件', '20行を40行に', '## なぜ違ったか', '## 次にどうするか']) {
    assert.ok(text.includes(s), s);
  }
  assert.doesNotMatch(text, /D3/);
});
