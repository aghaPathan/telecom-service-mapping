"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticateCredentials } from "@/lib/authenticate";
import { issueDbSessionCookie } from "@/lib/session-cookie";
import { recordAudit } from "@/lib/audit";

const schema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.trim().toLowerCase()),
  password: z.string().min(1),
  next: z.string().optional(),
});

export type LoginState = { ok: boolean; error?: string };

export async function loginAction(
  _prev: LoginState | null,
  formData: FormData,
): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next"),
  });
  if (!parsed.success) {
    await recordAudit(null, "login_failed", null, { reason: "invalid_input" });
    return { ok: false, error: "Invalid email or password." };
  }
  const result = await authenticateCredentials(
    parsed.data.email,
    parsed.data.password,
  );
  switch (result.kind) {
    case "invalid_input":
      await recordAudit(null, "login_failed", parsed.data.email, {
        reason: "invalid_input",
      });
      return { ok: false, error: "Invalid email or password." };
    case "no_user":
      await recordAudit(null, "login_failed", parsed.data.email, {
        reason: "no_such_user",
      });
      return { ok: false, error: "Invalid email or password." };
    case "bad_password":
      await recordAudit(result.userId, "login_failed", parsed.data.email, {
        reason: "bad_password",
      });
      return { ok: false, error: "Invalid email or password." };
    case "inactive":
      await recordAudit(
        result.userId,
        "login_denied_inactive",
        parsed.data.email,
        {},
      );
      return { ok: false, error: "Account is disabled." };
    case "ok": {
      await issueDbSessionCookie(result.user.id);
      await recordAudit(result.user.id, "login", parsed.data.email, {});
      // Open-redirect guard: only same-origin paths are allowed as `next`.
      const target =
        parsed.data.next && parsed.data.next.startsWith("/")
          ? parsed.data.next
          : "/";
      // `redirect` throws a NEXT_REDIRECT — uncaught here = correct.
      redirect(target);
    }
  }
}
