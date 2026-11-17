import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { detectAgents } from '../../src/cli/agents.ts';
import { linkSkillsForSpecificAgents } from '../../src/cli/skills.ts';

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({ log: { warn: vi.fn() } }));

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'void-skills-')));
});

afterEach(() => {
  vi.mocked(log.warn).mockReset();
  rmSync(root, { recursive: true, force: true });
});

function linkedAgents(): Array<string> {
  return linkSkillsForSpecificAgents(root, detectAgents(root)).map((agent) => agent.displayName);
}

it('returns every agent that reads a folder that gained a link', () => {
  // Codex and Cursor both read .agents/skills.
  for (const directory of ['.claude', '.codex', '.cursor']) {
    mkdirSync(join(root, directory));
  }

  expect(linkedAgents()).toEqual(['Claude Code', 'Codex', 'Cursor']);
  expect(existsSync(join(root, '.claude/skills/void/SKILL.md'))).toBe(true);
  expect(existsSync(join(root, '.agents/skills/void/SKILL.md'))).toBe(true);

  // Nothing is left to link.
  expect(linkedAgents()).toEqual([]);
});

it('warns once about a conflict in a folder that several agents read', () => {
  mkdirSync(join(root, '.codex'));
  mkdirSync(join(root, '.cursor'));
  mkdirSync(join(root, '.agents/skills/void'), { recursive: true });

  linkedAgents();

  expect(vi.mocked(log.warn).mock.calls).toEqual([
    ['.agents/skills/void exists but is not a link to the void skill, skipping'],
  ]);
  // The user's folder stays as it was.
  expect(existsSync(join(root, '.agents/skills/void/SKILL.md'))).toBe(false);
});
