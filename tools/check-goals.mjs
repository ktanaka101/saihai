#!/usr/bin/env node
// ゴール文書が G1 の書式に従っているかを検査する（G1.1）。
// 違反は「どの文書が、G1 のどの具体例に反しているか」で報告する。
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOALS_DIR = fileURLToPath(new URL('../goals/', import.meta.url));
const REQUIRED_KEYS = ['id', 'parent', 'status', 'version', 'updated'];
const STATUSES = ['議論中', '進行中', '達成', '中止'];
const DECIDED_BY_HUMAN = ['達成', '中止']; // この状態にするのは人の判断で、判例に残す（J18）
const HUMAN_LINE_LIMIT = 40; // 判断待ちを除く（J17）
const PENDING_LABELS = ['推奨', '自明な案', '取り消し']; // 「- 推奨：」のような箇条書きの見出し語。太字は任意
const JUDGMENT_COLUMNS = 5; // ID・日付・判断・上申・置き換え
const JUDGMENT_FROM = /^(―|Q\d+(\s*、\s*Q\d+)*)$/;
const FILE_NAME = /^(G\d+(?:\.\d+)*)-[a-z0-9-]+\.md$/;
const FENCED = '\u0000'; // コードブロックの中身。行としては数えるが、見出しや表としては読まない
const OK = { code: 0, out: '', err: '' };

const isHeading = (line, name) => new RegExp(`^## ${name}(（.*）)?\\s*$`).test(line);
const hasLabel = (lines, label) =>
  lines.some((line) => new RegExp(`^\\s*[-*]\\s*(\\*\\*)?${label}(\\*\\*)?：`).test(line)); // 揺れを許すのは太字だけ
const qIds = (text) => [...(text ?? '').matchAll(/Q\d+/g)].map((m) => m[0]);

function section(lines, name) {
  const start = lines.findIndex((line) => isHeading(line, name));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

// GFM と同じく、開いたときと同じ記号で、同じ長さ以上の行が来たときだけ閉じる。
function maskFences(lines) {
  return lines.reduce(
    (acc, line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1] ?? null;
      const closes = acc.open !== null && marker !== null && marker[0] === acc.open[0] && marker.length >= acc.open.length;
      const fenced = acc.open !== null || marker !== null;
      return {
        open: closes ? null : (acc.open ?? marker),
        lines: [...acc.lines, fenced && line.trim() ? FENCED : line],
      };
    },
    { open: null, lines: [] },
  ).lines;
}

function parseFrontmatter(lines) {
  if (lines[0] !== '---') return { frontmatter: null, bodyStart: 0 };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { frontmatter: null, bodyStart: 0 };
  const entries = lines
    .slice(1, end)
    .map((line) => line.match(/^([\w-]+):\s*(.*)$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value.trim() === 'null' ? null : value.trim()]);
  return { frontmatter: Object.fromEntries(entries), bodyStart: end + 1 };
}

// 判断待ちの節を ### の見出しごとに区切る。Q 以外の見出しや、見出しより前の文章も拾っておき、違反として報告する。
function parsePending(lines) {
  return lines.reduce(
    (acc, line) => {
      if (line.startsWith('### ')) {
        const id = line.match(/^### (Q\d+)(?!\d)/)?.[1] ?? null;
        return { ...acc, items: [...acc.items, { heading: line, id, lines: [] }] };
      }
      if (acc.items.length === 0) return line.trim() ? { ...acc, stray: [...acc.stray, line] } : acc;
      const last = acc.items.at(-1);
      return { ...acc, items: [...acc.items.slice(0, -1), { ...last, lines: [...last.lines, line] }] };
    },
    { items: [], stray: [] },
  );
}

// GFM の表の行を列に分ける。\| はセルの中の文字として扱い、末尾の | は省略されていてもよい。
function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

// 上申列は ― か Q の ID だけ（複数は「、」か「,」区切り）。それ以外の書き方では、中の Q を拾わない。
function parseJudgments(lines) {
  return lines
    .filter((line) => /^\|\s*J\d+\s*\|/.test(line))
    .map(splitRow)
    .map((cells) => {
      const fromValid = JUDGMENT_FROM.test(cells[3] ?? '');
      return { id: cells[0], fromValid, from: fromValid ? qIds(cells[3]) : [], cells };
    });
}

export function parseGoal(path, text) {
  const lines = text.split(/\r?\n/);
  const { frontmatter, bodyStart } = parseFrontmatter(lines);
  const body = maskFences(lines.slice(bodyStart));
  const boundary = body.findIndex((line) => /^## AI 層\s*$/.test(line));
  const human = boundary === -1 ? body : body.slice(0, boundary);
  const ai = boundary === -1 ? [] : body.slice(boundary + 1);
  const { items, stray } = parsePending(section(human, '判断待ち') ?? []);
  const countPending = (lines) => lines.filter((line) => isHeading(line, '判断待ち')).length;
  return {
    path,
    frontmatter,
    hasBoundary: boundary !== -1,
    human,
    pendingSections: { human: countPending(human), ai: countPending(ai) },
    pendingItems: items,
    pendingStray: stray,
    pending: items.filter((item) => item.id),
    judgments: parseJudgments(body),
  };
}

function countHumanLines(human) {
  return human.reduce(
    (acc, line) => {
      const inPending = line.startsWith('## ') ? isHeading(line, '判断待ち') : acc.inPending;
      const counts = !inPending && line.trim() !== '';
      return { inPending, n: acc.n + (counts ? 1 : 0) };
    },
    { inPending: false, n: 0 },
  ).n;
}

function frontmatterViolations({ path, frontmatter: fm }) {
  if (!fm) return ['frontmatter がありません'];
  const fileId = basename(path).match(FILE_NAME)?.[1];
  // parent だけは null（ルート）を許す
  const blank = (key) => fm[key] === '' || (key !== 'parent' && fm[key] === null);
  return [
    ...REQUIRED_KEYS.filter((key) => !(key in fm)).map((key) => `frontmatter に ${key} がありません`),
    ...REQUIRED_KEYS.filter((key) => key in fm && blank(key)).map((key) => `frontmatter の ${key} が空です`),
    ...(fm.id && fileId && fm.id !== fileId ? [`id（${fm.id}）がファイル名（${fileId}）と一致しません`] : []),
    ...(fm.status && !STATUSES.includes(fm.status)
      ? [`status「${fm.status}」は ${STATUSES.join('・')} のどれかにしてください`]
      : []),
    ...(fm.updated && !/^\d{4}-\d{2}-\d{2}$/.test(fm.updated)
      ? [`updated「${fm.updated}」は YYYY-MM-DD の形にしてください`]
      : []),
    ...(fm.parent && fm.parent === fm.id ? [`parent に自分自身（${fm.id}）は指定できません`] : []),
  ];
}

function pendingFormatViolations(goal) {
  return [
    ...(goal.pendingSections.human > 1 ? ['判断待ちの節は1つにしてください'] : []),
    ...(goal.pendingSections.ai > 0 ? ['判断待ちは人間層（## AI 層 より上）に置いてください'] : []),
    ...(goal.pendingStray.length ? ['判断待ちの中には ### Q{番号} の項目だけを書いてください'] : []),
    ...goal.pendingItems
      .filter((item) => !item.id)
      .map((item) => `判断待ちの見出し「${item.heading}」は ### Q{番号} で始めてください`),
  ];
}

function formatViolations(goal) {
  const has = (pattern) => goal.human.some((line) => pattern.test(line));
  return [
    ...(FILE_NAME.test(basename(goal.path)) ? [] : ['ファイル名は G{番号}-{英小文字の短い名前}.md にしてください']),
    ...(has(/^# /) ? [] : ['題名（# の見出し）がありません']),
    ...(has(/^> /) ? [] : ['1行の要約（> で始まる行）がありません']),
    ...['意図', '具体例'].filter((name) => !section(goal.human, name)).map((name) => `人間層に「## ${name}」がありません`),
    ...pendingFormatViolations(goal),
    ...goal.judgments
      .filter((j) => j.cells.length !== JUDGMENT_COLUMNS)
      .map((j) => `判例 ${j.id} の列数が${j.cells.length}です（ID・日付・判断・上申・置き換えの${JUDGMENT_COLUMNS}列）`),
    ...goal.judgments
      .filter((j) => j.cells.length === JUDGMENT_COLUMNS && !j.fromValid)
      .map((j) => `判例 ${j.id} の上申列は ― か Q の ID（複数は「、」区切り）にしてください`),
  ];
}

function closedWithoutJudgment(goal) {
  const status = goal.frontmatter?.status;
  if (!DECIDED_BY_HUMAN.includes(status)) return [];
  if (goal.judgments.some((j) => (j.cells[2] ?? '').includes(status))) return [];
  return [`status を「${status}」にするのは人の判断です（J18）。それを決めた判例をこのゴールに記録してください`];
}

export function checkGoal(goal) {
  const lines = countHumanLines(goal.human);
  const found = [
    ...closedWithoutJudgment(goal).map((message) => ['G1.E10', message]),
    ...frontmatterViolations(goal).map((message) => ['G1.E1', message]),
    ...(goal.hasBoundary ? [] : [['G1.E2', '境界の見出し「## AI 層」がありません']]),
    ...(lines > HUMAN_LINE_LIMIT
      ? [['G1.E3', `人間層が${lines}行あります（判断待ちを除いて${HUMAN_LINE_LIMIT}行まで）。ゴールの分割を検討してください`]]
      : []),
    ...goal.pending.flatMap((q) => {
      const missing = PENDING_LABELS.filter((label) => !hasLabel(q.lines, label));
      return missing.length
        ? [['G1.E4', `${q.id} に ${missing.join('・')} の項目がありません（「- 推奨：」のように箇条書きで書く）`]]
        : [];
    }),
    ...formatViolations(goal).map((message) => ['G1.書式', message]),
  ];
  return found.map(([rule, message]) => ({ path: goal.path, rule, message }));
}

// 複数の文書にまたがる検査。最初に出てきた場所を覚えておき、2回目以降を違反にする。
function duplicates(entries) {
  const firstSeen = new Map();
  return entries.flatMap(({ key, path, ...rest }) => {
    if (firstSeen.has(key)) return [{ key, path, first: firstSeen.get(key), ...rest }];
    firstSeen.set(key, path);
    return [];
  });
}

export function checkRepo(goals) {
  const ids = goals.map((g) => g.frontmatter?.id).filter(Boolean);
  const judgments = goals.flatMap((g) => g.judgments.map((j) => ({ ...j, path: g.path })));
  const fromQ = judgments.flatMap((j) => j.from.map((q) => ({ key: q, path: j.path, id: j.id })));
  const decided = new Map(fromQ.map((d) => [d.key, d.id]));
  const pending = goals.flatMap((g) => g.pending.map((q) => ({ ...q, path: g.path })));
  const violation = (path, rule, message) => ({ path, rule, message });

  return [
    ...goals.flatMap(checkGoal),
    ...goals
      .filter((g) => g.frontmatter?.parent && !ids.includes(g.frontmatter.parent))
      .map((g) => violation(g.path, 'G1.E1', `parent（${g.frontmatter.parent}）に当たるゴールがありません`)),
    ...duplicates(goals.filter((g) => g.frontmatter?.id).map((g) => ({ key: g.frontmatter.id, path: g.path }))).map((d) =>
      violation(d.path, 'G1.E1', `id ${d.key} は ${d.first} でも使われています`),
    ),
    ...pending
      .filter((q) => decided.has(q.id))
      .map((q) =>
        violation(q.path, 'G1.E5', `${q.id} は ${decided.get(q.id)} で判断済みです。判断待ちから消すか、新しい ID を使ってください`),
      ),
    ...duplicates(judgments.map((j) => ({ key: j.id, path: j.path }))).map((d) =>
      violation(d.path, 'G1.E6', `判例 ${d.key} は ${d.first} にもあります`),
    ),
    ...duplicates(pending.map((q) => ({ key: q.id, path: q.path }))).map((d) =>
      violation(d.path, 'G1.E6', `判断待ち ${d.key} は ${d.first} にもあります`),
    ),
    ...duplicates(fromQ).map((d) => violation(d.path, 'G1.E6', `${d.key} から複数の判例（${d.id} など）ができています`)),
  ];
}

// goals/ の Markdown はすべて読む。名前が規則に合わないファイルも、無視せず違反として報告するため。
export function loadGoals(goalsDir) {
  return readdirSync(goalsDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => parseGoal(join('goals', name), readFileSync(join(goalsDir, name), 'utf8')));
}

// macOS の /var と /private/var のように、同じ場所が別のパスで渡されることがあるため実体のパスで比べる。
// まだ存在しないパスは比べようがないので、そのまま絶対パスにする。
function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isGoalFile(filePath, goalsDir) {
  const rel = relative(realPath(goalsDir), realPath(filePath));
  return !rel.startsWith('..') && !isAbsolute(rel) && rel.endsWith('.md');
}

function parseInput(stdin) {
  const input = stdin.trim() ? JSON.parse(stdin) : null;
  return input !== null && typeof input === 'object' ? input : {};
}

function respond(mode, input, lines) {
  const text = `${lines.join('\n')}\n`;
  if (mode === 'cli') return { code: 1, out: '', err: text };
  if (mode === 'stop' && input.stop_hook_active) {
    // 一度直させても残っている＝AI のループが閉じない。止めずに人へ上申する（G0「収束しない」）。
    return { code: 0, out: JSON.stringify({ systemMessage: `ゴール文書の書式違反を AI が直しきれませんでした。\n${text}` }), err: '' };
  }
  return { code: 2, out: '', err: `ゴール文書が G1 の書式に違反しています。直してください。\n${text}` };
}

// --hook は PostToolUse（Edit・Write）用。ゴール文書以外の編集では何もしない。
// --stop は Stop 用。Bash などで編集された場合も含め、作業の終わりに全件を検査する。
// どちらも違反は終了コード2で AI に返す（G1.1.E3）。検査そのものの失敗も、黙って成功扱いにはしない。
// --goals-dir は、実装を見ない評価 AI が自分で用意したゴール文書を検査するためのもの（G3.E6）。
function goalsDirFrom(argv, fallback) {
  const at = argv.indexOf('--goals-dir');
  if (at === -1) return fallback;
  const dir = argv[at + 1];
  if (!dir || dir.startsWith('--')) throw new Error('--goals-dir の後に検査するフォルダを指定してください');
  return resolve(dir);
}

export function run({ argv = [], stdin = '', goalsDir: defaultDir = GOALS_DIR } = {}) {
  const mode = argv.includes('--hook') ? 'hook' : argv.includes('--stop') ? 'stop' : 'cli';
  let input = {};
  try {
    const goalsDir = goalsDirFrom(argv, defaultDir);
    input = mode === 'cli' ? {} : parseInput(stdin);
    if (mode === 'hook') {
      const file = input.tool_input?.file_path;
      if (!file || !isGoalFile(file, goalsDir)) return OK;
    }
    const goals = loadGoals(goalsDir);
    const violations = checkRepo(goals);
    if (violations.length === 0) {
      return mode === 'cli' ? { ...OK, out: `ゴール文書 ${goals.length} 件：違反なし\n` } : OK;
    }
    return respond(mode, input, [
      ...violations.map((v) => `${v.path}: [${v.rule}] ${v.message}`),
      `ゴール文書 ${goals.length} 件：違反 ${violations.length} 件`,
    ]);
  } catch (error) {
    return respond(mode, input, [`検査そのものが失敗しました：${error.message}`]);
  }
}

// import.meta.url は実体のパスになるので、起動時のパスも実体に直して比べる。
// ここを誤ると、検査が走らないまま終了コード0で成功扱いになる。
if (process.argv[1] && realPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const fromHook = argv.includes('--hook') || argv.includes('--stop');
  const { code, out, err } = run({ argv, stdin: fromHook ? readFileSync(0, 'utf8') : '' });
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}
