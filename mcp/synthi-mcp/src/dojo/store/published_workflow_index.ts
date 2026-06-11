import type { DojoSkill } from "../../browser/dojo.js";

export interface DojoPublishedWorkflowBinding {
  skill_id: string;
  workflow_id: string;
  tool_names: string[];
}

export function publishedWorkflowBindingForSkill(
  skill: Pick<DojoSkill, "skill_id" | "workflow_id" | "published_tool_name" | "published_tools">
): DojoPublishedWorkflowBinding {
  return {
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    tool_names: publishedToolNamesForSkill(skill),
  };
}

export function publishedToolNamesForSkill(
  skill: Pick<DojoSkill, "published_tool_name" | "published_tools">
): string[] {
  return [...new Set([
    ...(skill.published_tool_name ? [skill.published_tool_name] : []),
    ...(skill.published_tools ?? []),
  ].filter((toolName) => toolName.trim().length > 0))].sort();
}
