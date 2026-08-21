import { describe, expect, it } from "vitest";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { PROGRAM_TOOLS } from "../../src/tools/programs.js";
import { JUPYTER_TOOLS } from "../../src/tools/jupyter.js";
import {
  TOOL_METADATA_CATALOG,
  createToolMetadataCatalog,
  lookupToolMetadata,
  selectToolMetadata,
} from "../../src/tool_metadata_catalog.js";

describe("Vectant MCP tool metadata catalog", () => {
  it("covers every canonical advertised action exactly once", () => {
    expect(TOOL_METADATA_CATALOG.entries.map((entry) => entry.name)).toEqual(ADVERTISED_TOOLS);

    for (const name of ADVERTISED_TOOLS) {
      expect(TOOL_METADATA_CATALOG.lookup(name)).toEqual(expect.objectContaining({
        name,
        description: expect.any(String),
        origin: "advertised",
      }));
    }
    expect(TOOL_METADATA_CATALOG.entries.every((entry) => entry.description.trim().length > 0)).toBe(true);
  });

  it("classifies atomic routing as orchestration metadata", () => {
    expect(lookupToolMetadata("synthi_route_atomic_task")).toEqual(expect.objectContaining({
      groups: expect.arrayContaining(["agent-routing", "orchestration"]),
    }));
  });

  it("selects CodeSite transaction routing metadata", () => {
    const selected = selectToolMetadata({
      groups: ["codesite"],
      keywords: ["transaction"],
    });

    expect(selected.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "synthi_codesite_open_transaction",
      "synthi_codesite_get_transaction_status",
      "synthi_codesite_validate_transaction",
    ]));
    expect(selected.every((entry) => entry.groups.includes("codesite"))).toBe(true);
  });

  it("selects Agent Dojo proof capabilities", () => {
    const selected = selectToolMetadata({
      groups: ["agent-dojo"],
      keywords: ["proof"],
    });

    expect(selected.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "synthi_dojo_issue_proof_capsule",
      "synthi_dojo_validate_proof_capsule",
      "synthi_dojo_run_with_proof_capsule",
    ]));
    expect(selected.every((entry) => entry.groups.includes("agent-dojo"))).toBe(true);
  });

  it("selects runtime/browser attachment actions", () => {
    const selected = selectToolMetadata({
      groups: ["runtime"],
      keywords: ["attach"],
    });

    expect(selected.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "synthi_attach",
      "synthi_browser_attach",
      "synthi_browser_attach_current_workspace",
    ]));
    expect(lookupToolMetadata("synthi_browser_attach")?.groups).toEqual(expect.arrayContaining([
      "browser",
      "runtime",
      "attachment",
    ]));
  });

  it("classifies the compile-to-frame HMR loop independently from generic runtime tools", () => {
    const selected = selectToolMetadata({ groups: ["hmr"] });
    expect(selected.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "synthi_compile",
      "synthi_wait_hmr",
      "synthi_get_source_state",
      "synthi_report_source_state",
    ]));
    expect(selected.every((entry) => entry.groups.includes("hmr"))).toBe(true);
  });

  it("selects every workspace program command-control tool", () => {
    const programToolNames = PROGRAM_TOOLS.map((tool) => tool.name);
    const selected = selectToolMetadata({ names: programToolNames });

    expect(ADVERTISED_TOOLS).toEqual(expect.arrayContaining(programToolNames));
    expect(selected.map((entry) => entry.name)).toEqual(programToolNames);
    expect(selected.every((entry) => entry.groups.includes("runtime"))).toBe(true);
  });

  it("routes Jupyter notebook actions through the dedicated data skill metadata", () => {
    const jupyterToolNames = JUPYTER_TOOLS.map((tool) => tool.name);
    const selected = selectToolMetadata({ groups: ["jupyter"], keywords: ["notebook"] });

    expect(ADVERTISED_TOOLS).toEqual(expect.arrayContaining(jupyterToolNames));
    expect(selected.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "synthi_jupyter_snapshot_notebook",
      "synthi_jupyter_save_notebook",
    ]));
    expect(selected.every((entry) => entry.groups.includes("jupyter"))).toBe(true);
  });

  it("includes dynamic tools and augments advertised tool routing metadata", () => {
    const catalog = createToolMetadataCatalog({
      advertisedTools: ["synthi_attach"],
      dynamicEntries: [
        {
          name: "synthi_private_invoice_lookup",
          description: "Look up a private customer invoice without exposing its input schema.",
          groups: ["billing", "private-tool"],
          keywords: ["invoice", "accounting"],
        },
        {
          name: "synthi_attach",
          groups: ["hosted-runtime"],
          keywords: ["session"],
        },
      ],
    });

    expect(catalog.lookup("synthi_private_invoice_lookup")).toEqual(expect.objectContaining({
      origin: "dynamic",
      groups: expect.arrayContaining(["billing", "private-tool"]),
      keywords: expect.arrayContaining(["invoice", "accounting"]),
      description: "Look up a private customer invoice without exposing its input schema.",
    }));
    expect(catalog.lookup("synthi_attach")).toEqual(expect.objectContaining({
      origin: "both",
      groups: expect.arrayContaining(["attachment", "hosted-runtime", "runtime"]),
      keywords: expect.arrayContaining(["session"]),
    }));
    expect(catalog.select({ groups: ["billing"] }).map((entry) => entry.name)).toEqual([
      "synthi_private_invoice_lookup",
    ]);
  });
});
