import { LoginForm } from "./login-form";

export const metadata = {
  title: "Sign in · Telecom Service Mapping",
};

export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string };
}) {
  const next = searchParams.next ?? "/";
  // Auth.js v5 redirects credential failures to /login?error=CredentialsSignin
  // instead of returning through the server action's catch (the redirect is a
  // thrown Next.js internal we must re-throw). Surface that as a static
  // message so users — and the E2E suite — see the failure reason.
  const urlError = searchParams.error ? "Invalid email or password." : null;
  return (
    <main className="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center px-6 py-10">
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold tracking-tight text-slate-900">
          Telecom Service Mapping
        </h1>
        <p className="mb-6 text-xs text-slate-500">
          Sign in with your operator account.
        </p>
        <LoginForm next={next} initialError={urlError} />
      </div>
    </main>
  );
}
