/**
 * @fileoverview Panels barrel export.
 */

export {
  IDE_PANEL,
  IDE_PANEL_DEFINITIONS,
  IDE_PANEL_MAP,
  registerAllIDEPanels,
} from './ide-panels';

export {
  LAYOUT_PRESETS,
  getPreset,
  createLayoutFromPreset,
  createClassicLayout,
  createFocusLayout,
  createSideBySideLayout,
  createAIAssistedLayout,
  createThreeColumnLayout,
} from './layout-presets';

export {
  ExplorerPanelWrapper,
  EditorPanelWrapper,
  TerminalPanelWrapper,
  ChatPanelWrapper,
  ProblemsPanelWrapper,
  SearchPanelWrapper,
  GitPanelWrapper,
  ExtensionsPanelWrapper,
  OutputPanelWrapper,
  PreviewPanelWrapper,
  PANEL_WRAPPERS,
} from './panel-wrappers';
