-- Add encrypted GitHub PAT storage used by auth/session token hydration.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "githubTokenCipher" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "githubLogin" TEXT;
