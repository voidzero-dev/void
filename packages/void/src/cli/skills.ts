import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { join, relative } from 'pathslash';
import { getPackageDir, type AgentConfig } from './agents.ts';

type SkillInfo = {
  dirName: string;
  name: string;
  description: string;
};

function parseSkills(skillsDir: string): Array<SkillInfo> {
  if (!existsSync(skillsDir)) {
    return [];
  }
  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const skills: Array<SkillInfo> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillMd = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(skillMd)) {
      continue;
    }
    const content = readFileSync(skillMd, 'utf8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) {
      continue;
    }
    const nameMatch = frontmatter[1].match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter[1].match(/^description:\s*(.+)$/m);
    skills.push({
      dirName: entry.name,
      name: nameMatch ? nameMatch[1].trim() : entry.name,
      description: descMatch ? descMatch[1].trim() : '',
    });
  }
  return skills;
}

function linkSkills(
  root: string,
  skillsDir: string,
  skills: Array<SkillInfo>,
  agentSkillsDir: string,
): number {
  const targetDir = join(root, agentSkillsDir);
  mkdirSync(targetDir, { recursive: true });

  let linked = 0;
  for (const skill of skills) {
    const linkPath = join(targetDir, skill.dirName);
    const sourcePath = join(skillsDir, skill.dirName);
    const relativeTarget = relative(targetDir, sourcePath);

    if (existsSync(linkPath)) {
      try {
        const existing = readlinkSync(linkPath);
        if (existing === relativeTarget) {
          continue;
        }
      } catch {
        // not a symlink
      }
      log.warn(
        `${relative(root, linkPath)} exists but is not a link to the ${skill.name} skill, skipping`,
      );
      continue;
    }

    symlinkSync(relativeTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    linked++;
  }
  return linked;
}

/** Link the bundled skills for `agents`. Returns the agents whose skills folder gained a link. */
export function linkSkillsForSpecificAgents(
  root: string,
  agents: Array<AgentConfig>,
): Array<AgentConfig> {
  const packageDir = getPackageDir();
  const skillsDir = join(packageDir, 'skills');
  const skills = parseSkills(skillsDir);
  if (skills.length === 0) {
    return [];
  }

  // Several agents read one folder, such as .agents/skills. Link each folder
  // once: a conflict in it then warns once, and a new link counts for every
  // agent that reads it.
  const folders = [...new Set(agents.map((agent) => agent.skillsDir))];
  const linked = new Set(
    folders.filter((folder) => linkSkills(root, skillsDir, skills, folder) > 0),
  );
  return agents.filter((agent) => linked.has(agent.skillsDir));
}
