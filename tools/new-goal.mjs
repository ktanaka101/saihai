#!/usr/bin/env node
// ゴール文書の雛形を作る（G2.E2）。作った雛形は、そのままゴール文書の検査を通る。
// 参謀の手順（.claude/skills/goal-draft/SKILL.md）の中で使う。
import { readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const GOALS_DIR = fileURLToPath(new URL('../goals/', import.meta.url));
const ID = /^G\d+(\.\d+)*$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const existingIds = (goalsDir) =>
  readdirSync(goalsDir)
    .map((name) => name.match(/^(G\d+(?:\.\d+)*)-.*\.md$/)?.[1])
    .filter(Boolean);

// 親の直下の次の番号。G0 の子は G1, G2, …、それ以外の Gx の子は Gx.1, Gx.2, …
export function nextChildId(goalsDir, parent) {
  const prefix = parent === 'G0' ? 'G' : `${parent}.`;
  const numbers = existingIds(goalsDir)
    .filter((id) => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)))
    .map((id) => Number(id.slice(prefix.length)));
  return `${prefix}${numbers.length ? Math.max(...numbers) + 1 : 1}`;
}

export function goalTemplate({ id, parent, title, summary, date }) {
  return `---
id: ${id}
parent: ${parent}
status: 議論中
version: 0.1
updated: ${date}
---

# ${id} ${title}

> ${summary}

## 意図

- 目的：（何を達成したいか。足りない情報は推測で埋めず、判断待ちにする）
- 理由：（なぜそれが必要か）
- 望ましい最終状態：（終わったとき、何がどうなっているか）

## 仮説と判定

- 仮説：（これを作れば、誰の何がどう良くなるはずか。立てないときは「なし（理由：…）」だけにする）
- 当たりの判定：（何を観測したら仮説が正しいとするか。式は「指標 >= 数値」の形でバッククォートに入れる）
- 外れの判定：（何を観測したら仮説が誤りとするか）

## 具体例

- E1 \`[機械]\` （機械で確かめられる受け入れの例。\`[人間]\` は人が確かめるもの、\`[計測]\` は運用中の指標で判定するもの）

## 不変条件

- （必ず守ること。破る必要が生じたら止まって報告する） — 理由：（なぜ。関わるゴール・判例の ID を書く）

## 推奨

- （原則として守ること。逸脱したら判断ログに残す） — 理由：（なぜ）

## 仮置き

- （暫定の決め。変えたら判断ログに残す） — 理由：（なぜ仮に置いたか）

## 報告条件

- （該当したら止まって人に聞く条件。親のゴールの報告条件は引き継がれる）

## 非ゴール

- （やらないこと）

---

## AI 層

> ここから下は AI 向けの記録と根拠。人は根拠を確かめたいときだけ読めばよい。

### 前提

確かめていない前提。確かめたら「調べたこと」に移す。

- （前提）

### 調べたこと

数字と事実には出典を付ける。出典のないものは「前提」に書く。

- （先行事例と出典）

### 既知の落とし穴（プレモーテム）

「半年後にこのゴールが失敗していたら、原因は何か」

| 落とし穴 | 根拠 | 対策 |
|---|---|---|
| （落とし穴） | （根拠） | （対策） |
`;
}

export function createGoal({ goalsDir = GOALS_DIR, id, parent, slug, title, summary, date = new Date().toISOString().slice(0, 10) }) {
  if (!ID.test(id)) throw new Error(`ID「${id}」は G{番号} の形にしてください`);
  if (!SLUG.test(slug)) throw new Error(`名前「${slug}」は英小文字・数字・ハイフンにしてください`);
  const ids = existingIds(goalsDir);
  if (ids.includes(id)) throw new Error(`${id} はすでにあります`);
  if (!ids.includes(parent)) throw new Error(`親のゴール ${parent} が見つかりません`);
  const path = join(goalsDir, `${id}-${slug}.md`);
  writeFileSync(path, goalTemplate({ id, parent, title, summary, date }), { flag: 'wx' });
  return path;
}

const USAGE = '使い方：saihai new --parent G0 --slug observation --title "現実からの観測" --summary "一文の要約" [--id G7]';

export function run({ argv = [], goalsDir = GOALS_DIR } = {}) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { id: { type: 'string' }, parent: { type: 'string' }, slug: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' } },
    });
    const { parent, slug, title, summary } = values;
    if (!parent || !slug || !title || !summary) return { code: 1, out: '', err: `${USAGE}\n` };
    const id = values.id ?? nextChildId(goalsDir, parent);
    const path = createGoal({ goalsDir, id, parent, slug, title, summary });
    return { code: 0, out: `${id} の雛形を作りました：${path}\n`, err: '' };
  } catch (error) {
    return { code: 1, out: '', err: `${error.message}\n${USAGE}\n` };
  }
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, out, err } = run({ argv: process.argv.slice(2) });
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}
