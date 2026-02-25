import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";

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
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },

  secret: process.env.AUTH_SECRET,
};
