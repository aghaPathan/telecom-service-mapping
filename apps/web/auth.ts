import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import PostgresAdapter from "@auth/pg-adapter";
import authConfig from "@/auth.config";
import { getPool } from "@/lib/postgres";
import { issueDbSessionCookie } from "@/lib/session-cookie";
import { recordAudit } from "@/lib/audit";
import { authenticateCredentials } from "@/lib/authenticate";
import type { Role } from "@/lib/rbac";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      role: Role;
    };
  }
}

// NOTE: session.strategy is "database" — Auth.js v5's Credentials provider
// doesn't natively mint a DB session, so `authorize()` manually inserts a
// `sessions` row and sets the cookie via `issueDbSessionCookie`. Do NOT switch
// to "jwt" — admins must be able to revoke sessions by DELETE FROM sessions
// (issue #7 acceptance criterion).
export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PostgresAdapter(getPool()),
  session: { strategy: "database", maxAge: 60 * 60 * 24 * 30 },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const rawEmail = (raw as { email?: unknown })?.email;
        const email =
          typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : null;
        const result = await authenticateCredentials(
          rawEmail,
          (raw as { password?: unknown })?.password,
        );
        switch (result.kind) {
          case "invalid_input":
            await recordAudit(null, "login_failed", null, { reason: "invalid_input" });
            return null;
          case "no_user":
            await recordAudit(null, "login_failed", email, { reason: "no_such_user" });
            return null;
          case "inactive":
            await recordAudit(result.userId, "login_denied_inactive", email, {});
            return null;
          case "bad_password":
            await recordAudit(result.userId, "login_failed", email, { reason: "bad_password" });
            return null;
          case "ok":
            await issueDbSessionCookie(result.user.id);
            await recordAudit(result.user.id, "login", email, {});
            return result.user;
        }
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    session({ session, user }) {
      if (session.user && user) {
        session.user.id = user.id;
        // `user` here is the adapter-returned DB row — it carries our custom
        // `role` column because PostgresAdapter selects * from users.
        const role = (user as unknown as { role?: Role }).role;
        if (role) session.user.role = role;
      }
      return session;
    },
  },
});
