import { z } from "zod";
import { getPool } from "@/lib/postgres";
import { verifyPassword } from "@/lib/password";
import type { Role } from "@/lib/rbac";

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

export type AuthenticateResult =
  | { kind: "invalid_input" }
  | { kind: "no_user" }
  | { kind: "inactive"; userId: string }
  | { kind: "bad_password"; userId: string }
  | { kind: "ok"; user: { id: string; email: string; role: Role } };

/**
 * Pure credential check used by the NextAuth Credentials provider.
 * Lives outside `auth.ts` so it can be unit/integration tested without
 * dragging in the NextAuth runtime (which imports `next/server` — not
 * resolvable under plain Node / vitest).
 */
export async function authenticateCredentials(
  rawEmail: unknown,
  rawPassword: unknown,
): Promise<AuthenticateResult> {
  const parsed = credentialsSchema.safeParse({ email: rawEmail, password: rawPassword });
  if (!parsed.success) return { kind: "invalid_input" };
  const { email, password } = parsed.data;
  const { rows } = await getPool().query<UserRow>(
    `SELECT id, email, password_hash, role, is_active FROM users WHERE email=$1`,
    [email],
  );
  const user = rows[0];
  if (!user) return { kind: "no_user" };
  if (!user.is_active) return { kind: "inactive", userId: user.id };
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return { kind: "bad_password", userId: user.id };
  return { kind: "ok", user: { id: user.id, email: user.email, role: user.role } };
}
