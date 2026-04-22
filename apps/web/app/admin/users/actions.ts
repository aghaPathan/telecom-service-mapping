"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { getPool } from "@/lib/postgres";
import { hashPassword } from "@/lib/password";
import { recordAudit } from "@/lib/audit";
import type { Role } from "@/lib/rbac";

const ROLE = z.enum(["admin", "operator", "viewer"]);
const createSchema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.trim().toLowerCase()),
  password: z.string().min(8),
  role: ROLE,
});

export type ActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function createUser(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const parsed = createSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { email, password, role } = parsed.data;
  const hash = await hashPassword(password);
  const pool = getPool();
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id`,
      [email, hash, role],
    );
    const newId = rows[0]?.id;
    await recordAudit(admin.user.id, "user_created", newId ? `user:${newId}` : null, { email, role });
    revalidatePath("/admin/users");
    return { ok: true };
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "23505") {
      return { ok: false, error: "email already exists" };
    }
    throw err;
  }
}

export async function deactivateUser(userId: string): Promise<ActionResult> {
  const admin = await requireRole("admin");
  if (userId === admin.user.id) {
    return { ok: false, error: "cannot deactivate self" };
  }
  const pool = getPool();
  await pool.query(`UPDATE users SET is_active=false, updated_at=now() WHERE id=$1`, [userId]);
  // Immediate revocation — kill live sessions.
  await pool.query(`DELETE FROM sessions WHERE "userId"=$1`, [userId]);
  await recordAudit(admin.user.id, "user_deactivated", `user:${userId}`, {});
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function reactivateUser(userId: string): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const pool = getPool();
  await pool.query(`UPDATE users SET is_active=true, updated_at=now() WHERE id=$1`, [userId]);
  await recordAudit(admin.user.id, "user_reactivated", `user:${userId}`, {});
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function changeRole(userId: string, nextRole: Role): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const parsed = ROLE.safeParse(nextRole);
  if (!parsed.success) return { ok: false, error: "invalid role" };
  const pool = getPool();
  const { rows } = await pool.query<{ role: Role }>(
    `SELECT role FROM users WHERE id=$1`,
    [userId],
  );
  const prev = rows[0]?.role;
  await pool.query(`UPDATE users SET role=$2, updated_at=now() WHERE id=$1`, [
    userId,
    parsed.data,
  ]);
  await recordAudit(admin.user.id, "role_changed", `user:${userId}`, {
    from: prev,
    to: parsed.data,
  });
  revalidatePath("/admin/users");
  return { ok: true };
}
