import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "VECTANT-RELAY-PAYLOAD-V1";

export function encryptRelayPayload(plaintext, context, env = process.env) {
  const key = readKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptRelayPayload(blob, context, env = process.env) {
  const [version, iv, tag, ciphertext] = String(blob).split(":");
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Malformed relay payload.");
  const decipher = createDecipheriv("aes-256-gcm", readKey(env), Buffer.from(iv, "base64"));
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function relayPayloadSha256(content) {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function readKey(env) {
  const encoded = env.VECTANT_LOCAL_SUPPORT_RELAY_PAYLOAD_KEY || "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("VECTANT_LOCAL_SUPPORT_RELAY_PAYLOAD_KEY must be a canonical 32-byte base64 key.");
  }
  return key;
}

function aad(context) {
  return Buffer.from([
    VERSION,
    context.requestId,
    context.sessionId,
    context.workspaceId,
    context.deviceFingerprint,
  ].join("\0"), "utf8");
}
