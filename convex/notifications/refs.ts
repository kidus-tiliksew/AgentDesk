import { type ApiFromModules, anyApi } from "convex/server";
import type * as accountPurge from "./accountPurge";
import type * as devices from "./devices";
import type * as digest from "./digest";
import type * as digests from "./digests";
import type * as retention from "./retention";
import type * as route from "./route";
import type * as rules from "./rules";
import type * as settings from "./settings";

// Typed references to this domain's functions, built from the module types
// rather than convex/_generated/api.d.ts, so adding a function here needs no
// edit to the generated declarations that component-backend-foundation owns.
// The imports are type-only, so this module loads no function code.
type NotificationsApi = ApiFromModules<{
  "notifications/accountPurge": typeof accountPurge;
  "notifications/devices": typeof devices;
  "notifications/digest": typeof digest;
  "notifications/digests": typeof digests;
  "notifications/retention": typeof retention;
  "notifications/route": typeof route;
  "notifications/rules": typeof rules;
  "notifications/settings": typeof settings;
}>["notifications"];

export const notifications = anyApi.notifications as unknown as NotificationsApi;
