/**
 * @fileoverview Built-in theme barrel — imports all shipped themes.
 */
import synthiDark from './builtin/synthi-dark.json';
import synthiClassic from './builtin/synthi-classic.json';
import synthiLight from './builtin/synthi-light.json';
import midnight from './builtin/midnight.json';
import highContrastDark from './builtin/high-contrast-dark.json';
import highContrastLight from './builtin/high-contrast-light.json';
import solarizedDark from './builtin/solarized-dark.json';
import solarizedLight from './builtin/solarized-light.json';

/**
 * All built-in themes keyed by ID.
 * @type {Record<string, import('./theme-schema').Theme>}
 */
export const BUILTIN_THEMES = {
  [synthiDark.id]:          synthiDark,
  [synthiClassic.id]:       synthiClassic,
  [synthiLight.id]:         synthiLight,
  [midnight.id]:            midnight,
  [highContrastDark.id]:    highContrastDark,
  [highContrastLight.id]:   highContrastLight,
  [solarizedDark.id]:       solarizedDark,
  [solarizedLight.id]:      solarizedLight,
};

/**
 * Ordered list for the theme picker — dark themes first, then light,
 * then high-contrast, then community classics.
 */
export const BUILTIN_THEME_LIST = [
  synthiDark,
  synthiClassic,
  midnight,
  solarizedDark,
  synthiLight,
  solarizedLight,
  highContrastDark,
  highContrastLight,
];
