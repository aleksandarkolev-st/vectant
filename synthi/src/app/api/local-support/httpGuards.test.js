import { describe, expect, it } from "vitest";

import { isSameOriginRequest, readBoundedJson } from "./httpGuards";

function mockJsonRequest({
  body = "{}",
  contentType = "application/json",
  contentLength,
} = {}) {
  const headers = new Map();
  if (contentType !== null) headers.set("content-type", contentType);
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return {
    headers: {
      get(name) {
        return headers.get(name.toLowerCase()) || null;
      },
    },
    text: async () => body,
  };
}

function originRequest({ url = "https://beta.vectant.dev/api/local-support/relay", origin, fetchSite } = {}) {
  const headers = new Map();
  if (origin !== undefined) headers.set("origin", origin);
  if (fetchSite !== undefined) headers.set("sec-fetch-site", fetchSite);
  return {
    url,
    headers: {
      get(name) {
        return headers.get(name.toLowerCase()) || null;
      },
    },
  };
}

describe("local support HTTP guards", () => {
  it("accepts bounded JSON object requests", async () => {
    await expect(readBoundedJson(mockJsonRequest({
      body: JSON.stringify({ request_id: "req_123" }),
      contentType: "application/json; charset=utf-8",
    }))).resolves.toMatchObject({
      ok: true,
      value: { request_id: "req_123" },
    });
  });

  it("rejects unsupported content types before reading JSON", async () => {
    await expect(readBoundedJson(mockJsonRequest({
      body: "{}",
      contentType: "text/plain",
    }))).resolves.toMatchObject({
      ok: false,
      status: 415,
      reason: "unsupported_content_type",
    });
  });

  it("rejects ambiguous or invalid content lengths", async () => {
    await expect(readBoundedJson(mockJsonRequest({
      body: "{}",
      contentLength: "2, 2",
    }))).resolves.toMatchObject({
      ok: false,
      status: 400,
      reason: "ambiguous_content_length",
    });

    await expect(readBoundedJson(mockJsonRequest({
      body: "{}",
      contentLength: "NaN",
    }))).resolves.toMatchObject({
      ok: false,
      status: 400,
      reason: "invalid_content_length",
    });
  });

  it("rejects malformed JSON and non-object JSON payloads", async () => {
    await expect(readBoundedJson(mockJsonRequest({ body: "{" }))).resolves.toMatchObject({
      ok: false,
      status: 400,
      reason: "malformed_json",
    });

    await expect(readBoundedJson(mockJsonRequest({ body: "[]" }))).resolves.toMatchObject({
      ok: false,
      status: 400,
      reason: "invalid_json_body",
    });
  });

  it("rejects oversize content-length and decoded body size", async () => {
    await expect(readBoundedJson(mockJsonRequest({
      body: "{}",
      contentLength: String(70 * 1024),
    }))).resolves.toMatchObject({
      ok: false,
      status: 413,
      reason: "body_too_large",
    });

    await expect(readBoundedJson(mockJsonRequest({
      body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    }))).resolves.toMatchObject({
      ok: false,
      status: 413,
      reason: "body_too_large",
    });
  });

  it("allows exact same-origin requests and rejects cross-origin browser contexts", () => {
    expect(isSameOriginRequest(originRequest({
      origin: "https://beta.vectant.dev",
      fetchSite: "same-origin",
    }))).toBe(true);

    expect(isSameOriginRequest(originRequest({
      origin: "https://evil.example",
      fetchSite: "cross-site",
    }))).toBe(false);

    expect(isSameOriginRequest(originRequest({
      origin: "https://evil.example",
      fetchSite: "same-site",
    }))).toBe(false);

    expect(isSameOriginRequest(originRequest({
      origin: "https://beta.vectant.dev",
      fetchSite: "navigate",
    }))).toBe(false);
  });
});
