import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guard, shouldBlock } from './guard-main.mjs';

test('main にいるときの commit・merge・push は止める（G5.E5）', () => {
  for (const command of ['git commit -m x', 'git add . && git commit -q -F - <<EOF\nmsg\nEOF', 'git merge work/x', 'git push', 'cd /repo && git push origin main']) {
    assert.equal(shouldBlock({ command, branch: 'main' }), true, command);
  }
});

test('作業ブランチでの commit・push は止めない', () => {
  for (const command of ['git commit -m x', 'git push -u origin work/g5', 'git merge main']) {
    assert.equal(shouldBlock({ command, branch: 'work/g5' }), false, command);
  }
});

test('作業ブランチからでも、main への push と、main に切り替えてからの反映は止める', () => {
  for (const command of ['git push origin main', 'git push origin HEAD:main', 'git push origin work/x:main', 'git checkout main && git merge work/x', 'git switch main; git commit -m x']) {
    assert.equal(shouldBlock({ command, branch: 'work/g5' }), true, command);
  }
});

test('git 以外のコマンドや、読むだけの git は止めない', () => {
  for (const command of ['npm test', 'git status', 'git log --oneline -3', 'git diff main', 'echo "git commit"']) {
    assert.equal(shouldBlock({ command, branch: 'main' }), false, command);
  }
});

test('guard: Bash 以外の道具や、壊れた入力では何もしない', () => {
  assert.equal(guard({ stdin: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x' } }), branchOf: () => 'main' }).code, 0);
  assert.equal(guard({ stdin: '{bad', branchOf: () => 'main' }).code, 0);
});

test('guard: 止めるときは終了コード2で、門番を使うよう伝える', () => {
  const r = guard({ stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: '/repo' }), branchOf: () => 'main' });
  assert.equal(r.code, 2);
  assert.match(r.err, /saihai gate/);
});
