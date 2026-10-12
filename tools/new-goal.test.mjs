import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRepo, loadGoals } from './check-goals.mjs';
import { createGoal, nextChildId, run } from './new-goal.mjs';

const ROOT = `---
id: G0
parent: null
status: 進行中
version: 0.1
updated: 2026-10-12
---

# G0 ルート

> 要約

## 意図

理由

## 具体例

- E1 \`[機械]\` 例

---

## AI 層
`;

function goalsDir(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'saihai-new-goal-'));
  writeFileSync(join(dir, 'G0-root.md'), ROOT);
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return dir;
}
const child = (id, parent) => ROOT.replace('id: G0', `id: ${id}`).replace('parent: null', `parent: ${parent}`).replace('# G0', `# ${id}`);
const options = { title: '現実からの観測', summary: '観測を集める', date: '2026-10-12' };

test('雛形はそのままゴール文書の検査を通る（G2.E2）', () => {
  const dir = goalsDir();
  const path = createGoal({ goalsDir: dir, id: 'G7', parent: 'G0', slug: 'observation', ...options });
  assert.ok(path.endsWith('G7-observation.md'));
  assert.deepEqual(checkRepo(loadGoals(dir)), []);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /^# G7 現実からの観測$/m);
  assert.match(text, /^> 観測を集める$/m);
  assert.match(text, /^status: 議論中$/m);
  assert.match(text, /### 前提/);
  assert.match(text, /### 調べたこと/);
  assert.match(text, /### 既知の落とし穴/);
});

test('nextChildId: ID を指定しなければ、親の下の次の番号にする', () => {
  const dir = goalsDir({ 'G1-a.md': child('G1', 'G0'), 'G3-b.md': child('G3', 'G0'), 'G1.1-c.md': child('G1.1', 'G1') });
  assert.equal(nextChildId(dir, 'G0'), 'G4');
  assert.equal(nextChildId(dir, 'G1'), 'G1.2');
  assert.equal(nextChildId(dir, 'G3'), 'G3.1');
});

test('すでにある ID、存在しない親、規則に合わない名前は断る', () => {
  const dir = goalsDir({ 'G1-a.md': child('G1', 'G0') });
  assert.throws(() => createGoal({ goalsDir: dir, id: 'G1', parent: 'G0', slug: 'x', ...options }), /G1 はすでにあります/);
  assert.throws(() => createGoal({ goalsDir: dir, id: 'G9', parent: 'G8', slug: 'x', ...options }), /親のゴール G8/);
  assert.throws(() => createGoal({ goalsDir: dir, id: 'G9', parent: 'G0', slug: 'Bad_Name', ...options }), /英小文字/);
  assert.throws(() => createGoal({ goalsDir: dir, id: 'X1', parent: 'G0', slug: 'x', ...options }), /G{番号}/);
});

test('run: 引数から雛形を作り、作った場所を伝える', () => {
  const dir = goalsDir();
  const r = run({ argv: ['--parent', 'G0', '--slug', 'observation', '--title', '現実からの観測', '--summary', '観測を集める'], goalsDir: dir });
  assert.equal(r.code, 0);
  assert.match(r.out, /G1-observation\.md/);
  assert.ok(existsSync(join(dir, 'G1-observation.md')));
});

test('run: 必要な引数がなければ、使い方を伝えて失敗する', () => {
  const r = run({ argv: ['--parent', 'G0'], goalsDir: goalsDir() });
  assert.equal(r.code, 1);
  assert.match(r.err, /使い方/);
});
