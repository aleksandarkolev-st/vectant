// src/components/healing/index.js
// Barrel export for all self-healing UI components.
export { HealingToast } from './HealingToast';
export { HealingIndicator } from './HealingIndicator';
export { HealingSettingsPanel } from './HealingSettingsPanel';
export { HealingPendingPanel } from './HealingPendingPanel';
export { HealingPresetSelector } from './HealingPresetSelector';
export { default as HealingStatsDashboard } from './HealingStatsDashboard';
export {
  showHealingDecorations,
  injectHealingStyles,
  removeHealingStyles,
} from './healingDecorations';
