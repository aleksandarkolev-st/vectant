CREATE TABLE "EncryptedSecret" (
    "id" TEXT NOT NULL,
    "cipher" TEXT NOT NULL,
    "last4" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EncryptedSecret_pkey" PRIMARY KEY ("id")
);
