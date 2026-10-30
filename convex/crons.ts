import { cronJobs } from "convex/server";
import { agents } from "./agents/refs";
import { identity } from "./identity/refs";
import { notifications } from "./notifications/refs";

// component-backend-foundation §Composition: each cron row is added in the
// same change that adds its function.
const crons = cronJobs();

crons.interval("agent sweep", { minutes: 1 }, agents.sweep.run, {});
// component-identity §Ending a connection: ends ephemeral connections past
// their idle deadline (req-install-keys AC-4.1).
crons.interval("ephemeral connection sweep", { minutes: 1 }, identity.ephemeral.sweep, {});
crons.interval("digest dispatch", { minutes: 5 }, notifications.digest.dispatchDue, {});
crons.daily("agent purge", { hourUTC: 3, minuteUTC: 0 }, agents.purge.run, {});
crons.daily(
  "sign-in request purge",
  { hourUTC: 3, minuteUTC: 10 },
  identity.deviceRequests.purge,
  {},
);

// component-identity §Account deletion: restarts stalled account purges and
// overdue Clerk user deletions.
crons.hourly(
  "account deletion recovery",
  { minuteUTC: 20 },
  identity.accountDeletion.resumePurges,
  {},
);

// component-notifications §Push history retention: deletes the push
// component's settled notifications older than 24 hours.
crons.hourly("push history retention", { minuteUTC: 40 }, notifications.retention.sweep, {});

export default crons;
