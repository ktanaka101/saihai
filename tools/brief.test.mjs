import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGoal } from './check-goals.mjs';
import { buildBrief, run } from './brief.mjs';

const ROOT = `---
id: G0
parent: null
status: 進行中
version: 0.1
updated: 2026-10-12
---

# G0 ルート

> ルートの要約

## 意図

- 目的：ルートの目的
- 理由：ルートの理由
- 望ましい最終状態：ルートの最終状態

## 仮説と判定

- 仮説：なし（理由：テスト用）

## 具体例

- E1 \`[機械]\` ルートの例

## 不変条件

- 取り消せない操作は事前承認 — 理由：戻せない（J1）

## 推奨

- 判断の前に調べる — 理由：落とし穴を減らす（G0.E1）

## 報告条件

- 不変条件と衝突したとき

---

## AI 層

| ID | 日付 | 判断 | 強さ | 上申 | 置き換え |
|---|---|---|---|---|---|
| J1 | 2026-10-12 | 注意力は有限 | 不変条件 | ― | ― |
| J2 | 2026-10-12 | 何かにする。推奨を採用（J37） | 仮置き | Q1 | ― |
`;

const CHILD = `---
id: G9
parent: G0
status: 進行中
version: 0.1
updated: 2026-10-12
---

# G9 観測

> 観測を集める

## 意図

- 目的：観測を集める
- 理由：判断に使う
- 望ましい最終状態：数値がそろう

## 仮説と判定

- 仮説：数値がそろえば判断が速くなる
- 当たりの判定：判断が速い（観測：\`判断の日数 <= 1\`）
- 外れの判定：判断が遅い

## 具体例

- E1 \`[機械]\` 観測が集まる

## 仮置き

- JSON で保存する — 理由：機械で読みやすい（G9.E1）

## 報告条件

- 外部に送るとき

## 非ゴール

- 解釈
`;

const goals = [parseGoal('goals/G0-root.md', ROOT), parseGoal('goals/G9-observe.md', CHILD)];

test('委任指示に、対象のゴールの意図・仮説・具体例・非ゴールが入る（G8.E1）', () => {
  const brief = buildBrief(goals, 'G9');
  assert.match(brief, /^# 委任指示：G9 観測$/m);
  for (const text of ['目的：観測を集める', '理由：判断に使う', '望ましい最終状態：数値がそろう', '仮説：数値がそろえば判断が速くなる', 'E1 `[機械]` 観測が集まる', '- 解釈']) {
    assert.ok(brief.includes(text), text);
  }
});

test('祖先のゴールの不変条件・推奨・報告条件と、強さが不変条件の判例を引き継ぐ（G8.E1）', () => {
  const brief = buildBrief(goals, 'G9');
  assert.match(brief, /取り消せない操作は事前承認 — 理由：戻せない（J1）（G0）/);
  assert.match(brief, /判断の前に調べる.*（G0）/);
  assert.match(brief, /JSON で保存する.*（G9）/);
  assert.match(brief, /J1：注意力は有限（G0 の判例）/);
  assert.doesNotMatch(brief, /何かにする/); // 仮置きの判例は不変条件として渡さない
  assert.match(brief, /不変条件と衝突したとき（G0）/);
  assert.match(brief, /外部に送るとき（G9）/);
});

test('進め方に、バックブリーフ・判断ログ・逸脱の報告・黙って従わないことの依頼が入る（G8.E2）', () => {
  const brief = buildBrief(goals, 'G9');
  for (const text of ['バックブリーフ', 'saihai log --goal G9', '逸脱', '指摘', '止まって', 'saihai gate']) {
    assert.ok(brief.includes(text), text);
  }
  // 呼び方はプロジェクトごとに変わる（G9）
  assert.ok(buildBrief(goals, 'G9', 'node bin/saihai.mjs').includes('node bin/saihai.mjs log --goal G9'));
});

test('知らない ID なら失敗する', () => {
  assert.throws(() => buildBrief(goals, 'G99'), /G99/);
});

test('run: ID を受け取って委任指示を出す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saihai-brief-'));
  writeFileSync(join(dir, 'G0-root.md'), ROOT);
  writeFileSync(join(dir, 'G9-observe.md'), CHILD);
  const r = run({ argv: ['G9'], goalsDir: dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /委任指示：G9/);
  assert.equal(run({ argv: [], goalsDir: dir }).code, 1);
});
