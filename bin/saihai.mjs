#!/usr/bin/env node
// saihai コマンド（G9.E1）。サブコマンドを各ツールに振り分け、対象のプロジェクト（ルート）を渡す。
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { run as aar } from '../tools/aar.mjs';
import { run as answer } from '../tools/answer.mjs';
import { run as brief } from '../tools/brief.mjs';
import { run as check } from '../tools/check-goals.mjs';
import { run as log } from '../tools/decision-log.mjs';
import { run as gate } from '../tools/gate.mjs';
import { guard } from '../tools/guard-main.mjs';
import { run as inbox } from '../tools/inbox.mjs';
import { initProject, saihaiCommand } from '../tools/init.mjs';
import { run as newGoal } from '../tools/new-goal.mjs';
import { run as observe } from '../tools/observe.mjs';
import { commandOf, findRoot } from '../tools/root.mjs';

const USAGE = `使い方：saihai <サブコマンド> [--root <フォルダ>]

  init      このフォルダに saihai を導入する（G0・判断ログ・設定・CLAUDE.md の節・スキル・フック）
  new       ゴール文書の雛形を作る（--parent G0 --slug name --title "題名" --summary "要約"）
  check     ゴール文書と判断ログを検査する
  brief     委任指示を出す（saihai brief G1）
  log       判断ログに1件足す（--goal G1 --kind 判断 ...）
  inbox     受信箱：いま人が判断すべきこと
  answer    判断待ちに答える（saihai answer Q12 推奨 / 自明な案 / --text "…"）
  observe   観測と仮説の判定（--save で履歴に残す、--record 指標=値 で記録する）
  aar       事後検証の材料（saihai aar G1）
  gate      門番：main とマージした結果を検査し、通れば main に反映する
  guard     Claude Code のフック用：main への直接のコミットを止める

対象のプロジェクトは --root、環境変数 SAIHAI_ROOT、今のフォルダから上へたどる、の順で決まる。
`;

const NEEDS_ROOT = {
  new: (root, argv) => newGoal({ argv, goalsDir: join(root, 'goals') }),
  check: (root, argv, stdin) => check({ argv, stdin, goalsDir: join(root, 'goals') }),
  brief: (root, argv) => brief({ argv, goalsDir: join(root, 'goals'), command: commandOf(root) }),
  log: (root, argv) => log({ argv, goalsDir: join(root, 'goals') }),
  inbox: (root) => inbox({ root }),
  answer: (root, argv) => answer({ argv, goalsDir: join(root, 'goals') }),
  observe: (root, argv) => observe({ argv, root }),
  aar: (root, argv) => aar({ argv, root }),
  gate: (root) => gate({ root }),
};

function init(argv, cwd) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string' }, command: { type: 'string' }, force: { type: 'boolean' } } });
  const root = resolve(cwd, values.root ?? '.');
  return { code: 0, out: initProject({ root, command: values.command ?? saihaiCommand(), force: values.force ?? false }), err: '' };
}

export function main({ argv = [], env = process.env, cwd = process.cwd(), stdin = '' } = {}) {
  const [command, ...rest] = argv;
  try {
    if (command === 'init') return init(rest, cwd);
    if (command === 'guard') {
      const { code, err } = guard({ stdin });
      return { code, out: '', err };
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
