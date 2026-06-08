declare module "*.mjs" {
  export function evaluateGpuHmrAcceptanceContract(input?: unknown): {
    accepted: boolean;
    failedGates?: Array<{ code?: string }>;
    contract?: unknown;
  };
}
