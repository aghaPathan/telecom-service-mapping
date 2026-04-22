"use client";
import { useFormState, useFormStatus } from "react-dom";
import { useEffect, useRef } from "react";
import { createUser, type ActionResult } from "./actions";

const initial: ActionResult | null = null;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
    >
      {pending ? "Creating…" : "Create user"}
    </button>
  );
}

export function CreateUserForm() {
  const [state, action] = useFormState(createUser, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={action}
      className="flex flex-wrap items-end gap-3"
      data-testid="create-user-form"
    >
      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Email
        <input
          name="email"
          type="email"
          required
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Password
        <input
          name="password"
          type="password"
          required
          minLength={8}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Role
        <select
          name="role"
          defaultValue="viewer"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        >
          <option value="admin">admin</option>
          <option value="operator">operator</option>
          <option value="viewer">viewer</option>
        </select>
      </label>
      <SubmitButton />
      {state && !state.ok ? (
        <p className="w-full text-xs text-red-600" data-testid="create-user-error">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
