import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// component-backend-foundation §Composition: each cron row is added in the
// same change that adds its function.
const crons = cronJobs();

crons.interval("agent sweep", { minutes: 1 }, internal.agents.sweep.run, {});
crons.daily("agent purge", { hourUTC: 3, minuteUTC: 0 }, internal.agents.purge.run, {});

export default crons;
