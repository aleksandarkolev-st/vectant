export interface DojoPromptInjectionDocumentMutationBehavior {
  prompt_injection_present: true;
  instruction_quarantined: boolean;
}

const PROMPT_INJECTION_DOCUMENT_MUTATIONS: Record<string, DojoPromptInjectionDocumentMutationBehavior> = {
  prompt_injection: {
    prompt_injection_present: true,
    instruction_quarantined: true,
  },
  prompt_injection_unquarantined: {
    prompt_injection_present: true,
    instruction_quarantined: false,
  },
};

export function promptInjectionDocumentMutationBehaviorFor(
  mutationKind: string
): DojoPromptInjectionDocumentMutationBehavior | null {
  return PROMPT_INJECTION_DOCUMENT_MUTATIONS[mutationKind] ?? null;
}

export function isPromptInjectionDocumentMutation(mutationKind: string): boolean {
  return promptInjectionDocumentMutationBehaviorFor(mutationKind) !== null;
}
