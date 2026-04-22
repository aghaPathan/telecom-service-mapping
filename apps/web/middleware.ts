import NextAuth from "next-auth";
import authConfig from "./auth.config";

// Edge-safe middleware. We run NextAuth(authConfig) to get an `auth` wrapper
// that injects nothing heavy — authConfig has no adapter and no providers.
// However, under the DB-session strategy used in auth.ts, no JWT is issued,
// so `req.auth` is always null in Edge. We therefore fall back to a
// cookie-presence check as the primary gate. Full session validation (DB
// lookup, role resolution) happens in server components via `await auth()`
// from `@/auth` — not here.
const { auth } = NextAuth(authConfig);

// Cookie name must match what issueDbSessionCookie() sets — keyed off the
// NEXTAUTH_URL scheme so HTTP deployments (CI smoke, internal LAN) don't use
// the __Secure- prefix (browser would reject it).
const SESSION_COOKIE = (process.env.NEXTAUTH_URL ?? "").startsWith("https://")
  ? "__Secure-authjs.session-token"
  : "authjs.session-token";

const PUBLIC_EXACT = new Set<string>(["/login", "/api/health"]);

export default auth((req) => {
  const { nextUrl } = req;
  const { pathname, search } = nextUrl;

  if (PUBLIC_EXACT.has(pathname)) return;
  if (pathname.startsWith("/api/auth")) return;

  const hasSession = req.cookies.get(SESSION_COOKIE)?.value != null;
  if (!hasSession) {
    const loginUrl = new URL("/login", nextUrl.origin);
    loginUrl.searchParams.set("next", pathname + search);
    return Response.redirect(loginUrl);
  }
});

export const config = {
  matcher: [
    // Skip Next internals + common static asset extensions.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|txt|xml|map)$).*)",
  ],
};
