import { cronJobs } from "convex/server";

// component-backend-foundation §Composition: each cron row is added in the
// same change that adds its function. No domain function exists yet.
const crons = cronJobs();

export default crons;
