import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import PostgresAdapter from "@auth/pg-adapter";
import { z } from "zod";
import authConfig from "@/auth.config";
import { getPool } from "@/lib/postgres";
import { verifyPassword } from "@/lib/password";
import { issueDbSessionCookie } from "@/lib/session-cookie";
import { recordAudit } from "@/lib/audit";
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

const credentialsSchema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.trim().toLowerCase()),
  password: z.string().min(1),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  is_active: boolean;
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
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) {
          await recordAudit(null, "login_failed", null, { reason: "invalid_input" });
          return null;
        }
        const { email, password } = parsed.data;
        const { rows } = await getPool().query<UserRow>(
          `SELECT id, email, password_hash, role, is_active FROM users WHERE email=$1`,
          [email],
        );
        const user = rows[0];
        if (!user) {
          await recordAudit(null, "login_failed", email, { reason: "no_such_user" });
          return null;
        }
        if (!user.is_active) {
          await recordAudit(user.id, "login_denied_inactive", email, {});
          return null;
        }
        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) {
          await recordAudit(user.id, "login_failed", email, { reason: "bad_password" });
          return null;
        }
        await issueDbSessionCookie(user.id);
        await recordAudit(user.id, "login", email, {});
        return { id: user.id, email: user.email, role: user.role };
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
