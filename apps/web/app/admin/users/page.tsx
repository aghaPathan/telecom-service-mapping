import { requireRole } from "@/lib/rbac";
import { getPool } from "@/lib/postgres";
import { CreateUserForm } from "./create-user-form";
import { UserRow } from "./user-row";
import type { Role } from "@/lib/rbac";

type UserListRow = {
  id: string;
  email: string;
  role: Role;
  is_active: boolean;
  created_at: string;
};

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const session = await requireRole("admin");
  const { rows } = await getPool().query<UserListRow>(
    `SELECT id, email, role, is_active, created_at::text FROM users ORDER BY email`,
  );
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="mb-6 text-lg font-semibold text-slate-900">Users</h1>
      <section className="mb-8 rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-700">Create user</h2>
        <CreateUserForm />
      </section>
      <table className="w-full text-sm" data-testid="users-table">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            <th className="py-2">Email</th>
            <th>Role</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <UserRow key={u.id} user={u} currentUserId={session.user.id} />
          ))}
        </tbody>
      </table>
    </main>
  );
}
