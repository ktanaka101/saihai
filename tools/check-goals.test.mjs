import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGoal, checkRepo, isGoalFile, loadGoals, parseGoal, run } from './check-goals.mjs';

const VALID = `---
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

### 判例

| ID | 日付 | 判断 | 上申 | 置き換え |
|---|---|---|---|---|
`;

const PENDING_OK = `## 判断待ち

### Q3 問い

- **推奨**：A
- **自明な案**：B
- 取り消し：可能

`;

const parse = (text, name = 'G9-test.md') => parseGoal(`goals/${name}`, text);
const rules = (violations) => violations.map((v) => v.rule);
const withPending = (text, pending) => text.replace('## 意図', `${pending}## 意図`);
const withJudgment = (text, row) => `${text}${row}\n`;
const goal = (id, extra = (t) => t) =>
  parse(extra(VALID.replace('id: G9', `id: ${id}`)), `${id}-x.md`);

test('書式どおりの文書には違反がない', () => {
  assert.deepEqual(checkGoal(parse(VALID)), []);
});

test('G1.E1: frontmatter がなければ違反', () => {
  const text = VALID.slice(VALID.indexOf('# G9'));
  assert.deepEqual(rules(checkGoal(parse(text))), ['G1.E1']);
});

test('G1.E1: 必須の項目が欠けていれば違反', () => {
  const v = checkGoal(parse(VALID.replace('status: 進行中\n', '')));
  assert.deepEqual(rules(v), ['G1.E1']);
  assert.match(v[0].message, /status/);
});

test('G1.E1: id とファイル名が一致しなければ違反', () => {
  assert.deepEqual(rules(checkGoal(parse(VALID, 'G8-test.md'))), ['G1.E1']);
});

test('G1.E1: status が決められた値でなければ違反', () => {
  assert.deepEqual(rules(checkGoal(parse(VALID.replace('進行中', '完了')))), ['G1.E1']);
});

test('G1.E2: 境界の見出しがなければ違反', () => {
  assert.deepEqual(rules(checkGoal(parse(VALID.replace('## AI 層', '## 補足')))), ['G1.E2']);
});

test('G1.E3: 人間層が40行を超えれば違反', () => {
  const long = Array.from({ length: 40 }, (_, i) => `- 行${i}`).join('\n');
  const text = VALID.replace('理由', `理由\n${long}`);
  assert.deepEqual(rules(checkGoal(parse(text))), ['G1.E3']);
});

test('G1.E3: 判断待ちの行は数えない', () => {
  const long = Array.from({ length: 40 }, (_, i) => `- 補足${i}`).join('\n');
  const text = withPending(VALID, PENDING_OK.replace('- 取り消し：可能', `- 取り消し：可能\n${long}`));
  assert.deepEqual(checkGoal(parse(text)), []);
});

test('G1.E4: 判断待ちに推奨・自明な案・取り消しがそろっていれば違反なし', () => {
  assert.deepEqual(checkGoal(parse(withPending(VALID, PENDING_OK))), []);
});

test('G1.E4: 判断待ちに自明な案がなければ違反', () => {
  const v = checkGoal(parse(withPending(VALID, PENDING_OK.replace('- **自明な案**：B\n', ''))));
  assert.deepEqual(rules(v), ['G1.E4']);
  assert.match(v[0].message, /Q3.*自明な案/);
});

test('G1 書式: 題名・要約・意図・具体例が欠けていれば違反', () => {
  for (const [from, to] of [['# G9 テスト', 'G9 テスト'], ['> 要約', '要約'], ['## 意図', '## 背景'], ['## 具体例', '## 例']]) {
    assert.deepEqual(rules(checkGoal(parse(VALID.replace(from, to)))), ['G1.書式'], from);
  }
});

test('G1 書式: 見出しの後ろに括弧書きがあっても節として認める', () => {
  assert.deepEqual(checkGoal(parse(VALID.replace('## 意図', '## 意図（なぜ）'))), []);
});

test('G1 書式: 判例の列数が5でなければ違反', () => {
  const v = checkGoal(parse(withJudgment(VALID, '| J1 | 2026-10-12 | 判断 | ― |')));
  assert.deepEqual(rules(v), ['G1.書式']);
});

test('G1.E5: 判例に移った Q が判断待ちに残っていれば違反', () => {
  const v = checkRepo([
    goal('G8', (t) => withPending(t, PENDING_OK)),
    goal('G9', (t) => withJudgment(t, '| J1 | 2026-10-12 | 判断 | Q3 | ― |')),
  ]);
  assert.deepEqual(rules(v), ['G1.E5']);
  assert.match(v[0].message, /Q3.*J1/);
});

test('G1.E6: 判例の ID が重複すれば違反', () => {
  const row = '| J1 | 2026-10-12 | 判断 | ― | ― |';
  const v = checkRepo([goal('G8', (t) => withJudgment(t, row)), goal('G9', (t) => withJudgment(t, row))]);
  assert.deepEqual(rules(v), ['G1.E6']);
});

test('G1.E6: 判断待ちの ID が重複すれば違反', () => {
  const v = checkRepo([goal('G8', (t) => withPending(t, PENDING_OK)), goal('G9', (t) => withPending(t, PENDING_OK))]);
  assert.deepEqual(rules(v), ['G1.E6']);
});

test('G1.E6: 同じ Q から複数の判例があれば違反', () => {
  const v = checkRepo([
    goal('G9', (t) => withJudgment(withJudgment(t, '| J1 | 2026-10-12 | 判断 | Q3 | ― |'), '| J2 | 2026-10-12 | 判断 | Q3 | ― |')),
  ]);
  assert.deepEqual(rules(v), ['G1.E6']);
});

test('G1.E1: parent に当たるゴールがなければ違反', () => {
  const v = checkRepo([goal('G9', (t) => t.replace('parent: null', 'parent: G7'))]);
  assert.deepEqual(rules(v), ['G1.E1']);
});

test('G1.E1: 親子関係が正しければ違反なし', () => {
  assert.deepEqual(checkRepo([goal('G8'), goal('G9', (t) => t.replace('parent: null', 'parent: G8'))]), []);
});

test('G1.E1: ゴールの id が重複すれば違反', () => {
  const v = checkRepo([goal('G9'), parse(VALID, 'G9-other.md')]);
  assert.deepEqual(rules(v), ['G1.E1']);
});

test('isGoalFile: goals/ 直下の Markdown だけを対象にする', () => {
  assert.equal(isGoalFile('/repo/goals/G1-x.md', '/repo/goals'), true);
  assert.equal(isGoalFile('/repo/tools/x.md', '/repo/goals'), false);
  assert.equal(isGoalFile('/repo/goals/notes.txt', '/repo/goals'), false);
});

test('isGoalFile: シンボリックリンク経由のパスでも同じ場所なら対象にする', () => {
  const real = mkdtempSync(join(tmpdir(), 'saihai-real-'));
  const link = `${real}-link`;
  symlinkSync(real, link);
  writeFileSync(join(real, 'G1-x.md'), '');
  assert.equal(isGoalFile(join(link, 'G1-x.md'), real), true);
  assert.equal(isGoalFile(join(real, 'G1-x.md'), link), true);
});

const tempGoals = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'saihai-goals-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};

test('run: 違反がなければ終了コード0', () => {
  const r = run({ goalsDir: tempGoals({ 'G9-test.md': VALID }) });
  assert.equal(r.code, 0);
  assert.match(r.out, /1 件：違反なし/);
});

test('run: 違反があれば終了コード1で、文書と具体例を示す', () => {
  const r = run({ goalsDir: tempGoals({ 'G9-test.md': VALID.replace('## AI 層', '## 補足') }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /G9-test\.md: \[G1\.E2\]/);
});

test('run --hook: ゴール文書以外の編集では検査しない', () => {
  const stdin = JSON.stringify({ tool_input: { file_path: '/elsewhere/README.md' } });
  assert.deepEqual(run({ argv: ['--hook'], stdin, goalsDir: '/nonexistent/goals' }), { code: 0, out: '', err: '' });
});

test('run --hook: 入力が空なら検査しない', () => {
  assert.equal(run({ argv: ['--hook'], stdin: '', goalsDir: '/nonexistent/goals' }).code, 0);
});

test('run --hook: ゴール文書に違反があれば終了コード2で AI に返す', () => {
  const dir = tempGoals({ 'G9-test.md': VALID.replace('## AI 層', '## 補足') });
  const stdin = JSON.stringify({ tool_input: { file_path: join(dir, 'G9-test.md') } });
  const r = run({ argv: ['--hook'], stdin, goalsDir: dir });
  assert.equal(r.code, 2);
  assert.match(r.err, /直してください/);
});

test('run --hook: ゴール文書に違反がなければ何も出さない', () => {
  const dir = tempGoals({ 'G9-test.md': VALID });
  const stdin = JSON.stringify({ tool_input: { file_path: join(dir, 'G9-test.md') } });
  assert.deepEqual(run({ argv: ['--hook'], stdin, goalsDir: dir }), { code: 0, out: '', err: '' });
});

// --- レビューで見つかったすり抜け・誤検出 ---

test('判断待ちの節が2つあれば違反', () => {
  const v = checkGoal(parse(withPending(withPending(VALID, PENDING_OK), PENDING_OK.replace('Q3', 'Q4'))));
  assert.ok(rules(v).includes('G1.書式'));
});

test('判断待ちが AI 層にあれば違反', () => {
  assert.deepEqual(rules(checkGoal(parse(`${VALID}\n${PENDING_OK}`))), ['G1.書式']);
});

test('判断待ちの中の見出しが ### Q{番号} でなければ違反', () => {
  const text = withPending(VALID, PENDING_OK.replace('### Q3 問い', '### 問い（Q3）'));
  assert.deepEqual(rules(checkGoal(parse(text))), ['G1.書式']);
});

test('判断待ちの中に Q の項目以外の文章があれば違反（行数の上限の抜け道を塞ぐ）', () => {
  const prose = Array.from({ length: 60 }, (_, i) => `文章${i}`).join('\n');
  assert.deepEqual(rules(checkGoal(parse(withPending(VALID, `## 判断待ち\n\n${prose}\n\n`)))), ['G1.書式']);
});

test('Q の後ろの別の見出しの内容は、Q の項目に数えない', () => {
  const pending = '## 判断待ち\n\n### Q3 問い\n\n- **推奨**：A\n\n### 補足\n\n- **自明な案**：B\n- 取り消し：可能\n\n';
  assert.deepEqual(rules(checkGoal(parse(withPending(VALID, pending)))).sort(), ['G1.E4', 'G1.書式']);
});

test('G1.E1: 必須の項目が空なら違反', () => {
  for (const [from, to] of [['id: G9', 'id: null'], ['id: G9', 'id:'], ['updated: 2026-10-12', 'updated:']]) {
    assert.ok(rules(checkGoal(parse(VALID.replace(from, to)))).includes('G1.E1'), to);
  }
});

test('G1.E1: updated が日付の形でなければ違反', () => {
  assert.deepEqual(rules(checkGoal(parse(VALID.replace('2026-10-12', '昨日')))), ['G1.E1']);
});

test('G1.E1: parent が自分自身なら違反', () => {
  assert.deepEqual(rules(checkGoal(parse(VALID.replace('parent: null', 'parent: G9')))), ['G1.E1']);
});

test('ファイル名が G{番号}-{名前}.md でなければ違反', () => {
  assert.ok(rules(checkGoal(parse(VALID, 'g9-test.md'))).includes('G1.書式'));
});

test('コードブロックの中の見出しは境界として扱わない', () => {
  const long = Array.from({ length: 41 }, (_, i) => `- 行${i}`).join('\n');
  const text = VALID.replace('理由', `理由\n\n\`\`\`md\n## AI 層\n\`\`\`\n\n${long}`);
  assert.deepEqual(rules(checkGoal(parse(text))), ['G1.E3']);
});

test('コードブロックの中の表は判例として扱わない', () => {
  const text = VALID.replace('理由', '理由\n\n```md\n| J1 | 例 |\n```');
  assert.deepEqual(checkGoal(parse(text)), []);
});

test('G1.E5: 上申列に複数の Q があっても、判断待ちに残っていれば違反', () => {
  const v = checkRepo([
    goal('G8', (t) => withPending(t, PENDING_OK)),
    goal('G9', (t) => withJudgment(t, '| J1 | 2026-10-12 | 判断 | Q3、Q4 | ― |')),
  ]);
  assert.deepEqual(rules(v), ['G1.E5']);
});

test('エスケープしたパイプや末尾のパイプがない行も正しく列を数える', () => {
  for (const row of ['| J1 | 2026-10-12 | `a\\|b` を使う | ― | ― |', '| J1 | 2026-10-12 | 判断 | ― | ―']) {
    assert.deepEqual(checkGoal(parse(withJudgment(VALID, row))), [], row);
  }
});

test('run: 検査そのものが失敗したら、黙って成功扱いにしない', () => {
  const cli = run({ goalsDir: '/nonexistent/goals' });
  assert.equal(cli.code, 1);
  assert.match(cli.err, /検査そのものが失敗/);
  const stdin = JSON.stringify({ tool_input: { file_path: '/nonexistent/goals/G1-x.md' } });
  assert.equal(run({ argv: ['--hook'], stdin, goalsDir: '/nonexistent/goals' }).code, 2);
});

test('run --hook: 壊れた JSON を受け取ったら終了コード2で知らせる', () => {
  const r = run({ argv: ['--hook'], stdin: '{bad', goalsDir: '/nonexistent/goals' });
  assert.equal(r.code, 2);
  assert.match(r.err, /検査そのものが失敗/);
});

test('run --hook: 入力が null でも落ちない', () => {
  assert.equal(run({ argv: ['--hook'], stdin: 'null', goalsDir: '/nonexistent/goals' }).code, 0);
});

test('run --stop: 違反がなければ何も出さない', () => {
  const dir = tempGoals({ 'G9-test.md': VALID });
  assert.deepEqual(run({ argv: ['--stop'], stdin: '{}', goalsDir: dir }), { code: 0, out: '', err: '' });
});

test('run --stop: 違反があれば終了コード2で AI に直させる', () => {
  const dir = tempGoals({ 'G9-test.md': VALID.replace('## AI 層', '## 補足') });
  const r = run({ argv: ['--stop'], stdin: '{}', goalsDir: dir });
  assert.equal(r.code, 2);
  assert.match(r.err, /G1\.E2/);
});

test('run --stop: AI が直しきれずに再び止まろうとしたら、人に上申する', () => {
  const dir = tempGoals({ 'G9-test.md': VALID.replace('## AI 層', '## 補足') });
  const r = run({ argv: ['--stop'], stdin: JSON.stringify({ stop_hook_active: true }), goalsDir: dir });
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.out).systemMessage, /直しきれません/);
});

// --- 再レビューで見つかった、修正による誤検出 ---

test('Q の見出しは番号の直後に記号が続いてもよい', () => {
  for (const heading of ['### Q3：問い', '### Q3（問い）']) {
    assert.deepEqual(checkGoal(parse(withPending(VALID, PENDING_OK.replace('### Q3 問い', heading)))), [], heading);
  }
});

test('コードブロックは開いたときと同じ記号で閉じる', () => {
  assert.deepEqual(checkGoal(parse(VALID.replace('理由', '理由\n\n```\n~~~\n```'))), []);
});

test('上申列は ― か Q の ID だけ。それ以外の書き方は違反にし、中の Q を拾わない', () => {
  const v = checkRepo([
    goal('G8', (t) => withPending(t, PENDING_OK.replace('Q3', 'Q2'))),
    goal('G9', (t) => withJudgment(t, '| J1 | 2026-10-12 | 判断 | Q3（Q2 とは別） | ― |')),
  ]);
  assert.deepEqual(rules(v), ['G1.書式']);
});

// G3.E6：実装を見ない評価 AI が、仕様とのずれを見つけた（G1 の書式の定義が正）

test('上申列の Q は「、」で区切って複数書ける', () => {
  assert.deepEqual(checkGoal(parse(withJudgment(VALID, '| J1 | 2026-10-12 | 判断 | Q3、Q4 | ― |'))), []);
});

test('上申列を「,」で区切ると違反（書式の定義は「、」区切り）', () => {
  for (const from of ['Q3, Q4', 'Q3,Q4']) {
    assert.deepEqual(rules(checkGoal(parse(withJudgment(VALID, `| J1 | 2026-10-12 | 判断 | ${from} | ― |`)))), ['G1.書式'], from);
  }
});

test('G1.E1: version がなければ違反（書式の定義では必須）', () => {
  assert.deepEqual(rules(checkGoal(parse(VALID.replace('version: 0.1\n', '')))), ['G1.E1']);
});

test('G1.E4: 判断待ちの3つの項目は、箇条書きの見出し語として書く（太字は任意）', () => {
  const plain = PENDING_OK.replace('**推奨**', '推奨').replace('**自明な案**', '自明な案');
  assert.deepEqual(checkGoal(parse(withPending(VALID, plain))), []);
});

test('G1.E4: 見出し語の後ろは全角の「：」。半角の「:」は違反（G3.2 で2つの評価 AI が一致して指摘）', () => {
  const halfwidth = PENDING_OK.replace('**推奨**：', '**推奨**: ');
  const v = checkGoal(parse(withPending(VALID, halfwidth)));
  assert.deepEqual(rules(v), ['G1.E4']);
  assert.match(v[0].message, /推奨/);
});

test('G1.E4: 本文に「取り消し」という語があるだけでは、取り消しの可否とみなさない', () => {
  const loose = PENDING_OK.replace('- 取り消し：可能', '- 補足：取り消しは可');
  const v = checkGoal(parse(withPending(VALID, loose)));
  assert.deepEqual(rules(v), ['G1.E4']);
  assert.match(v[0].message, /取り消し/);
});

// --- J45：判断待ちは1つの文書に5件まで（G1.E11） ---

test('G1.E11: 判断待ちが5件までなら違反なし、6件なら違反', () => {
  const pending = (n) =>
    `## 判断待ち\n\n${Array.from({ length: n }, (_, i) => `### Q${i + 1} 問い\n\n- **推奨**：A\n- **自明な案**：B\n- 取り消し：可能\n`).join('\n')}\n`;
  assert.deepEqual(checkGoal(parse(withPending(VALID, pending(5)))), []);
  const v = checkGoal(parse(withPending(VALID, pending(6))));
  assert.deepEqual(rules(v), ['G1.E11']);
  assert.match(v[0].message, /6件/);
});

// --- J18：ゴールを達成・中止にするのは人。その判断は判例に残す ---

test('G1.E10: 達成・中止のゴールに、それを決めた判例がなければ違反', () => {
  for (const status of ['達成', '中止']) {
    const v = checkGoal(parse(VALID.replace('status: 進行中', `status: ${status}`)));
    assert.deepEqual(rules(v), ['G1.E10'], status);
  }
});

test('G1.E10: 達成・中止を決めた判例があれば違反なし', () => {
  for (const status of ['達成', '中止']) {
    const text = withJudgment(VALID.replace('status: 進行中', `status: ${status}`), `| J1 | 2026-10-12 | G9 を${status}とする | Q3 | ― |`);
    assert.deepEqual(checkGoal(parse(text)), [], status);
  }
});

test('G1.E10: 別の状態を決めた判例では足りない', () => {
  const text = withJudgment(VALID.replace('status: 進行中', 'status: 達成'), '| J1 | 2026-10-12 | G9 を中止とする | Q3 | ― |');
  assert.deepEqual(rules(checkGoal(parse(text))), ['G1.E10']);
});

// --- G3.E6：実装を見ない評価 AI が、外から検査対象のフォルダを指定して使う ---

test('run --goals-dir: 指定したフォルダのゴール文書を検査する', () => {
  const dir = tempGoals({ 'G9-test.md': VALID.replace('## AI 層', '## 補足') });
  const r = run({ argv: ['--goals-dir', dir], goalsDir: '/nonexistent/goals' });
  assert.equal(r.code, 1);
  assert.match(r.err, /G9-test\.md: \[G1\.E2\]/);
});

test('run --goals-dir: フォルダの指定がなければ検査の失敗として扱う', () => {
  const r = run({ argv: ['--goals-dir'] });
  assert.equal(r.code, 1);
  assert.match(r.err, /--goals-dir/);
});

test('CLI: シンボリックリンク経由で起動しても検査が実際に走る', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const link = join(mkdtempSync(join(tmpdir(), 'saihai-cli-')), 'repo');
  symlinkSync(root, link);
  const r = spawnSync(process.execPath, [join(link, 'tools', 'check-goals.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /違反なし/);
});

test('このリポジトリのゴール文書はすべて書式に従っている', () => {
  const goalsDir = fileURLToPath(new URL('../goals/', import.meta.url));
  assert.deepEqual(checkRepo(loadGoals(goalsDir)), []);
});
