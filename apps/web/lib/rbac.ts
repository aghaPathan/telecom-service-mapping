import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = { admin: 3, operator: 2, viewer: 1 };

export function hasRole(user: Role, required: Role): boolean {
  return RANK[user] >= RANK[required];
}

/** Server-only. Redirects to /login if anon, throws 403 Response if role too low. */
export async function requireRole(required: Role) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!hasRole(session.user.role, required)) {
    throw new Response("forbidden", { status: 403 });
  }
  return session;
}
