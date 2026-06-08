declare module "*.mjs" {
  export function evaluateGpuHmrAcceptanceContract(input?: unknown): {
    accepted: boolean;
    failedGates?: Array<{ code?: string }>;
    contract?: unknown;
  };
  export function evaluateGpuHmrAcceptanceContractConsistency(input?: unknown): {
    accepted: boolean;
    checked?: boolean;
    failedGates?: Array<{ code?: string }>;
    explicitFields?: unknown;
    derivedFields?: unknown;
  };
}
