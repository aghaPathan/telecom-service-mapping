"use client";
import { useTransition } from "react";
import { changeRole, deactivateUser, reactivateUser } from "./actions";
import type { Role } from "@/lib/rbac";

type Props = {
  user: {
    id: string;
    email: string;
    role: Role;
    is_active: boolean;
    created_at: string;
  };
  currentUserId: string;
};

const ROLES: Role[] = ["admin", "operator", "viewer"];

export function UserRow({ user, currentUserId }: Props) {
  const [pending, startTransition] = useTransition();
  const isSelf = user.id === currentUserId;

  const onRoleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as Role;
    if (next === user.role) return;
    startTransition(async () => {
      await changeRole(user.id, next);
    });
  };

  const onDeactivate = () => {
    if (!window.confirm(`Deactivate ${user.email}? Active sessions will be revoked.`)) return;
    startTransition(async () => {
      await deactivateUser(user.id);
    });
  };

  const onReactivate = () => {
    startTransition(async () => {
      await reactivateUser(user.id);
    });
  };

  return (
    <tr className="border-t border-slate-100" data-testid={`user-row-${user.email}`}>
      <td className="py-2">{user.email}</td>
      <td>
        {isSelf ? (
          <span className="text-slate-500" title="cannot change your own role">
            {user.role}
          </span>
        ) : (
          <select
            value={user.role}
            onChange={onRoleChange}
            disabled={pending}
            className="rounded border border-slate-300 px-2 py-1 text-xs"
            data-testid={`role-select-${user.email}`}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
      </td>
      <td>
        <span
          className={
            user.is_active
              ? "text-xs text-emerald-700"
              : "text-xs text-slate-500"
          }
        >
          {user.is_active ? "active" : "inactive"}
        </span>
      </td>
      <td className="text-right">
        {user.is_active ? (
          <button
            type="button"
            onClick={onDeactivate}
            disabled={pending || isSelf}
            title={isSelf ? "cannot deactivate yourself" : "deactivate user"}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            data-testid={`deactivate-${user.email}`}
          >
            Deactivate
          </button>
        ) : (
          <button
            type="button"
            onClick={onReactivate}
            disabled={pending}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            data-testid={`reactivate-${user.email}`}
          >
            Reactivate
          </button>
        )}
      </td>
    </tr>
  );
}
