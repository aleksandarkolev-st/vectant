import { describe, expect, it } from "vitest";
import {
  redactDojoEvidenceArtifact,
  verifyDojoRedactionManifest,
} from "../../src/dojo/evidence/redaction.js";

describe("Dojo evidence redaction", () => {
  it("redacts sensitive trace and storage fields while producing a verifiable manifest", () => {
    const result = redactDojoEvidenceArtifact({
      artifact_kind: "trace",
      created_at: "2026-06-11T00:00:00.000Z",
      content: {
        url: "https://app.example.test/invoices",
        headers: {
          Authorization: "Bearer secret-token-value",
          Cookie: "sid=secret; theme=dark",
        },
        localStorage: {
          authToken: "secret-token",
        },
        form: {
          email: "person@example.test",
          file_path: "C:\\Users\\polek\\Downloads\\invoice.pdf",
        },
      },
    });

    const material = JSON.stringify(result.redacted_content);
    expect(material).not.toContain("secret-token-value");
    expect(material).not.toContain("sid=secret");
    expect(material).not.toContain("person@example.test");
    expect(material).not.toContain("polek");
    expect(result.redacted_content).toEqual(expect.objectContaining({
      headers: {
        Authorization: "[REDACTED]",
        Cookie: "[REDACTED]",
      },
      localStorage: "[REDACTED]",
      form: expect.objectContaining({
        email: "[REDACTED_EMAIL]",
        file_path: "C:\\Users\\[REDACTED_USER]\\Downloads\\invoice.pdf",
      }),
    }));
    expect(result.manifest).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.redactionManifest.v1",
      artifact_kind: "trace",
      original_sha256: expect.stringMatching(/^sha256:/),
      redacted_sha256: expect.stringMatching(/^sha256:/),
      manifest_sha256: expect.stringMatching(/^sha256:/),
      redaction_count: expect.any(Number),
      rules_applied: expect.arrayContaining([
        expect.objectContaining({ rule_id: "sensitive_key" }),
        expect.objectContaining({ rule_id: "email_address" }),
        expect.objectContaining({ rule_id: "local_file_path" }),
      ]),
    }));
    expect(verifyDojoRedactionManifest(result)).toEqual({ ok: true, blocked_by: [] });
  });

  it("redacts bearer tokens, JWT-like tokens, emails, and home paths in text artifacts", () => {
    const result = redactDojoEvidenceArtifact({
      artifact_kind: "document_text",
      created_at: "2026-06-11T00:00:00.000Z",
      content: [
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        "JWT aaaaaaaaaaaaaaaa.bbbbbbbb.cccccccc",
        "Callback https://app.example.test/oauth/callback?access_token=secret-access-token&state=kept",
        "Image /pixel.gif?sid=session-secret&size=small",
        "Email finance@example.test",
        "Path /Users/polek/Downloads/report.pdf",
      ].join("\n"),
    });

    expect(result.redacted_content).toContain("Bearer [REDACTED_TOKEN]");
    expect(result.redacted_content).toContain("JWT [REDACTED_TOKEN]");
    expect(result.redacted_content).toContain("access_token=[REDACTED]");
    expect(result.redacted_content).toContain("sid=[REDACTED]");
    expect(result.redacted_content).toContain("state=kept");
    expect(result.redacted_content).not.toContain("secret-access-token");
    expect(result.redacted_content).not.toContain("session-secret");
    expect(result.redacted_content).toContain("[REDACTED_EMAIL]");
    expect(result.redacted_content).toContain("/Users/[REDACTED_USER]/Downloads/report.pdf");
    expect(result.manifest.rules_applied).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_id: "sensitive_url_param", count: 2 }),
    ]));
    expect(result.manifest.redaction_count).toBeGreaterThanOrEqual(6);
  });

  it("detects redacted content or manifest tampering", () => {
    const result = redactDojoEvidenceArtifact({
      artifact_kind: "api_response",
      created_at: "2026-06-11T00:00:00.000Z",
      content: { email: "person@example.test" },
    });

    expect(verifyDojoRedactionManifest({
      redacted_content: { email: "person@example.test" },
      manifest: result.manifest,
    })).toEqual({
      ok: false,
      blocked_by: ["redaction_manifest_redacted_digest_mismatch"],
    });
    expect(verifyDojoRedactionManifest({
      redacted_content: result.redacted_content,
      manifest: { ...result.manifest, redaction_count: 0 },
    })).toEqual({
      ok: false,
      blocked_by: ["redaction_manifest_digest_mismatch"],
    });
  });
});
