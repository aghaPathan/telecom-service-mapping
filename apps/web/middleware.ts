import type { NextRequest } from "next/server";

// Cookie name must match what issueDbSessionCookie() sets — keyed off the
// NEXTAUTH_URL scheme so HTTP deployments (CI smoke, internal LAN) don't use
// the __Secure- prefix (browser would reject it).
const SESSION_COOKIE = (process.env.NEXTAUTH_URL ?? "").startsWith("https://")
  ? "__Secure-authjs.session-token"
  : "authjs.session-token";

const PUBLIC_EXACT = new Set<string>(["/login", "/api/health"]);

export default function middleware(req: NextRequest) {
  const { nextUrl } = req;
  const { pathname, search } = nextUrl;

  // Block dev-preview pages in production before auth check so unauthenticated
  // users also receive 404 (not a redirect to login).
  if (process.env.NODE_ENV === "production") {
    const devOnly = ["/design-preview", "/graph-preview"];
    if (devOnly.some(p => pathname === p || pathname.startsWith(p + "/"))) {
      return new Response("Not Found", { status: 404 });
    }
  }

  if (PUBLIC_EXACT.has(pathname)) return;
  // Kept as a public namespace even though empty — legacy routes we might
  // reintroduce (e.g. CSRF endpoint) would need to pass through.
  if (pathname.startsWith("/api/auth")) return;

  const hasSession = req.cookies.get(SESSION_COOKIE)?.value != null;
  if (!hasSession) {
    const loginUrl = new URL("/login", nextUrl.origin);
    loginUrl.searchParams.set("next", pathname + search);
    return Response.redirect(loginUrl);
  }
}

export const config = {
  matcher: [
    // Skip Next internals + common static asset extensions.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|txt|xml|map)$).*)",
  ],
};
