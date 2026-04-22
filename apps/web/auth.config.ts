import type { NextAuthConfig } from "next-auth";

// Edge-safe subset: NO adapter, NO bcryptjs, NO pg. Used by middleware.ts.
// Providers live in the full `auth.ts` config where Node APIs are available.
const authConfig: NextAuthConfig = {
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      // Middleware file itself also handles public-route exemptions — this
      // callback is a belt-and-suspenders check that defaults to requiring auth.
      const isLoggedIn = !!auth?.user;
      const pathname = request.nextUrl.pathname;
      if (pathname === "/login" || pathname === "/api/health" || pathname.startsWith("/api/auth/")) return true;
      return isLoggedIn;
    },
  },
};

export default authConfig;
