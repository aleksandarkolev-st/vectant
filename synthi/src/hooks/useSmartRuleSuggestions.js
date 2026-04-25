// src/hooks/useSmartRuleSuggestions.js
// Watches the user's accept/dismiss patterns on suggested healing fixes
// and proposes a rule when a pattern emerges.
//
//   • Accept the same category 3× → "Want to always fix these automatically?"
//   • Dismiss the same category 3× → "Want to stop suggesting these?"
//
// All thresholds + snoozes are in Redux so the state survives re-renders.
// Each proposal is a Sonner toast with explicit Add/Dismiss buttons —
// we never create rules without the user's consent.

import { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from 'sonner';
import {
  selectHealingEnabled,
  selectSuggestionCandidates,
  selectSuggestionsSnoozed,
} from '@/redux/healingSelectors';
import {
  addRule,
  clearSuggestionCandidate,
  snoozeSuggestionFor,
  RuleAction,
} from '@/redux/healingSlice';
import { createRule, ruleToSentence } from '@/lib/healing/ruleEngine';

// How many accepts / dismissals before we propose a rule
const THRESHOLD_ACCEPTS = 3;
const THRESHOLD_DISMISSALS = 3;

// Don't re-propose the same category more than once per hour
const SNOOZE_MS = 60 * 60 * 1000;

// Map a HealingCategory code to a TargetVocabulary name so the proposed
// rule shows up as a readable sentence in the rules panel.
const CATEGORY_TO_TARGET_NAME = {
  missing_semicolon: 'missing_semicolons',
  missing_colon:     'missing_colons',
  missing_bracket:   'missing_brackets',
  unused_import:     'unused_imports',
  missing_import:    'missing_imports',
  duplicate_import:  'missing_imports',
  missing_include:   'missing_imports',
  unused_variable:   'unused_variables',
  type_mismatch:     'type_errors',
  trailing_whitespace: 'style_warnings',
  missing_newline_eof: 'style_warnings',
  trailing_comma:    'style_warnings',
  none_comparison:   'style_warnings',
};

function humanCategory(cat) {
  return (cat || 'issue').replace(/_/g, ' ');
}

export function useSmartRuleSuggestions() {
  const dispatch = useDispatch();
  const enabled = useSelector(selectHealingEnabled);
  const candidates = useSelector(selectSuggestionCandidates);
  const snoozed = useSelector(selectSuggestionsSnoozed);

  // Track which categories we've already proposed in this session so we
  // don't re-fire on every count change while the toast is still on-screen.
  const firedRef = useRef(new Set());

  useEffect(() => {
    if (!enabled) return;

    const now = Date.now();

    const checkAndPropose = (category, action, count) => {
      if (!category) return;
      if (firedRef.current.has(category)) return;
      if (snoozed[category] && now - snoozed[category] < SNOOZE_MS) return;

      firedRef.current.add(category);

      const targetName = CATEGORY_TO_TARGET_NAME[category] || 'any_issue';
      const proposedRule = createRule({
        action,
        targetName,
        scopeName: 'any_file',
      });

      const verb = action === RuleAction.AUTO_APPLY ? 'always fix' : 'never touch';
      const question =
        action === RuleAction.AUTO_APPLY
          ? `You've accepted ${count} ${humanCategory(category)} fixes. Always fix them automatically?`
          : `You've dismissed ${count} ${humanCategory(category)} fixes. Stop suggesting them?`;

      toast.info(question, {
        id: `heal-smart-${category}`,
        duration: 12000,
        icon: '✨',
        description: `Would add rule: ${ruleToSentence(proposedRule)}`,
        action: {
          label: 'Add rule',
          onClick: () => {
            dispatch(addRule(proposedRule));
            dispatch(clearSuggestionCandidate(category));
            toast.success(`Added: ${ruleToSentence(proposedRule)}`, {
              icon: '✓',
              duration: 3000,
            });
          },
        },
        cancel: {
          label: 'Not now',
          onClick: () => {
            dispatch(snoozeSuggestionFor(category));
          },
        },
      });
    };

    for (const [cat, count] of Object.entries(candidates?.accepts || {})) {
      if (count >= THRESHOLD_ACCEPTS) {
        checkAndPropose(cat, RuleAction.AUTO_APPLY, count);
      }
    }
    for (const [cat, count] of Object.entries(candidates?.dismissals || {})) {
      if (count >= THRESHOLD_DISMISSALS) {
        checkAndPropose(cat, RuleAction.IGNORE, count);
      }
    }
  }, [enabled, candidates, snoozed, dispatch]);

  // Reset the per-session fired set if the user resets stats (candidate
  // counts drop to zero).  Lets the proposal fire again after a reset.
  useEffect(() => {
    const acceptEmpty = Object.keys(candidates?.accepts || {}).length === 0;
    const dismissEmpty = Object.keys(candidates?.dismissals || {}).length === 0;
    if (acceptEmpty && dismissEmpty) {
      firedRef.current = new Set();
    }
  }, [candidates]);
}

export default useSmartRuleSuggestions;
