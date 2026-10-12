#!/usr/bin/env node
// 委任指示（G8）。人が決めたゴール文書を、実装する AI への指示（指揮官の意図・制約・報告条件）にまとめる。
// 祖先のゴールの不変条件・推奨・仮置き・報告条件と、強さが不変条件の判例を引き継ぐ。
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGoals, section } from './check-goals.mjs';

const GOALS_DIR = fileURLToPath(new URL('../goals/', import.meta.url));

const bullets = (lines) => (lines ?? []).filter((l) => l.startsWith('- ')).map((l) => l.trim());
const titleOf = (goal) => goal.human.find((l) => l.startsWith('# '))?.slice(2) ?? goal.frontmatter.id;

// 祖先から対象までのゴールを並べる
function lineageOf(goals, id) {
  const byId = new Map(goals.map((g) => [g.frontmatter?.id, g]));
  if (!byId.has(id)) throw new Error(`ゴール ${id} が見つかりません`);
  const lineage = [];
  for (let g = byId.get(id); g; g = byId.get(g.frontmatter.parent)) lineage.unshift(g);
  return lineage;
}

const block = (heading, lines, note) => [`## ${heading}`, '', ...(note ? [note, ''] : []), ...(lines.length ? lines : ['- なし']), ''];

export function buildBrief(goals, id) {
  const lineage = lineageOf(goals, id);
  const target = lineage.at(-1);
  const inherited = (name) => lineage.flatMap((g) => bullets(section(g.human, name)).map((l) => `${l}（${g.frontmatter.id}）`));
  const invariantJudgments = lineage.flatMap((g) =>
    g.judgments.filter((j) => j.strength === '不変条件').map((j) => `- ${j.id}：${j.cells[2]}（${g.frontmatter.id} の判例）`),
  );
  const log = (kind, rest) => `\`npm run log -- --goal ${id} --kind ${kind} ${rest}\``;
  return [
    `# 委任指示：${titleOf(target)}`,
    '',
    '> あなた（実装する AI）への指示です。人は実装中には対応しません。報告条件に当たったときだけ止まって聞いてください。それ以外はゴールの範囲で自分で決め、判断ログに残して進んでください。',
    '',
    ...block('指揮官の意図', bullets(section(target.human, '意図'))),
    ...block('仮説と判定（何を確かめるために作るか）', bullets(section(target.human, '仮説と判定'))),
    ...block('不変条件', [...inherited('不変条件'), ...invariantJudgments], '必ず守る。破る必要が生じたら、止まって報告する。'),
    ...block('推奨', inherited('推奨'), '原則として守る。より良い理由があれば逸脱してよいが、判断ログに relation「逸脱」で、目的との衝突と守った場合に失うものを書く。'),
    ...block('仮置き', inherited('仮置き'), '暫定の決め。変えてよいが、判断ログに relation「仮置きの変更」で書く。'),
    ...block('報告条件（該当したら止まって人に聞く）', inherited('報告条件')),
    ...block('受け入れの具体例', bullets(section(target.human, '具体例'))),
    ...block('非ゴール（やらないこと）', bullets(section(target.human, '非ゴール'))),
    '## 進め方',
    '',
    `1. 着手する前に、このゴールの解釈（何を作り、何を作らないか、どう確かめるか）を3行で要約し、バックブリーフとして残す：${log('バックブリーフ', '--decision "…"')}`,
    `2. 報告条件に当たらない判断は自分で決め、判断ログに残して先に進む：${log('判断', '--decision "…" --related "…" --reason "…" --rejected "…" --relation 従った --reversibility 容易 --impact "…"')}`,
    '3. 推奨・仮置きから逸脱するときは、relation を「逸脱」か「仮置きの変更」にし、目的との衝突と、守った場合に失うものを reason に書く',
    `4. 不変条件から逸脱する必要が生じたり、報告条件に当たったりしたら、止まって報告する：${log('報告', '--decision "…" --reason "…"')}`,
    '5. 理由のない制約や、目的に合わない制約に気づいたら、黙って従わずに relation「指摘」で残す',
    '6. 作業ブランチ（work/<名前>）で実装し、`npm run gate` で main に反映する。main に直接コミットしない',
    '',
  ].join('\n');
}

export function run({ argv = [], goalsDir = GOALS_DIR } = {}) {
  const id = argv[0];
  if (!id) return { code: 1, out: '', err: '使い方：npm run brief -- <ゴールの ID>\n' };
  try {
    return { code: 0, out: buildBrief(loadGoals(goalsDir), id), err: '' };
  } catch (error) {
    return { code: 1, out: '', err: `${error.message}\n` };
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
