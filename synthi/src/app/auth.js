import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import { PrismaClient } from "@prisma/client";
import { decryptToken } from "@/lib/tokenCrypto";

const prisma = new PrismaClient();

export const authOptions = {
  session: {
    strategy: "jwt",
  },

  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    GitHubProvider({
      clientId: process.env.GITHUB_ID,
      clientSecret: process.env.GITHUB_SECRET,
      issuer: process.env.GITHUB_ISSUER ?? "https://github.com",
      authorization: {
        params: {
          scope: "read:user user:email repo",
        },
      },
    }),
  ],

  callbacks: {
    async jwt({ token, account, user }) {
      if (account) {
        token.accessToken = account.access_token;
      }
      // Persist the provider-assigned user id into the JWT so it's
      // available in the session callback below.  `user` is only
      // present on the initial sign-in; on subsequent requests we
      // rely on the previously stored `token.userId`.
      if (user?.id) {
        token.userId = user.id;
      }
      if (user?.image) {
        token.picture = user.image;
      }
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      // Propagate the stable user id and avatar into the session
      // object so client-side code (e.g. useSession()) can access
      // session.user.id reliably instead of falling back to email.
      if (token.userId) {
        session.user.id = token.userId;
      }
      if (token.picture) {
        session.user.image = token.picture;
      }

      // Resolve the per-user GitHub token: a saved PAT wins; otherwise fall
      // back to the GitHub OAuth access token (only present for users who
      // signed in via the GitHub provider). Lookup by email since that's the
      // canonical user identifier used elsewhere in the app.
      session.githubToken = null;
      session.githubTokenSource = null;
      session.githubLogin = null;
      if (session.user?.email) {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { githubTokenCipher: true, githubLogin: true },
          });
          if (dbUser?.githubTokenCipher) {
            try {
              session.githubToken = decryptToken(dbUser.githubTokenCipher);
              session.githubTokenSource = "pat";
              session.githubLogin = dbUser.githubLogin || null;
            } catch (_) {
              // Stale ciphertext (e.g. AUTH_SECRET rotated) — treat as no PAT
            }
          }
        } catch (_) {
          // DB unavailable — fall through to OAuth token
        }
      }
      if (!session.githubToken && session.accessToken) {
        session.githubToken = session.accessToken;
        session.githubTokenSource = "oauth";
      }

      return session;
    },
  },
  pages: {
    signIn: "/login",
  },

  secret: process.env.AUTH_SECRET,
};
