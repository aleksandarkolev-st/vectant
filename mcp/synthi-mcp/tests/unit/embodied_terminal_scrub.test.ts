import { describe, expect, it } from "vitest";
import { containsSecretShape, scrubSecrets } from "../../src/embodied/adapters/terminal/scrub.js";

describe("terminal secret scrubbing", () => {
  it("redacts env-style credential assignments, preserving the key", () => {
    const { text, hits } = scrubSecrets("deploy started\nAPI_TOKEN=abc123secret\ndone");
    expect(text).toContain("API_TOKEN=");
    expect(text).not.toContain("abc123secret");
    expect(hits.env_assignment).toBe(1);
    expect(containsSecretShape(text)).toBe(false);
  });

  it("redacts cloud provider keys, bearer tokens, and private key blocks", () => {
    const aws = scrubSecrets("using AKIAIOSFODNN7EXAMPLE today");
    expect(aws.text).toContain("<redacted aws_access_key>");
    const gh = scrubSecrets("token ghp_0123456789abcdefghijklmnopqrstuvwxyzABCDEF ok");
    expect(gh.text).toContain("<redacted github_pat>");
    const sk = scrubSecrets("key sk-proj-abcdefghij0123456789 end");
    expect(sk.text).toContain("<redacted openai_key>");
    const pem = scrubSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\nnext");
    expect(pem.text).not.toContain("MIIEow");
  });

  it("redacts credentials embedded in URLs", () => {
    const { text } = scrubSecrets("connect via https://alice:s3cret@db.internal:5432/app");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("alice:");
    expect(containsSecretShape(text)).toBe(false);
  });

  it("leaves ordinary terminal output untouched", () => {
    const plain = "npm warn deprecated left-pad\nTests 42 passed (42)\nexit code 0";
    const { text, hits } = scrubSecrets(plain);
    expect(text).toBe(plain);
    expect(Object.keys(hits)).toHaveLength(0);
    expect(containsSecretShape(text)).toBe(false);
  });
});
