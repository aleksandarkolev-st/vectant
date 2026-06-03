import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectBrowserProject,
  projectRunStatus,
  runBrowserProject,
  stopBrowserProject,
  tempProjectRootForTests,
} from "../../src/browser/project_runner.js";
import { browserBroker } from "../../src/browser/broker.js";
import { eventLog } from "../../src/events/index.js";
import { dispatchBrowserTool } from "../../src/tools/browser.js";

const activeRunIds: string[] = [];

beforeEach(() => {
  browserBroker.resetForTests();
  eventLog._resetForTests();
  activeRunIds.length = 0;
});

afterEach(async () => {
  for (const id of activeRunIds.splice(0)) {
    await stopBrowserProject(id);
  }
});

describe("browser project detection", () => {
  it("detects JS web dev command candidates and package manager", async () => {
    const root = await tempProjectRootForTests();
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: {
        dev: "vite --host 127.0.0.1",
        test: "vitest run",
        preview: "vite preview",
      },
      devDependencies: {
        vite: "^6.0.0",
      },
    }));

    const detection = await detectBrowserProject(root);

    expect(detection.package_manager).toBe("pnpm");
    expect(detection.candidates[0]).toEqual(expect.objectContaining({
      command: "pnpm dev",
      script: "dev",
    }));
    expect(detection.candidates.some((candidate) => candidate.command === "pnpm preview")).toBe(true);
  });

  it("returns notes when package.json is missing", async () => {
    const root = await tempProjectRootForTests();
    await mkdir(join(root, "src"));
    const detection = await detectBrowserProject(root);
    expect(detection.candidates).toEqual([]);
    expect(detection.notes).toContain("package_json_not_found");
  });
});

describe("browser project run lifecycle", () => {
  it("starts, reports, and stops an agent-chosen command", async () => {
    const root = await tempProjectRootForTests();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
    const run = await runBrowserProject(root, "node -e \"setInterval(() => {}, 1000)\"");
    activeRunIds.push(run.run_id);

    expect(run.pid).toBeGreaterThan(0);
    expect(projectRunStatus(run.run_id)[0]?.command).toContain("setInterval");

    const stopped = await stopBrowserProject(run.run_id);
    activeRunIds.length = 0;

    expect(stopped).toEqual({ stopped: true, run_id: run.run_id });
    expect(projectRunStatus(run.run_id)).toEqual([]);
    expect(eventLog.query({ kind: "browser" }).some((event) => event.action === "project_stopped")).toBe(true);
  });

  it("exposes project tools through browser dispatch", async () => {
    const root = await tempProjectRootForTests();
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { dev: "next dev" },
      dependencies: { next: "^15.0.0" },
    }));

    const response = await dispatchBrowserTool("synthi_browser_detect_project", { root });
    expect(response?.isError).toBeUndefined();
    const detection = (response?.structuredContent as { detection: { candidates: Array<{ command: string }> } }).detection;
    expect(detection.candidates[0]?.command).toBe("npm run dev");
  });
});
