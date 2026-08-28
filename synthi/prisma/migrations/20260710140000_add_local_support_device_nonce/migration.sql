CREATE TABLE "LocalSupportDeviceNonce" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalSupportDeviceNonce_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LocalSupportDeviceNonce_sessionId_nonce_key" ON "LocalSupportDeviceNonce"("sessionId", "nonce");
CREATE INDEX "LocalSupportDeviceNonce_expiresAt_idx" ON "LocalSupportDeviceNonce"("expiresAt");

ALTER TABLE "LocalSupportDeviceNonce" ADD CONSTRAINT "LocalSupportDeviceNonce_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "LocalSupportSession"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE;
