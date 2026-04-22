import { cookies } from "next/headers";
import { auth, signOut } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { getPool } from "@/lib/postgres";

async function logoutAction() {
  "use server";
  const s = await auth();
  const userId = s?.user?.id ?? null;
  if (userId) await recordAudit(userId, "logout", null, {});

  // Best-effort: delete the DB session row so the cookie is truly dead even
  // if the browser replays it before expiry.
  const cookieName = (process.env.NEXTAUTH_URL ?? "").startsWith("https://")
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
  const token = cookies().get(cookieName)?.value;
  if (token) {
    try {
      await getPool().query(
        `DELETE FROM sessions WHERE "sessionToken"=$1`,
        [token],
      );
    } catch {
      /* best-effort */
    }
  }
  await signOut({ redirectTo: "/login" });
}

export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <button
        type="submit"
        className="text-xs font-medium text-slate-600 hover:text-slate-900"
      >
        Log out
      </button>
    </form>
  );
}
