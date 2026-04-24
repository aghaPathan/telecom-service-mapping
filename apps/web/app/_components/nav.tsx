import Link from "next/link";
import type { Session } from "@/lib/session";

type Props = { session: Session | null };

const ROW1 = [
  { href: "/", label: "Home" },
  { href: "/devices", label: "Devices" },
  { href: "/core", label: "Core" },
  { href: "/topology", label: "Topology" },
  { href: "/map", label: "Map" },
  { href: "/analytics", label: "Analytics" },
  { href: "/isolations", label: "Isolations" },
  { href: "/ingestion", label: "Ingestion" },
];

const ROW2_ADMIN = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/audit", label: "Audit" },
];

export function Nav({ session }: Props) {
  if (!session) return null;
  const isAdmin = session.user.role === "admin";
  return (
    <nav aria-label="Primary" data-testid="app-nav">
      <ul className="flex gap-3 text-sm" data-testid="nav-row-1">
        {ROW1.map((i) => (
          <li key={i.href}>
            <Link
              href={i.href}
              className="text-slate-600 hover:text-slate-900"
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
      {isAdmin && (
        <ul
          className="flex gap-3 text-xs mt-1 opacity-80"
          aria-label="Admin"
          data-testid="nav-row-2"
        >
          {ROW2_ADMIN.map((i) => (
            <li key={i.href}>
              <Link
                href={i.href}
                className="text-slate-500 hover:text-slate-800"
              >
                {i.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
