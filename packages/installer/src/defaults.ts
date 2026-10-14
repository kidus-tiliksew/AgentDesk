// Build-time constants. scripts/build.mjs replaces each identifier through
// esbuild `define`; unbundled source (tests) sees none of them and falls back
// to undefined, so tests always pass their own server and skill.
declare const __AGENTDESK_DEFAULT_SERVER__: string | undefined;
declare const __AGENTDESK_SKILL_CONTENT__: string | undefined;
declare const __AGENTDESK_SKILL_VERSION__: string | undefined;
declare const __AGENTDESK_GUIDANCE__: string | undefined;
declare const __AGENTDESK_VERSION__: string | undefined;

/**
 * The public origin compiled into the build from the AGENTDESK_SERVER_ORIGIN
 * build input (component-installer §Commands). `--server` replaces it.
 */
export const DEFAULT_SERVER_ORIGIN: string | undefined =
  typeof __AGENTDESK_DEFAULT_SERVER__ === "string" ? __AGENTDESK_DEFAULT_SERVER__ : undefined;

/** The skill file embedded from `@agentdesk/skill/agentdesk/SKILL.md` at build time. */
export const EMBEDDED_SKILL: { content: string; version: string } | undefined =
  typeof __AGENTDESK_SKILL_CONTENT__ === "string" && typeof __AGENTDESK_SKILL_VERSION__ === "string"
    ? { content: __AGENTDESK_SKILL_CONTENT__, version: __AGENTDESK_SKILL_VERSION__ }
    : undefined;

/**
 * The standing guidance embedded from `@agentdesk/skill/agentdesk/GUIDANCE.md`
 * at build time; `agentdesk context` prints it (component-installer §Standing guidance).
 */
export const EMBEDDED_GUIDANCE: string | undefined =
  typeof __AGENTDESK_GUIDANCE__ === "string" ? __AGENTDESK_GUIDANCE__ : undefined;

export const INSTALLER_VERSION: string =
  typeof __AGENTDESK_VERSION__ === "string" ? __AGENTDESK_VERSION__ : "0.0.0-dev";

/** Poll interval for `/device/poll` (component-installer §Sign-in). */
export const POLL_INTERVAL_MS = 2_000;

/** Codes requested in one run before a noninteractive sign-in gives up on expiry. */
export const MAX_CODES_NONINTERACTIVE = 3;

/** Name of the MCP entry in every harness configuration. */
export const MCP_ENTRY_NAME = "agentdesk";

export const BACKUP_SUFFIX = ".agentdesk-backup";

/** The session-start hook matcher for Claude Code and Codex: new session, /clear, and compaction. */
export const HOOK_MATCHER = "startup|clear|compact";

/** Limit on one `codex app-server` exchange (component-installer §Codex trust). */
export const APP_SERVER_TIMEOUT_MS = 10_000;
