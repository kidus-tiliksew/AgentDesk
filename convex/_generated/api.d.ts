/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents_svc from "../agents/svc.js";
import type * as crons from "../crons.js";
import type * as decisions_svc from "../decisions/svc.js";
import type * as http from "../http.js";
import type * as identity_credentials from "../identity/credentials.js";
import type * as identity_devMint from "../identity/devMint.js";
import type * as identity_deviceRequests from "../identity/deviceRequests.js";
import type * as identity_harnesses from "../identity/harnesses.js";
import type * as identity_selfRevoke from "../identity/selfRevoke.js";
import type * as identity_svc from "../identity/svc.js";
import type * as identity_tokens from "../identity/tokens.js";
import type * as identity_users from "../identity/users.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_owned from "../lib/owned.js";
import type * as lib_svc from "../lib/svc.js";
import type * as notifications_svc from "../notifications/svc.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "agents/svc": typeof agents_svc;
  crons: typeof crons;
  "decisions/svc": typeof decisions_svc;
  http: typeof http;
  "identity/credentials": typeof identity_credentials;
  "identity/devMint": typeof identity_devMint;
  "identity/deviceRequests": typeof identity_deviceRequests;
  "identity/harnesses": typeof identity_harnesses;
  "identity/selfRevoke": typeof identity_selfRevoke;
  "identity/svc": typeof identity_svc;
  "identity/tokens": typeof identity_tokens;
  "identity/users": typeof identity_users;
  "lib/auth": typeof lib_auth;
  "lib/errors": typeof lib_errors;
  "lib/owned": typeof lib_owned;
  "lib/svc": typeof lib_svc;
  "notifications/svc": typeof notifications_svc;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  pushNotifications: import("@convex-dev/expo-push-notifications/_generated/component.js").ComponentApi<"pushNotifications">;
};
