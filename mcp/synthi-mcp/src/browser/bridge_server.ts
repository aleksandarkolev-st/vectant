import http from "node:http";
import { randomUUID } from "node:crypto";
import { browserBroker, type BrowserBridgeMessage } from "./broker.js";
import { normalizeOrigin, sameExactOrigin } from "./security.js";

export interface BrowserBridgeStartOptions {
  token?: string;
  host?: string;
  port?: number;
  publicUrl?: string;
}

export class BrowserBridgeServer {
  private server: http.Server | null = null;
  private token: string | null = null;
  private url: string | null = null;

  async start(options: BrowserBridgeStartOptions = {}): Promise<{ url: string; token: string }> {
    if (this.server && this.url && this.token) {
      return { url: this.url, token: this.token };
    }
    const host = options.host ?? process.env["SYNTHI_BROWSER_BRIDGE_HOST"] ?? "127.0.0.1";
    const port = options.port ?? parsePort(process.env["SYNTHI_BROWSER_BRIDGE_PORT"]) ?? 0;
    this.token = options.token ?? process.env["SYNTHI_BROWSER_BRIDGE_TOKEN"] ?? `bridge_${randomUUID()}`;
    browserBroker.setBridgeToken(this.token);
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
    const address = this.server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    this.url = normalizePublicUrl(options.publicUrl ?? process.env["SYNTHI_BROWSER_BRIDGE_PUBLIC_URL"]) ?? `http://${host}:${actualPort}`;
    return { url: this.url, token: this.token };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.url = null;
    this.token = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  current(): { url: string; token: string } | null {
    if (!this.url || !this.token) return null;
    return { url: this.url, token: this.token };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (this.rejectPageOriginRequest(req, res)) return;
      if (req.method === "OPTIONS") {
        this.writeJson(res, 204, {});
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        this.writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method !== "POST" || req.url !== "/event") {
        this.writeJson(res, 404, { ok: false, error: "not_found" });
        return;
      }
      const body = await readBody(req, 1_000_000);
      const message = JSON.parse(body) as BrowserBridgeMessage;
      const validation = browserBroker.validateBridgeMessage(message);
      if (!validation.ok) {
        this.writeJson(res, validation.error === "bad_bridge_token" ? 401 : 403, { ok: false, error: validation.error });
        return;
      }
      const handled = this.dispatch(message);
      this.writeJson(res, handled.ok ? 200 : 400, handled);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.writeJson(res, 500, { ok: false, error: "bridge_failed", message });
    }
  }

  private rejectPageOriginRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const origin = req.headers.origin;
    if (typeof origin === "string" && (origin.startsWith("http://") || origin.startsWith("https://"))) {
      this.writeJson(res, 403, { ok: false, error: "page_origin_request_rejected" });
      return true;
    }
    return false;
  }

  private dispatch(message: BrowserBridgeMessage): { ok: true } | { ok: false; error: string } {
    const type = typeof message.type === "string" ? message.type : "";
    const payload = (message.payload ?? {}) as Record<string, unknown>;
    const pageOrigin = typeof message.page_origin === "string" ? message.page_origin : "";
    switch (type) {
      case "selection": {
        const enriched = this.withSelectedTab(payload, pageOrigin);
        if (!enriched.ok) return enriched;
        const result = browserBroker.recordSelection(enriched.payload as never);
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      }
      case "human_action": {
        const enriched = this.withSelectedTab(payload, pageOrigin);
        if (!enriched.ok) return enriched;
        const result = browserBroker.recordHumanAction(enriched.payload as never);
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      }
      case "origin_change": {
        const tabId = typeof payload["tab_id"] === "string" ? payload["tab_id"] : browserBroker.selectedTab()?.tab_id ?? "";
        const url = typeof payload["url"] === "string" ? payload["url"] : "";
        if (!tabId || !url) return { ok: false, error: "invalid_origin_change_payload" };
        browserBroker.handleOriginChange(tabId, url);
        return { ok: true };
      }
      default:
        return { ok: false, error: "unknown_bridge_event" };
    }
  }

  private withSelectedTab(payload: Record<string, unknown>, pageOrigin: string): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
    const selected = browserBroker.selectedTab();
    const tabId = typeof payload["tab_id"] === "string" ? payload["tab_id"] : selected?.tab_id;
    if (!tabId) return { ok: false, error: "tab_not_authorized" };
    const url = typeof payload["url"] === "string" ? payload["url"] : selected?.url;
    if (!url) return { ok: false, error: "missing_event_url" };
    let normalizedUrlOrigin: string;
    let normalizedPageOrigin: string;
    try {
      normalizedUrlOrigin = normalizeOrigin(url).origin;
      normalizedPageOrigin = normalizeOrigin(pageOrigin).origin;
    } catch {
      return { ok: false, error: "invalid_event_origin" };
    }
    if (!sameExactOrigin(normalizedUrlOrigin, normalizedPageOrigin)) return { ok: false, error: "page_origin_payload_mismatch" };
    let payloadOrigin = normalizedUrlOrigin;
    try {
      payloadOrigin = typeof payload["origin"] === "string" ? normalizeOrigin(payload["origin"]).origin : normalizedUrlOrigin;
    } catch {
      return { ok: false, error: "invalid_event_origin" };
    }
    if (payloadOrigin !== normalizedUrlOrigin) return { ok: false, error: "selection_origin_mismatch" };
    return {
      ok: true,
      payload: {
        ...payload,
        tab_id: tabId,
        url,
        origin: normalizedUrlOrigin,
      },
    };
  }

  private writeJson(res: http.ServerResponse, status: number, payload: Record<string, unknown>): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "chrome-extension://*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end(status === 204 ? "" : JSON.stringify(payload));
  }
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error("request_too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const browserBridgeServer = new BrowserBridgeServer();

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error("invalid_bridge_port");
  return parsed;
}

function normalizePublicUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid_bridge_public_url");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
