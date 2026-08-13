/**
 * Routing must work from this deliberately small metadata shape.  In
 * particular, `SKILL.md` instruction bodies never belong in this module: a
 * router needs to choose a skill, not to receive every skill's prompt.
 */
const METADATA_FIELDS = [
  'id',
  'name',
  'description',
  'categories',
  'keywords',
  'path',
  'toolGroups',
];

const REPOSITORY_SKILL_DEFINITIONS = [
  {
    id: 'brandkit',
    name: 'Brandkit',
    description: 'Creates premium brand identity boards, logo systems, and visual-world presentations.',
    categories: ['design', 'branding', 'image-generation'],
    keywords: ['brand', 'logo', 'identity', 'guidelines', 'mockup', 'visual-system'],
    path: '.claude/skills/brandkit/SKILL.md',
    toolGroups: ['image-generation'],
  },
  {
    id: 'design-taste-frontend',
    name: 'Design Taste Frontend',
    description: 'Guides high-quality frontend implementation, component architecture, and interface polish.',
    categories: ['frontend', 'design', 'ui'],
    keywords: ['ui', 'ux', 'react', 'next.js', 'css', 'accessibility', 'animation'],
    path: '.claude/skills/design-taste-frontend/SKILL.md',
    toolGroups: ['filesystem', 'browser', 'test-runner'],
  },
  {
    id: 'full-output-enforcement',
    name: 'Full Output Enforcement',
    description: 'Ensures complete production-ready output without placeholder implementations.',
    categories: ['implementation', 'quality'],
    keywords: ['complete', 'production', 'code-generation', 'no-placeholders'],
    path: '.claude/skills/full-output-enforcement/SKILL.md',
    toolGroups: ['filesystem', 'test-runner'],
  },
  {
    id: 'gpt-taste',
    name: 'GPT Taste',
    description: 'Guides premium UX/UI and GSAP motion engineering for editorial web experiences.',
    categories: ['frontend', 'design', 'motion'],
    keywords: ['ui', 'ux', 'gsap', 'motion', 'landing-page', 'editorial'],
    path: '.claude/skills/gpt-taste/SKILL.md',
    toolGroups: ['filesystem', 'browser', 'image-generation'],
  },
  {
    id: 'high-end-visual-design',
    name: 'High-end Visual Design',
    description: 'Applies agency-grade typography, spacing, visual hierarchy, and animation standards.',
    categories: ['frontend', 'design', 'ui'],
    keywords: ['ui', 'visual-design', 'typography', 'spacing', 'animation', 'css'],
    path: '.claude/skills/high-end-visual-design/SKILL.md',
    toolGroups: ['filesystem', 'browser'],
  },
  {
    id: 'image-to-code',
    name: 'Image to Code',
    description: 'Generates and analyzes design references before faithfully implementing visually important websites.',
    categories: ['frontend', 'design', 'image-generation'],
    keywords: ['website', 'image-to-code', 'design-reference', 'frontend', 'implementation'],
    path: '.claude/skills/image-to-code/SKILL.md',
    toolGroups: ['image-generation', 'filesystem', 'browser', 'test-runner'],
  },
  {
    id: 'imagegen-frontend-mobile',
    name: 'Image Generation Frontend Mobile',
    description: 'Creates premium mobile app screen concepts and consistent app-native visual flows.',
    categories: ['design', 'mobile', 'image-generation'],
    keywords: ['mobile', 'ios', 'android', 'app', 'screen', 'mockup'],
    path: '.claude/skills/imagegen-frontend-mobile/SKILL.md',
    toolGroups: ['image-generation'],
  },
  {
    id: 'imagegen-frontend-web',
    name: 'Image Generation Frontend Web',
    description: 'Creates section-specific, conversion-aware website design references.',
    categories: ['design', 'frontend', 'image-generation'],
    keywords: ['website', 'landing-page', 'web', 'section', 'design-reference'],
    path: '.claude/skills/imagegen-frontend-web/SKILL.md',
    toolGroups: ['image-generation'],
  },
  {
    id: 'impeccable',
    name: 'Impeccable',
    description: 'Audits and improves frontend interfaces, covering UX, accessibility, responsiveness, and polish.',
    categories: ['frontend', 'design', 'ui'],
    keywords: ['audit', 'redesign', 'ui', 'ux', 'accessibility', 'responsive', 'performance'],
    path: '.claude/skills/impeccable/SKILL.md',
    toolGroups: ['filesystem', 'browser', 'test-runner'],
  },
  {
    id: 'industrial-brutalist-ui',
    name: 'Industrial Brutalist UI',
    description: 'Designs raw mechanical, Swiss-print, terminal-inspired data-heavy interfaces.',
    categories: ['frontend', 'design', 'ui'],
    keywords: ['brutalist', 'dashboard', 'terminal', 'editorial', 'data-heavy'],
    path: '.claude/skills/industrial-brutalist-ui/SKILL.md',
    toolGroups: ['filesystem', 'browser'],
  },
  {
    id: 'minimalist-ui',
    name: 'Minimalist UI',
    description: 'Designs clean editorial interfaces with restrained palettes and flat layouts.',
    categories: ['frontend', 'design', 'ui'],
    keywords: ['minimal', 'editorial', 'monochrome', 'bento', 'css'],
    path: '.claude/skills/minimalist-ui/SKILL.md',
    toolGroups: ['filesystem', 'browser'],
  },
  {
    id: 'redesign-existing-projects',
    name: 'Redesign Existing Projects',
    description: 'Audits and upgrades existing websites and apps while preserving functionality.',
    categories: ['frontend', 'design', 'redesign'],
    keywords: ['redesign', 'audit', 'existing-project', 'ui', 'css', 'accessibility'],
    path: '.claude/skills/redesign-existing-projects/SKILL.md',
    toolGroups: ['filesystem', 'browser', 'test-runner'],
  },
  {
    id: 'stitch-design-taste',
    name: 'Stitch Design Taste',
    description: 'Creates semantic design-system guidance for premium, performant interface work.',
    categories: ['frontend', 'design', 'design-system'],
    keywords: ['design-system', 'stitch', 'tokens', 'typography', 'motion', 'performance'],
    path: '.claude/skills/stitch-design-taste/SKILL.md',
    toolGroups: ['filesystem', 'browser'],
  },
  {
    id: 'synthi-ai-backend',
    name: 'Synthi AI Backend',
    description: 'Guides AI-engine and gateway work: FastAPI, Gemini, WebSockets, analyzer, healing, RAG, and frontend AI contracts.',
    categories: ['backend', 'ai', 'integration'],
    keywords: ['ai-backend', 'fastapi', 'gemini', 'gateway', 'websocket', 'healing', 'rag', 'prompt'],
    path: '.claude/skills/synthi-ai-backend/SKILL.md',
    toolGroups: ['filesystem', 'shell', 'test-runner', 'service-runtime'],
  },
  {
    id: 'synthi-backend',
    name: 'Synthi Backend',
    description: 'Guides backend stack work: HMR, collab-server, signaling, Redis, Y-Sweet, orchestration, and runtime debugging.',
    categories: ['backend', 'infrastructure', 'debugging'],
    keywords: ['backend', 'hmr', 'collab-server', 'redis', 'y-sweet', 'runtime', 'container', 'signaling'],
    path: '.claude/skills/synthi-backend/SKILL.md',
    toolGroups: ['filesystem', 'shell', 'test-runner', 'service-runtime', 'docker'],
  },
  {
    id: 'synthi-frontend',
    name: 'Synthi Frontend',
    description: 'Guides Synthi Next.js web IDE work: Monaco, Yjs collaboration, AI chat, Redux, terminals, auth, Prisma, and API routes.',
    categories: ['frontend', 'integration', 'debugging'],
    keywords: ['synthi', 'next.js', 'monaco', 'yjs', 'webrtc', 'redux', 'terminal', 'nextauth', 'prisma'],
    path: '.claude/skills/synthi-frontend/SKILL.md',
    toolGroups: ['filesystem', 'browser', 'test-runner', 'service-runtime'],
  },
];

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value, field, skillId) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new TypeError(`Skill ${skillId || '<unknown>'} requires a ${field}.`);
  }
  return normalized;
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function freezeSkill(skill) {
  return Object.freeze({
    ...skill,
    categories: Object.freeze([...skill.categories]),
    keywords: Object.freeze([...skill.keywords]),
    toolGroups: Object.freeze([...skill.toolGroups]),
  });
}

/**
 * Retain only routing metadata. Unknown properties, including `instructions`
 * or `content`, are intentionally discarded.
 */
export function toSkillMetadata(input) {
  const id = normalizeId(input?.id);
  if (!id) {
    throw new TypeError('Skill metadata requires an id.');
  }

  const path = normalizeText(input.path, 'path', id).replaceAll('\\', '/');
  if (path.startsWith('/') || path.includes('../')) {
    throw new TypeError(`Skill ${id} path must be a repository-relative path.`);
  }

  return freezeSkill({
    id,
    name: normalizeText(input.name, 'name', id),
    description: normalizeText(input.description, 'description', id),
    categories: normalizeStringList(input.categories),
    keywords: normalizeStringList(input.keywords),
    path,
    toolGroups: normalizeStringList(input.toolGroups),
  });
}

function copySkill(skill) {
  return {
    ...skill,
    categories: [...skill.categories],
    keywords: [...skill.keywords],
    toolGroups: [...skill.toolGroups],
  };
}

function queryTerms(query) {
  return [...new Set(String(query || '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1))];
}

function scoreSkill(skill, terms) {
  if (terms.length === 0) return 0;

  const fields = [
    { value: skill.id, weight: 7 },
    { value: skill.name.toLowerCase(), weight: 6 },
    { value: skill.keywords.join(' '), weight: 5 },
    { value: skill.categories.join(' '), weight: 4 },
    { value: skill.description.toLowerCase(), weight: 1 },
  ];

  return terms.reduce((score, term) => score + fields.reduce((fieldScore, field) => {
    if (field.value === term) return fieldScore + field.weight * 2;
    if (field.value.includes(term)) return fieldScore + field.weight;
    return fieldScore;
  }, 0), 0);
}

function matchesAny(values, filters) {
  return filters.length === 0 || filters.some((filter) => values.includes(filter));
}

/**
 * Small, in-memory registry for cheap routing. It stores metadata only; the
 * corresponding loader is the sole owner of `SKILL.md` body reads.
 */
export class SkillMetadataRegistry {
  #skillsById = new Map();

  constructor(entries = []) {
    this.register(entries);
  }

  register(entries, { replace = false } = {}) {
    const list = Array.isArray(entries) ? entries : [entries];
    for (const entry of list) {
      const metadata = toSkillMetadata(entry);
      if (this.#skillsById.has(metadata.id) && !replace) {
        throw new TypeError(`A skill with id ${metadata.id} is already registered.`);
      }
      this.#skillsById.set(metadata.id, metadata);
    }
    return this;
  }

  lookup(id) {
    const skill = this.#skillsById.get(normalizeId(id));
    return skill ? copySkill(skill) : undefined;
  }

  list() {
    return [...this.#skillsById.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(copySkill);
  }

  search(query, { categories = [], toolGroups = [], limit = 10 } = {}) {
    const terms = queryTerms(query);
    const categoryFilters = normalizeStringList(categories);
    const toolGroupFilters = normalizeStringList(toolGroups);
    const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10;

    return this.list()
      .filter((skill) => matchesAny(skill.categories, categoryFilters))
      .filter((skill) => matchesAny(skill.toolGroups, toolGroupFilters))
      .map((skill) => ({ skill, score: scoreSkill(skill, terms) }))
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
      .slice(0, boundedLimit)
      .map(({ skill }) => skill);
  }
}

export const REPOSITORY_SKILL_METADATA = Object.freeze(
  REPOSITORY_SKILL_DEFINITIONS.map(toSkillMetadata),
);

export function createSkillMetadataRegistry({ entries = [], includeRepositorySkills = true } = {}) {
  const seed = includeRepositorySkills ? REPOSITORY_SKILL_METADATA : [];
  return new SkillMetadataRegistry([...seed, ...(Array.isArray(entries) ? entries : [entries])]);
}

export const repositorySkillRegistry = createSkillMetadataRegistry();

export const SKILL_METADATA_FIELD_NAMES = Object.freeze([...METADATA_FIELDS]);
