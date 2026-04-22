"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/auth";

export type LoginState = { ok: boolean; error?: string };

export async function loginAction(
  _prev: LoginState | null,
  formData: FormData,
): Promise<LoginState> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: (formData.get("next") as string) || "/",
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, error: "Invalid email or password." };
    }
    // Next.js uses thrown redirects to perform navigation from server actions.
    // Those must be re-thrown, not swallowed.
    throw err;
  }
}
