import { parseJson } from './json';

export const LEARNING_SCOPE = Object.freeze({
  project: 'project',
  workspace: 'workspace',
  network: 'learning_network',
});

const PORTABLE_SKILL_FIELDS = Object.freeze([
  'commands',
  'requiredPermissions',
  'requiredTools',
  'usageConditions',
  'actionClass',
]);

function asText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => asText(entry, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function scopeFromRow(row) {
  if (row?.learningScope === LEARNING_SCOPE.workspace || row?.learningScope === LEARNING_SCOPE.network) {
    return row.learningScope;
  }
  const visibility = String(parseJson(row?.scopeJson, {})?.visibility || 'project');
  if (visibility === 'workspace') return LEARNING_SCOPE.workspace;
  if (visibility === 'learning_network') return LEARNING_SCOPE.network;
  return LEARNING_SCOPE.project;
}

export function learningPreferences(controlPlanJson) {
  const controlPlan = parseJson(controlPlanJson, {});
  const configured = controlPlan?.learningNetwork || controlPlan?.learning || {};
  return {
    // A source must explicitly mark a lesson workspace-visible. Once it does,
    // sharing inside that workspace is safe and automatic for active projects.
    workspace: configured.workspace !== false,
    // Cross-workspace sharing needs an affirmative receiver opt-in as well.
    network: configured.network === true,
  };
}

export function isPortableLearningSkill(row, { workspaceSlug, preferences = {} } = {}) {
  const scope = scopeFromRow(row);
  if (scope !== LEARNING_SCOPE.workspace && scope !== LEARNING_SCOPE.network) return false;
  if (row?.kind !== 'shared_skill' || row?.status !== 'published') return false;
  if (row?.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return false;
  if (Number(row?.confidence) < 0.8) return false;
  if (scope === LEARNING_SCOPE.workspace && (!preferences.workspace || row?.project?.workspaceSlug !== workspaceSlug)) return false;
  if (scope === LEARNING_SCOPE.network && !preferences.network) return false;
  return true;
}

export function portableLearningProjection(row) {
  const payload = parseJson(row?.payloadJson, {});
  const scope = parseJson(row?.scopeJson, {});
  const recipe = payload?.recipe && typeof payload.recipe === 'object' ? payload.recipe : {};
  return {
    id: row.id,
    scope: scopeFromRow(row),
    skillKey: asText(payload.skillKey, 128),
    title: asText(row.title, 160),
    summary: asText(row.summary, 4096),
    tags: stringList(payload.tags || scope.tags, 32, 64),
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
    recipe: Object.fromEntries(PORTABLE_SKILL_FIELDS.map((field) => {
      if (field === 'commands' || field === 'requiredPermissions' || field === 'requiredTools' || field === 'usageConditions') {
        return [field, stringList(recipe[field], 32, 1024)];
      }
      return [field, asText(recipe[field], 64) || 'read_only'];
    })),
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
  };
}

export function portableLearningCatalog(rows, options = {}) {
  const seen = new Set();
  return rows
    .filter((row) => isPortableLearningSkill(row, options))
    .sort((left, right) => {
      const confidenceDelta = Number(right.confidence || 0) - Number(left.confidence || 0);
      if (confidenceDelta) return confidenceDelta;
      return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
    })
    .map(portableLearningProjection)
    .filter((item) => item.skillKey && !seen.has(item.skillKey) && seen.add(item.skillKey));
}

export function learningScopeForRecord(item) {
  if (item?.visibility === 'workspace') return LEARNING_SCOPE.workspace;
  if (item?.visibility === 'learning_network') return LEARNING_SCOPE.network;
  return LEARNING_SCOPE.project;
}
