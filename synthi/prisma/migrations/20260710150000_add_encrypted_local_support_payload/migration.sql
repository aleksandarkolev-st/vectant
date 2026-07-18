-- Approved Local Support payloads are encrypted before insertion and are
-- deleted on first retrieval or short expiry. Audit tables remain body-free.
CREATE TABLE "LocalSupportRelayPayload" (
    "requestId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "byteCount" INTEGER NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "redactionCount" INTEGER NOT NULL DEFAULT 0,
    "scannerVersion" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalSupportRelayPayload_pkey" PRIMARY KEY ("requestId")
);

CREATE INDEX "LocalSupportRelayPayload_expiresAt_idx" ON "LocalSupportRelayPayload"("expiresAt");

ALTER TABLE "LocalSupportRelayPayload" ADD CONSTRAINT "LocalSupportRelayPayload_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "LocalSupportRelayRequest"("requestId") ON DELETE CASCADE ON UPDATE CASCADE;
