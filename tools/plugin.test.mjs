import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const json = (path) => JSON.parse(readFileSync(join(REPO, path), 'utf8'));
const hookCommands = () =>
  Object.values(json('hooks/hooks.json').hooks)
    .flat()
    .flatMap((m) => m.hooks.map((h) => h.command));

test('リポジトリがプラグインと配布元を兼ねる（G10.E1）', () => {
  assert.equal(json('.claude-plugin/plugin.json').name, 'saihai');
  const market = json('.claude-plugin/marketplace.json');
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['saihai', './']]);
  accessSync(join(REPO, 'bin', 'saihai'), constants.X_OK);
  for (const skill of ['goal-draft', 'interpret', 'inbox']) assert.match(readFileSync(join(REPO, 'skills', skill, 'SKILL.md'), 'utf8'), new RegExp(`name: ${skill}`));
});

test('プラグインのフックを、saihai を使っていないプロジェクトで実際のシェルから動かしても、何もせずエラーも出さない（G10.E2）', () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'saihai-plugin-plain-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x', file_path: join(project, 'a.md') }, cwd: project });
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: REPO, CLAUDE_PROJECT_DIR: project };
  const commands = hookCommands();
  assert.equal(commands.length, 4);
  for (const command of commands) {
    const r = spawnSync('sh', ['-c', command.replaceAll('${CLAUDE_PLUGIN_ROOT}', REPO).replaceAll('${CLAUDE_PROJECT_DIR}', project)], { cwd: project, input: stdin, encoding: 'utf8', env });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], command);
  }
});
