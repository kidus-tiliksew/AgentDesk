// component-gateway §Configuration. `wrangler.toml` declares the variables and
// the rate-limit binding; the two secrets come from `wrangler secret put` or
// `.dev.vars`.
export interface Env {
  PUBLIC_ORIGIN: string;
  CONVEX_SITE_URL: string;
  CLERK_PUBLISHABLE_KEY: string;
  SERVICE_SECRET: string;
  // Clerk OAuth verification is not built yet, so nothing reads it.
  CLERK_SECRET_KEY?: string;
  // `/device/start` refuses with 503 without it. Optional so `/mcp` tests
  // need no limiter.
  DEVICE_START_LIMIT?: RateLimit;
  // `/device/enroll` refuses with 503 without it. Optional for the same
  // reason.
  DEVICE_ENROLL_LIMIT?: RateLimit;
  // `/v1` refuses with 503 without it, keyed by the API credential. Optional
  // so other tests need no limiter.
  API_LIMIT?: RateLimit;
}
