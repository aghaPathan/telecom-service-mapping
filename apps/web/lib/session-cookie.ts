import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getPool } from "@/lib/postgres";

const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

function cookieName(): string {
  return process.env.NODE_ENV === "production"
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}

/**
 * Insert a row into `sessions` for the given user and set the Auth.js session
 * cookie pointing at it. Required for the Credentials+DB-session workaround —
 * do not refactor this into session:'jwt' without revisiting the revocation
 * acceptance criterion in issue #7.
 */
export async function issueDbSessionCookie(userId: string): Promise<string> {
  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_MAX_AGE_S * 1000);
  await getPool().query(
    `INSERT INTO sessions (id, "userId", "sessionToken", expires)
     VALUES (gen_random_uuid()::text, $1, $2, $3)`,
    [userId, sessionToken, expires],
  );
  cookies().set(cookieName(), sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
    path: "/",
  });
  return sessionToken;
}
