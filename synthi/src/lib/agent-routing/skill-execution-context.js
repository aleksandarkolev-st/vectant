const MAX_EXECUTION_SKILLS = 3;

function selectedInstructions(value) {
  return Array.isArray(value?.instructions) ? value.instructions : [];
}

/**
 * Builds the one narrow boundary where selected skill bodies are allowed to
 * enter an execution prompt. Routing receives only the metadata registry.
 */
export function buildSelectedSkillExecutionContext(loadResult, { maxSkills = MAX_EXECUTION_SKILLS } = {}) {
  const limit = Number.isFinite(maxSkills) ? Math.max(0, Math.floor(maxSkills)) : MAX_EXECUTION_SKILLS;
  return selectedInstructions(loadResult)
    .slice(0, limit)
    .map((skill) => ({
      id: String(skill?.id || '').trim(),
      name: String(skill?.name || '').trim(),
      content: String(skill?.content || ''),
    }))
    .filter((skill) => skill.id && skill.content);
}

export function formatSelectedSkillExecutionContext(loadResult) {
  const selected = buildSelectedSkillExecutionContext(loadResult);
  if (selected.length === 0) return '';

  return [
    'Selected execution skills follow. Apply only the relevant guidance to this atomic task.',
    ...selected.map((skill) => `\n[Skill: ${skill.name || skill.id}]\n${skill.content}`),
  ].join('\n');
}
