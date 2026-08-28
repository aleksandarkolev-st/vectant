-- AlterTable
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "githubTokenCipher" TEXT,
ADD COLUMN IF NOT EXISTS "githubLogin" TEXT;