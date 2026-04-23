import type { Visibility } from "@/lib/saved-views";
import type { Role } from "@/lib/rbac";

export function visibilityOptions(role: Role): Visibility[] {
  if (role === "viewer") return ["private"];
  if (role === "operator") return ["private", "role:viewer", "role:operator"];
  return ["private", "role:viewer", "role:operator", "role:admin"];
}
