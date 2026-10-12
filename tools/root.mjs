// 対象のプロジェクト（ルート）を決める（G9.E1・J79）。
// --root → 環境変数 SAIHAI_ROOT → 今のフォルダから上へ、saihai.config.json か goals/G0-*.md がある最初のフォルダ
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const isDir = (path) => existsSync(path) && statSync(path).isDirectory();
const isRoot = (dir) => existsSync(join(dir, 'saihai.config.json')) || (isDir(join(dir, 'goals')) && readdirSync(join(dir, 'goals')).some((n) => /^G0-.*\.md$/.test(n)));

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

// --root を取り除いた引数も返す（各ツールの引数の解釈に渡すため）
function takeRootOption(argv) {
  const rest = [];
  let root;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      root = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith('--root=')) {
      root = argv[i].slice('--root='.length);
    } else {
      rest.push(argv[i]);
    }
  }
  return { root, rest };
}

export function findRoot({ argv = [], env = process.env, cwd = process.cwd() } = {}) {
  const { root, rest } = takeRootOption(argv);
  // 指定されたフォルダがなければルートにしない（打ち間違いで別の場所に書かないように）
  const given = (path, label) => (isDir(path) ? { root: real(path), argv: rest } : { root: null, argv: rest, error: `${label} のフォルダ ${path} がありません` });
  if (root) return given(resolve(cwd, root), '--root');
  if (env.SAIHAI_ROOT) return given(resolve(cwd, env.SAIHAI_ROOT), 'SAIHAI_ROOT');
  for (let dir = real(cwd); ; dir = dirname(dir)) {
    if (isRoot(dir)) return { root: dir, argv: rest };
    if (dirname(dir) === dir) return { root: null, argv: rest };
  }
}

// Claude Code の作業記録は ~/.claude/projects/<ルートのパスの記号を - にした名前> に残る
export const transcriptsDirOf = (root, home = homedir()) => join(home, '.claude', 'projects', root.replace(/\/$/, '').replace(/[^a-zA-Z0-9]/g, '-'));

// プロジェクトの設定（saihai.config.json）。なければ空
export function readConfig(root) {
  const path = join(root, 'saihai.config.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

// プロジェクトでの saihai の呼び方。init が設定に書く（J78）。受信箱や委任指示に出すコマンドに使う
export const commandOf = (root) => readConfig(root).command ?? 'saihai';
