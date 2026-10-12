#!/usr/bin/env node
// saihai 自身の写しを雛形（templates/）から作り直す（G9.E5・G10）。
// - .claude/skills/：このリポジトリで作業するセッション用（node bin/saihai.mjs で呼ぶ）
// - skills/：プラグイン用（プラグインの bin/ が PATH に入るので saihai で呼ぶ）
// - CLAUDE.md の saihai の節
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELF_COMMAND, SKILLS, TEMPLATES_DIR, mergeClaudeMd, renderTemplate } from './init.mjs';

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url));
export const PLUGIN_COMMAND = 'saihai';

export function renderSelf(repoDir = REPO_DIR) {
  const written = [];
  for (const skill of SKILLS) {
    const template = readFileSync(join(TEMPLATES_DIR, 'skills', skill, 'SKILL.md'), 'utf8');
    for (const [dir, command] of [['.claude/skills', SELF_COMMAND], ['skills', PLUGIN_COMMAND]]) {
      mkdirSync(join(repoDir, dir, skill), { recursive: true });
      writeFileSync(join(repoDir, dir, skill, 'SKILL.md'), renderTemplate(template, command));
      written.push(`${dir}/${skill}/SKILL.md`);
    }
  }
  const mdPath = join(repoDir, 'CLAUDE.md');
  writeFileSync(mdPath, mergeClaudeMd(readFileSync(mdPath, 'utf8'), renderTemplate(readFileSync(join(TEMPLATES_DIR, 'CLAUDE.md'), 'utf8'), SELF_COMMAND)));
  written.push('CLAUDE.md');
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`雛形から作り直しました：${renderSelf().join('、')}\n`);
}
