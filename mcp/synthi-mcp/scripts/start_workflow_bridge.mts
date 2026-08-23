/**
 * Starts the real workflow bridge (the one the Vectant Agent panel talks
 * to) with the embodied tools dispatched through it. No token for local
 * live demo. Port 3001.
 */
import { startBrowserWorkflowBridge } from "../src/browser_workflow_bridge/server.js";
// Importing the dispatch module bootstraps terminal + runtime adapters.
import { embodiedBridgeContext } from "../src/browser_workflow_bridge/embodied_dispatch.js";

embodiedBridgeContext();

const bridge = startBrowserWorkflowBridge({ port: 3001, host: "127.0.0.1" });
bridge.ready.then(() => {
  console.log("WORKFLOW BRIDGE LIVE on http://127.0.0.1:3001");
  console.log("Panel endpoints: /browser-workflows/state, /browser-workflows/tool");
});
