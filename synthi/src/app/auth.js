import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import prisma from "@/lib/prisma";
import { decryptToken } from "@/lib/tokenCrypto";

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
      if (account?.provider === "github" && account?.access_token) {
        token.accessToken = account.access_token;
      }
      return token;
    },
    async session({ session, token }) {
      // Propagate the stable user id and avatar into the session
      // object so client-side code (e.g. useSession()) can access
      // session.user.id reliably instead of falling back to email.
      if (token.userId) {
        session.user.id = token.userId;
      }
      if (token.picture) {
        session.user.image = token.picture;
      }

      // Resolve the per-user GitHub token from the encrypted server-side PAT.
      // Preserve GitHub OAuth access token for existing server/client flows.
      session.accessToken = token.accessToken || null;
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
            } catch (err) {
              console.warn("Failed to decrypt GitHub token; clearing stale ciphertext", {
                email: session.user.email,
                error: err?.message,
              });
              session.githubTokenNeedsRelink = true;
              await prisma.user.update({
                where: { email: session.user.email },
                data: { githubTokenCipher: null },
              });
            }
          }
        } catch (err) {
          console.warn("Failed to load GitHub token metadata", {
            email: session.user.email,
            error: err?.message,
          });
        }
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },

  secret: process.env.AUTH_SECRET,
};
