// index.js
import { github } from './github.js';
import { gitlab } from './gitlab.js';
import { generic } from './generic.js';

const REGISTRY = { github, gitlab, generic };
export function getAdapter(providerType) {
  const a = REGISTRY[providerType];
  if (!a) throw Object.assign(new Error(`unknown provider ${providerType}`), { code: 'config_error' });
  return a;
}
