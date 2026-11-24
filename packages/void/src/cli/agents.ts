import { existsSync, readFileSync } from 'node:fs';
import { join, toSlash } from 'pathslash';

export function getPackageDir(): string {
  let dir = toSlash(import.meta.dirname);
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'void') {
        return dir;
      }
    }
    dir = join(dir, '..');
  }
  throw new Error('Could not find void package root');
}

export function getOwnVersion(): string {
  return JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf8')).version;
}

// Agent configs: project-local skillsDir and how to detect presence in the project root.
// Skill directory locations are aligned with:
// https://github.com/vercel-labs/skills/blob/main/README.md
export type AgentConfig = {
  displayName: string;
  skillsDir: string;
  detect: (root: string) => boolean;
};

const agents: Record<string, AgentConfig> = {
  'claude-code': {
    displayName: 'Claude Code',
    skillsDir: '.claude/skills',
    detect: (root) => existsSync(join(root, '.claude')) || existsSync(join(root, 'CLAUDE.md')),
  },
  amp: {
    displayName: 'Amp',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.agents')),
  },
  codex: {
    displayName: 'Codex',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.codex')),
  },
  cursor: {
    displayName: 'Cursor',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.cursor')),
  },
  windsurf: {
    displayName: 'Windsurf',
    skillsDir: '.windsurf/skills',
    detect: (root) => existsSync(join(root, '.windsurf')),
  },
  'gemini-cli': {
    displayName: 'Gemini CLI',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.gemini')),
  },
  'github-copilot': {
    displayName: 'GitHub Copilot',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.github', 'copilot-instructions.md')),
  },
  cline: {
    displayName: 'Cline',
    skillsDir: '.cline/skills',
    detect: (root) => existsSync(join(root, '.cline')),
  },
  roo: {
    displayName: 'Roo Code',
    skillsDir: '.roo/skills',
    detect: (root) => existsSync(join(root, '.roo')),
  },
  kilo: {
    displayName: 'Kilo Code',
    skillsDir: '.kilocode/skills',
    detect: (root) => existsSync(join(root, '.kilocode')),
  },
  continue: {
    displayName: 'Continue',
    skillsDir: '.continue/skills',
    detect: (root) => existsSync(join(root, '.continue')),
  },
  goose: {
    displayName: 'Goose',
    skillsDir: '.goose/skills',
    detect: (root) => existsSync(join(root, '.goose')),
  },
  opencode: {
    displayName: 'OpenCode',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.opencode')),
  },
  trae: {
    displayName: 'Trae',
    skillsDir: '.trae/skills',
    detect: (root) => existsSync(join(root, '.trae')),
  },
  junie: {
    displayName: 'Junie',
    skillsDir: '.junie/skills',
    detect: (root) => existsSync(join(root, '.junie')),
  },
  'kiro-cli': {
    displayName: 'Kiro CLI',
    skillsDir: '.kiro/skills',
    detect: (root) => existsSync(join(root, '.kiro')),
  },
  zencoder: {
    displayName: 'Zencoder',
    skillsDir: '.zencoder/skills',
    detect: (root) => existsSync(join(root, '.zencoder')),
  },
  'qwen-code': {
    displayName: 'Qwen Code',
    skillsDir: '.qwen/skills',
    detect: (root) => existsSync(join(root, '.qwen')),
  },
};

export function detectAgents(root: string): Array<AgentConfig> {
  return Object.values(agents).filter((a) => a.detect(root));
}
