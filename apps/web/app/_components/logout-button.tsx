import { redirect } from "next/navigation";
import { getSession, destroySession } from "@/lib/session";
import { recordAudit } from "@/lib/audit";

async function logoutAction() {
  "use server";
  const s = await getSession();
  if (s?.user) await recordAudit(s.user.id, "logout", null, {});
  await destroySession();
  redirect("/login");
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
