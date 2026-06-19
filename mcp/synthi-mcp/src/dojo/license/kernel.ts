import {
  evaluateDojoLicenseKernel,
  markDojoProofExecution,
  type DojoLicenseKernelDecision,
} from "../../browser/dojo_license_kernel.js";

export type { DojoLicenseKernelDecision };
export { evaluateDojoLicenseKernel, markDojoProofExecution };

export interface DojoLicenseKernel {
  evaluate(input: Parameters<typeof evaluateDojoLicenseKernel>[0]): DojoLicenseKernelDecision;
}

export function createDojoLicenseKernel(): DojoLicenseKernel {
  return {
    evaluate: evaluateDojoLicenseKernel,
  };
}
