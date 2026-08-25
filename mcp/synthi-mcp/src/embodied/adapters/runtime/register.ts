/** Runtime adapter registration helper. Registration in substrate.ts is
 *  idempotent for identical bundles, so this is safe to call repeatedly. */
import { registerSubstrateAdapter } from "../../substrate.js";
import { createRuntimeBundle } from "./index.js";

export function registerRuntimeAdapter(): void {
  registerSubstrateAdapter(createRuntimeBundle());
}
