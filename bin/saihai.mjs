#!/usr/bin/env node
// saihai コマンド（G9.E1）。サブコマンドを各ツールに振り分け、対象のプロジェクト（ルート）を渡す。
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { run as aar } from '../tools/aar.mjs';
import { run as answer } from '../tools/answer.mjs';
import { run as brief } from '../tools/brief.mjs';
import { run as check } from '../tools/check-goals.mjs';
import { run as log, runConfirm as confirm } from '../tools/decision-log.mjs';
import { run as gate } from '../tools/gate.mjs';
import { guard } from '../tools/guard-main.mjs';
import { run as inbox } from '../tools/inbox.mjs';
import { TEMPLATES_DIR, initProject, renderTemplate, saihaiCommand } from '../tools/init.mjs';
import { run as newGoal } from '../tools/new-goal.mjs';
import { run as observe } from '../tools/observe.mjs';
import { commandOf, findRoot, readConfig } from '../tools/root.mjs';

const USAGE = `使い方：saihai <サブコマンド> [--root <フォルダ>]

  init      このフォルダに saihai を導入する（G0・判断ログ・設定・CLAUDE.md の節・スキル・フック）。
            --minimal ならゴール文書・判断ログ・設定だけ（プラグインで使うとき）
  new       ゴール文書の雛形を作る（--parent G0 --slug name --title "題名" --summary "要約"）
  check     ゴール文書と判断ログを検査する
  brief     委任指示を出す（saihai brief G1）
  log       判断ログに1件足す（--goal G1 --kind 判断 ...）
  inbox     受信箱：いま人が判断すべきこと
  answer    判断待ちに答える（saihai answer Q12 推奨 / 自明な案 / --text "…"）
  confirm   受信箱の事後確認を見たら、確認済みにする（saihai confirm D3 D6）
  observe   観測と仮説の判定（--save で履歴に残す、--record 指標=値 で記録する）
  aar       事後検証の材料（saihai aar G1）
  gate      門番：main とマージした結果を検査し、通れば main に反映する
  guard     Claude Code のフック用：main への直接のコミットを止める（設定で guard: true のときだけ）
  context   Claude Code のフック用：セッションの始めに委任の約束を文脈に入れる

対象のプロジェクトは --root、環境変数 SAIHAI_ROOT、今のフォルダから上へたどる、の順で決まる。
`;

const NEEDS_ROOT = {
  new: (root, argv) => newGoal({ argv, goalsDir: join(root, 'goals') }),
  check: (root, argv, stdin) => check({ argv, stdin, goalsDir: join(root, 'goals') }),
  brief: (root, argv) => brief({ argv, goalsDir: join(root, 'goals'), command: commandOf(root) }),
  log: (root, argv) => log({ argv, goalsDir: join(root, 'goals') }),
  inbox: (root) => inbox({ root }),
  answer: (root, argv) => answer({ argv, goalsDir: join(root, 'goals') }),
  confirm: (root, argv) => confirm({ argv, goalsDir: join(root, 'goals') }),
  observe: (root, argv) => observe({ argv, root }),
  aar: (root, argv) => aar({ argv, root }),
  gate: (root) => gate({ root }),
};

function init(argv, cwd) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string' }, command: { type: 'string' }, force: { type: 'boolean' }, minimal: { type: 'boolean' } } });
  const root = resolve(cwd, values.root ?? '.');
  return { code: 0, out: initProject({ root, command: values.command ?? saihaiCommand(), force: values.force ?? false, minimal: values.minimal ?? false }), err: '' };
}

// プラグインのフックは、入れたすべてのプロジェクトで動く。saihai を使っていないプロジェクトでは何もしない（G10.E2）
const OK = { code: 0, out: '', err: '' };
const usesSaihai = (root) => Boolean(root) && (existsSync(join(root, 'goals')) || existsSync(join(root, 'saihai.config.json')));
const hookRoot = (argv, env, cwd) => {
  const { root, argv: args, error } = findRoot({ argv, env, cwd });
  return { root: !error && usesSaihai(root) ? root : null, args };
};
const parseInput = (stdin) => {
  try {
    return JSON.parse(stdin);
  } catch {
    return {};
  }
};

// guard は設定で guard: true にしたプロジェクトだけで効く（G10.E3・J85）
function guardHook(argv, env, cwd, stdin) {
  const { root } = hookRoot(argv, env, parseInput(stdin).cwd ?? env.CLAUDE_PROJECT_DIR ?? cwd);
  if (!root || readConfig(root).guard !== true) return OK;
  const { code, err } = guard({ stdin });
  return { code, out: '', err };
}

// セッションの始めに、委任の約束を文脈に入れる。CLAUDE.md を書き換えずに済む（G10.E4）
function contextHook(argv, env, cwd) {
  const { root } = hookRoot(argv, env, env.CLAUDE_PROJECT_DIR ?? cwd);
  if (!root) return OK;
  const additionalContext = renderTemplate(readFileSync(join(TEMPLATES_DIR, 'CLAUDE.md'), 'utf8'), commandOf(root));
  return { code: 0, out: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`, err: '' };
}

export function main({ argv = [], env = process.env, cwd = process.cwd(), stdin = '' } = {}) {
  const [command, ...rest] = argv;
  try {
    if (command === 'init') return init(rest, cwd);
    if (command === 'guard') return guardHook(rest, env, cwd, stdin);
    if (command === 'context') return contextHook(rest, env, cwd);
    // フックから呼ばれた検査は、saihai を使っていないプロジェクトでは何もしない
    if (command === 'check' && (rest.includes('--hook') || rest.includes('--stop'))) {
      const { root, args } = hookRoot(rest, env, cwd);
      return root ? check({ argv: args, stdin, goalsDir: join(root, 'goals') }) : OK;
    }
    if (!Object.hasOwn(NEEDS_ROOT, command ?? '')) return { code: 1, out: '', err: USAGE };
    const { root, argv: args, error } = findRoot({ argv: rest, env, cwd });
    if (error) return { code: 1, out: '', err: `${error}\n` };
    if (!root) return { code: 1, out: '', err: 'saihai のプロジェクトが見つかりません。saihai init で導入するか、--root で指定してください\n' };
    return NEEDS_ROOT[command](root, args, stdin);
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
  const argv = process.argv.slice(2);
  // フック（check --hook・check --stop・guard）だけが標準入力を読む
  const readsStdin = argv[0] === 'guard' || argv.includes('--hook') || argv.includes('--stop');
  const { code, out, err } = main({ argv, stdin: readsStdin ? readFileSync(0, 'utf8') : '' });
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}
