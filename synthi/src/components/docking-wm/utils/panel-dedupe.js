import { getPanel } from '../state/panel-registry-core';

export function shouldDeduplicatePanel(panelType) {
  if (panelType === 'extension-view') return true;
  if (panelType === 'program-session') return true;
  return getPanel(panelType)?.allowMultiple !== true;
}

export function matchesPanelInstance(panelType, data, existingTab) {
  if (!existingTab || existingTab.panelType !== panelType) return false;

  if (panelType === 'extension-view') {
    return existingTab.data?.containerId === data?.containerId;
  }

  if (panelType === 'program-session') {
    return existingTab.data?.programSessionId === data?.programSessionId;
  }

  return true;
}