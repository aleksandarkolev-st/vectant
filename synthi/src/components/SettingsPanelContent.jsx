'use client';

/**
 * @fileoverview SettingsPanelContent — shared settings panel used in both
 * the legacy sidebar (page.jsx) and the docking WM (SettingsPanelWrapper).
 *
 * Contains toggle controls for Auto Save, AI Auto Completion,
 * and a button to open the Theme Picker.
 */

import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import {
  toggleAutoSave,
  selectAutoSaveEnabled,
  toggleAutoCompletion,
  selectAutoCompletionEnabled,
} from '@/redux/uiSlice';
import { useThemePicker } from '@/components/ThemePicker';
import { toast } from 'sonner';
import { selectHealingEnabled } from '@/redux/healingSelectors';
import { toggleHealing } from '@/redux/healingSlice';

export function SettingsPanelContent() {
  const dispatch = useAppDispatch();
  const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);
  const autoCompletionEnabled = useAppSelector(selectAutoCompletionEnabled);
  const healingEnabled = useAppSelector(selectHealingEnabled);
  const { open: openThemePicker } = useThemePicker();

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto p-3 gap-3" style={{ color: 'var(--text-primary)' }}>
      <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        Settings
      </div>

      {/* Auto-save toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm">Auto Save</span>
        <button
          onClick={() => dispatch(toggleAutoSave())}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${autoSaveEnabled ? 'th-toggle-on' : 'th-toggle-off'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              autoSaveEnabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* AI Auto-completion toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm">AI Auto Completion</span>
        <button
          onClick={() => {
            dispatch(toggleAutoCompletion());
            toast(autoCompletionEnabled ? 'AI Auto Completion disabled' : 'AI Auto Completion enabled', {
              duration: 2000,
            });
          }}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${autoCompletionEnabled ? 'th-toggle-on' : 'th-toggle-off'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              autoCompletionEnabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Self-Healing toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm">Self-Healing</span>
        <button
          onClick={() => {
            dispatch(toggleHealing());
            toast(healingEnabled ? 'Self-Healing disabled' : 'Self-Healing enabled', {
              duration: 2000,
            });
          }}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${healingEnabled ? 'th-toggle-on' : 'th-toggle-off'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              healingEnabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <div className="border-t my-1" style={{ borderColor: 'var(--border-subtle)' }} />

      {/* Theme picker */}
      <button
        onClick={openThemePicker}
        className="flex items-center justify-between w-full text-left text-sm px-2 py-2 th-action rounded-lg transition-colors"
      >
        <span>Color Theme</span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Ctrl+K Ctrl+T</span>
      </button>
    </div>
  );
}

export default SettingsPanelContent;
