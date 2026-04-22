import { cookies } from "next/headers";
import { getPool } from "@/lib/postgres";
import type { Role } from "@/lib/rbac";

export type Session = { user: { id: string; email: string; role: Role } };

function cookieName(): string {
  return (process.env.NEXTAUTH_URL ?? "").startsWith("https://")
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}

/** Look up the current session via the session-token cookie.
 *  Returns null on missing cookie, expired session, or unknown token. */
export async function getSession(): Promise<Session | null> {
  const token = cookies().get(cookieName())?.value;
  if (!token) return null;
  const { rows } = await getPool().query<{
    id: string;
    email: string;
    role: Role;
    expires: Date;
    is_active: boolean;
  }>(
    `SELECT u.id, u.email, u.role, s.expires, u.is_active
       FROM sessions s JOIN users u ON u.id = s."userId"
      WHERE s."sessionToken" = $1`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.is_active) return null;
  if (new Date(row.expires).getTime() < Date.now()) return null;
  return { user: { id: row.id, email: row.email, role: row.role } };
}

/** Delete the current session row and clear the cookie. Idempotent. */
export async function destroySession(): Promise<void> {
  const name = cookieName();
  const token = cookies().get(name)?.value;
  if (token) {
    try {
      await getPool().query(
        `DELETE FROM sessions WHERE "sessionToken" = $1`,
        [token],
      );
    } catch {
      /* best-effort */
    }
  }
  cookies().delete(name);
}
