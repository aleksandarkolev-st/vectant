import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/gcp-kms-managed-key-signer.mjs");

let activeServer: ReturnType<typeof createServer> | null = null;

afterEach(async () => {
  if (!activeServer) return;
  const server = activeServer;
  activeServer = null;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("gcp-kms-managed-key-signer", () => {
  it("maps the Dojo managed-key protocol to Cloud KMS asymmetricSign", async () => {
    const requests: Array<{ url?: string; authorization?: string; body: unknown }> = [];
    activeServer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        signature: Buffer.from("signed-by-kms").toString("base64"),
      }));
    });
    const baseUrl = await listen(activeServer);
    const keyUri = "projects/vectant-proj/locations/europe-west10/keyRings/synthi-dojo/cryptoKeys/dojo-proof-signing/cryptoKeyVersions/1";
    const result = await runSigner({
      input: JSON.stringify({
        schema_version: "synthi.dojo.managedKeySignerRequest.v1",
        algorithm: "ed25519",
        key_id: "dojo-proof-signing",
        key_uri: keyUri,
        payload: "payload-to-sign",
      }),
      env: {
        ...process.env,
        GOOGLE_OAUTH_ACCESS_TOKEN: "test-token",
        SYNTHI_GCP_KMS_API_BASE_URL: baseUrl,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`/v1/${keyUri}:asymmetricSign`);
    expect(requests[0]?.authorization).toBe("Bearer test-token");
    expect(requests[0]?.body).toEqual({
      data: Buffer.from("payload-to-sign", "utf8").toString("base64"),
    });
    expect(JSON.parse(result.stdout)).toEqual({
      schema_version: "synthi.dojo.managedKeySignerResponse.v1",
      algorithm: "ed25519",
      key_id: "dojo-proof-signing",
      key_uri: keyUri,
      key_custody: "managed",
      signature: `ed25519:${Buffer.from("signed-by-kms").toString("base64url")}`,
    });
  });

  it("rejects non-Ed25519 requests before calling KMS", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      input: JSON.stringify({
        schema_version: "synthi.dojo.managedKeySignerRequest.v1",
        algorithm: "hmac-sha256",
        key_id: "key",
        key_uri: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
        payload: "payload",
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        GOOGLE_OAUTH_ACCESS_TOKEN: "test-token",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dojo_gcp_kms_signer_algorithm_unsupported");
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server_address_unavailable"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function runSigner(input: {
  input: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(input.input);
  });
}
