import type { Role } from "@/lib/rbac";
import type { Visibility } from "@/lib/saved-views";

const RANK: Record<Role, number> = { admin: 3, operator: 2, viewer: 1 };

const ROLE_VISIBILITY: Record<Role, Extract<Visibility, `role:${string}`>> = {
  admin: "role:admin",
  operator: "role:operator",
  viewer: "role:viewer",
};

// Which role-scoped visibility strings should appear in a user's list view?
// A user of rank N sees every share targeted at a role of rank ≤ N.
// `private` is owner-only and handled by a separate `owner_user_id = $me`
// clause in the list query, so it's never returned here.
export function visibleVisibilities(
  role: Role,
): Array<Extract<Visibility, `role:${string}`>> {
  const myRank = RANK[role];
  return (Object.keys(RANK) as Role[])
    .filter((r) => RANK[r] <= myRank)
    .map((r) => ROLE_VISIBILITY[r]);
}

// Can a user set this visibility on a view they own? Prevents share-up:
// a viewer can't publish to operators; an operator can't publish to admins.
// Everyone can always keep their own views private.
export function canSetVisibility(role: Role, v: Visibility): boolean {
  if (v === "private") return true;
  // Viewers are explicitly restricted to `private` per the issue acceptance
  // criterion ("visibility restricted to `private` only — server enforces"),
  // even though their rank would otherwise let them share to `role:viewer`.
  if (role === "viewer") return false;
  const targetRole = v.slice("role:".length) as Role;
  if (!(targetRole in RANK)) return false;
  return RANK[role] >= RANK[targetRole];
}
