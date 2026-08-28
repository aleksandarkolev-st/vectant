import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repositorySkillRegistry } from './skill-metadata-registry.js';

const DEFAULT_MAX_SKILLS = 3;
const DEFAULT_MAX_CHARS_PER_SKILL = 12_000;
const DEFAULT_MAX_TOTAL_CHARS = 24_000;
// Next and Vitest can transform import.meta.url to a non-file URL. Synthi
// commands run either from `synthi/` or the repository root; callers running
// elsewhere can provide an explicit repositoryRoot.
const currentWorkingDirectory = process.cwd();
const DEFAULT_REPOSITORY_ROOT = process.env.VECTANT_REPOSITORY_ROOT
  || (path.basename(currentWorkingDirectory).toLowerCase() === 'synthi'
    ? path.resolve(currentWorkingDirectory, '..')
    : currentWorkingDirectory);

function boundedPositiveInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function selectedIds(selected) {
  const values = Array.isArray(selected) ? selected : [selected];
  return [...new Set(values
    .map((value) => typeof value === 'string' ? value : value?.id)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
}

function resolveSkillPath(repositoryRoot, relativePath) {
  const root = path.resolve(repositoryRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new TypeError(`Skill path ${relativePath} is outside the repository root.`);
  }
  return resolved;
}

/**
 * Reads instruction bodies only after the router has picked a small explicit
 * subset. `readText` is injectable so callers can use a repository service
 * rather than local disk when appropriate.
 */
export async function loadSelectedSkillInstructions(selected, {
  registry = repositorySkillRegistry,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  readText = (filePath) => readFile(filePath, 'utf8'),
  maxSkills = DEFAULT_MAX_SKILLS,
  maxCharsPerSkill = DEFAULT_MAX_CHARS_PER_SKILL,
  maxTotalChars = DEFAULT_MAX_TOTAL_CHARS,
} = {}) {
  const ids = selectedIds(selected);
  const skillLimit = boundedPositiveInteger(maxSkills, DEFAULT_MAX_SKILLS);
  const perSkillLimit = boundedPositiveInteger(maxCharsPerSkill, DEFAULT_MAX_CHARS_PER_SKILL);
  const totalLimit = boundedPositiveInteger(maxTotalChars, DEFAULT_MAX_TOTAL_CHARS);
  const instructions = [];
  const unknownSkillIds = [];
  const unavailableSkillIds = [];
  const omittedSkillIds = [];
  let usedChars = 0;

  for (const id of ids) {
    const skill = registry.lookup(id);
    if (!skill) {
      unknownSkillIds.push(id);
      continue;
    }
    if (instructions.length >= skillLimit || usedChars >= totalLimit) {
      omittedSkillIds.push(id);
      continue;
    }

    let body;
    try {
      body = await readText(resolveSkillPath(repositoryRoot, skill.path));
    } catch {
      unavailableSkillIds.push(id);
      continue;
    }

    const availableChars = Math.min(perSkillLimit, totalLimit - usedChars);
    const content = String(body).slice(0, availableChars);
    instructions.push({
      id: skill.id,
      name: skill.name,
      path: skill.path,
      content,
      truncated: String(body).length > content.length,
    });
    usedChars += content.length;
  }

  return {
    instructions,
    unknownSkillIds,
    unavailableSkillIds,
    omittedSkillIds,
  };
}

export const SELECTIVE_SKILL_LOADING_DEFAULTS = Object.freeze({
  maxSkills: DEFAULT_MAX_SKILLS,
  maxCharsPerSkill: DEFAULT_MAX_CHARS_PER_SKILL,
  maxTotalChars: DEFAULT_MAX_TOTAL_CHARS,
});
