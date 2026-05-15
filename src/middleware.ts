/**
 * Clerk middleware.
 *
 * Runs on every request. Protects any route matching the protected matcher;
 * unauthenticated visitors get redirected to /sign-in.
 *
 * Public routes (homepage, /sign-in, /sign-up, /api/cron/*, /api/setup) are
 * allowed without auth. Everything under /dashboard requires sign-in.
 */

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
