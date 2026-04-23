import { describe, expect, it } from "vitest";
import { classifySignalingUrl } from "../../src/security/signaling_url.js";

describe("classifySignalingUrl", () => {
  it("localhost variants are local", () => {
    expect(classifySignalingUrl("ws://localhost:9000").local).toBe(true);
    expect(classifySignalingUrl("ws://Localhost:9000").local).toBe(true);
    expect(classifySignalingUrl("ws://127.0.0.1:9000").local).toBe(true);
    expect(classifySignalingUrl("ws://127.10.20.30:9000").local).toBe(true);
    expect(classifySignalingUrl("ws://[::1]:9000").local).toBe(true);
  });

  it("RFC1918 private ranges are local", () => {
    expect(classifySignalingUrl("ws://10.0.0.5:9000").local).toBe(true);
    expect(classifySignalingUrl("ws://172.16.0.1:9000").local).toBe(true);
    expect(classifySignalingUrl("ws://172.31.255.255:9000").local).toBe(true);
    expect(classifySignalingUrl("ws://192.168.1.1:9000").local).toBe(true);
  });

  it("link-local is local", () => {
    expect(classifySignalingUrl("ws://169.254.1.2:9000").local).toBe(true);
  });

  it("public IP is non-local", () => {
    const c = classifySignalingUrl("ws://8.8.8.8:9000");
    expect(c.local).toBe(false);
    expect(c.reason).toBe("non_local_hostname");
  });

  it("public hostnames are non-local (no DNS resolution attempted)", () => {
    const c = classifySignalingUrl("wss://signaling.example.com");
    expect(c.local).toBe(false);
  });

  it("malformed URLs are non-local", () => {
    const c = classifySignalingUrl("not a url");
    expect(c.local).toBe(false);
    expect(c.reason).toBe("malformed_url");
  });

  it("172.15 and 172.32 are NOT in the 172.16/12 private range", () => {
    expect(classifySignalingUrl("ws://172.15.0.1:9000").local).toBe(false);
    expect(classifySignalingUrl("ws://172.32.0.1:9000").local).toBe(false);
  });
});
