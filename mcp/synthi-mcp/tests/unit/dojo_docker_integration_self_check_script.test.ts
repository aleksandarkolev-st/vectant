// @ts-nocheck
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDojoDockerIntegrationEvidenceManifest,
  DOJO_DOCKER_REQUIRED_SERVICES,
  evaluateDockerServices,
  parseDockerComposePsJson,
} from "../../scripts/dojo-docker-integration-self-check.mjs";

describe("Dojo Docker integration self-check script", () => {
  it("parses docker compose ps JSON output in array and line-delimited forms", () => {
    const row = { Service: "frontend", State: "running", Health: "", Status: "running" };
    expect(parseDockerComposePsJson(JSON.stringify([row]))).toEqual([row]);
    expect(parseDockerComposePsJson(`${JSON.stringify(row)}\n${JSON.stringify({ ...row, Service: "mcp" })}\n`)).toEqual([
      row,
      { ...row, Service: "mcp" },
    ]);
  });

  it("evaluates required services, running state, and required health checks", () => {
    const healthyRows = DOJO_DOCKER_REQUIRED_SERVICES.map((service) => ({
      Service: service,
      State: "running",
      Health: ["postgres", "redis", "y-sweet"].includes(service) ? "healthy" : "",
      Status: "running",
    }));
    expect(evaluateDockerServices({
      serviceRows: healthyRows,
      configuredServices: DOJO_DOCKER_REQUIRED_SERVICES,
    })).toEqual(expect.objectContaining({
      ok: true,
      missing_services: [],
      stopped_services: [],
      unhealthy_services: [],
    }));

    const brokenRows = healthyRows
      .filter((row) => row.Service !== "mcp")
      .map((row) => row.Service === "worker" ? { ...row, State: "exited" } : row)
      .map((row) => row.Service === "postgres" ? { ...row, Health: "unhealthy" } : row);
    const broken = evaluateDockerServices({
      serviceRows: brokenRows,
      configuredServices: DOJO_DOCKER_REQUIRED_SERVICES,
    });
    expect(broken.ok).toBe(false);
    expect(broken.missing_services).toEqual(["mcp"]);
    expect(broken.stopped_services).toEqual(["worker"]);
    expect(broken.unhealthy_services).toEqual(["postgres"]);
  });

  it("builds digest-backed evidence and fails budget when endpoint checks fail", () => {
    const reportText = JSON.stringify({ ok: true });
    const stdout = "compose up ok\n";
    const stderr = "";
    const serviceEvaluation = {
      ok: true,
      configured_services: DOJO_DOCKER_REQUIRED_SERVICES,
      required_services: DOJO_DOCKER_REQUIRED_SERVICES,
      running_services: DOJO_DOCKER_REQUIRED_SERVICES,
      missing_services: [],
      stopped_services: [],
      unhealthy_services: [],
      service_states: [],
    };
    const evidence = buildDojoDockerIntegrationEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      durationMs: 100,
      timeoutMs: 1000,
      endpointTimeoutMs: 100,
      commandEvaluation: {
        compose_up_ran: true,
        compose_up_exit_code: 0,
        compose_ps_exit_code: 0,
        compose_config_exit_code: 0,
      },
      serviceEvaluation,
      endpointChecks: [
        { id: "frontend_workspace", url: "http://127.0.0.1:3000/workspace", expected_status: 200, status: 200, ok: true, duration_ms: 5, error: null },
        { id: "collab_ports", url: "http://127.0.0.1:1234/ports", expected_status: 200, status: 503, ok: false, duration_ms: 5, error: null },
      ],
      reportPath: "tmp/report.json",
      reportText,
      stdoutPath: "tmp/stdout.log",
      stderrPath: "tmp/stderr.log",
      stdout,
      stderr,
      skipUp: false,
    });
    expect(evidence.ok).toBe(false);
    expect(evidence.budget_evaluation.failed_checks).toEqual(["required_endpoints_ok"]);
    expect(evidence.json_report_sha256).toBe(sha256(reportText));
    expect(evidence.stdout_sha256).toBe(sha256(stdout));
    expect(evidence.stderr_sha256).toBe(sha256(stderr));
  });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
