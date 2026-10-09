import type { AuthConfig } from "convex/server";

// component-backend-foundation §Authentication of people: Clerk issues the
// session tokens Convex validates (DEC-5).
const domain = process.env.CLERK_JWT_ISSUER_DOMAIN;
if (!domain) {
  throw new Error("CLERK_JWT_ISSUER_DOMAIN is not set");
}

export default {
  providers: [{ domain, applicationID: "convex" }],
} satisfies AuthConfig;
