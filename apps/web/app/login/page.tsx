import { LoginForm } from "./login-form";

export const metadata = {
  title: "Sign in · Telecom Service Mapping",
};

export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const next = searchParams.next ?? "/";
  return (
    <main className="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center px-6 py-10">
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold tracking-tight text-slate-900">
          Telecom Service Mapping
        </h1>
        <p className="mb-6 text-xs text-slate-500">
          Sign in with your operator account.
        </p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
