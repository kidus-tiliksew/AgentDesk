import { cronJobs } from "convex/server";
import { agents } from "./agents/refs";
import { identity } from "./identity/refs";

// component-backend-foundation §Composition: each cron row is added in the
// same change that adds its function.
const crons = cronJobs();

crons.interval("agent sweep", { minutes: 1 }, agents.sweep.run, {});
crons.daily("agent purge", { hourUTC: 3, minuteUTC: 0 }, agents.purge.run, {});
crons.daily(
  "sign-in request purge",
  { hourUTC: 3, minuteUTC: 10 },
  identity.deviceRequests.purge,
  {},
);

export default crons;
