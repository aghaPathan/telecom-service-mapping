import { redirect } from "next/navigation";

export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = { admin: 3, operator: 2, viewer: 1 };

export function hasRole(user: Role, required: Role): boolean {
  return RANK[user] >= RANK[required];
}

/** Server-only. Redirects to /login if anon, throws 403 Response if role too low. */
export async function requireRole(required: Role) {
  // Dynamic import avoids a compile-time cycle before @/auth lands in batch 4.
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.user) redirect("/login");
  const userRole = (session.user as { role?: Role }).role;
  if (!userRole || !hasRole(userRole, required)) {
    throw new Response("forbidden", { status: 403 });
  }
  return session;
}
