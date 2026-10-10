import { cronJobs } from "convex/server";
import { agents } from "./agents/refs";

// component-backend-foundation §Composition: each cron row is added in the
// same change that adds its function.
const crons = cronJobs();

crons.interval("agent sweep", { minutes: 1 }, agents.sweep.run, {});
crons.daily("agent purge", { hourUTC: 3, minuteUTC: 0 }, agents.purge.run, {});

export default crons;
