import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  agentSessionPageSchema,
  agentSessionSchema,
  answerSubmissionSchema,
  decisionPageSchema,
  decisionSchema,
  ERROR_STATUS,
  type ErrorCode,
  errorBodySchema,
  ROUTES,
  type RouteDefinition,
  statusLinkSchema,
  webhookEventSchema,
} from "../src/index.js";

// component-contract §Route table and specification: spec/ is generated from
// the route table and the read shapes, and spec:check fails when the committed
// spec/ differs from a fresh generation (req-public-api-and-webhooks AC-1.1).

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const SPEC_DIR = join(REPO_ROOT, "spec");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

// Response schemas published as shared OpenAPI components, in output view.
const RESPONSE_COMPONENTS = new Map<z.ZodType, string>([
  [decisionSchema, "Decision"],
  [agentSessionSchema, "AgentSession"],
  [decisionPageSchema, "DecisionPage"],
  [agentSessionPageSchema, "AgentSessionPage"],
  [errorBodySchema, "ErrorBody"],
]);

// Request bodies published as shared OpenAPI components, in input view.
const REQUEST_COMPONENTS = new Map<z.ZodType, string>([
  [answerSubmissionSchema, "AnswerSubmission"],
]);

// JSON Schema cannot express the http/https restriction on statusLinkSchema,
// which publishes as `format: uri`; the description states it and the zod
// validator enforces it.
export const LINK_DESCRIPTION = "An absolute http or https URL.";

function describeLink(ctx: { zodSchema: unknown; jsonSchema: Record<string, unknown> }): void {
  if (ctx.zodSchema === statusLinkSchema) {
    ctx.jsonSchema.description = LINK_DESCRIPTION;
  }
}

// Requests and parameters use the input view, so a defaulted field such as
// `limit` is optional. Responses and payloads use the output view, which
// lists every field as required and closes each object.
function jsonSchemaOptions(io: "input" | "output") {
  return {
    target: "draft-2020-12",
    io,
    unrepresentable: "throw",
    override: describeLink,
  } as const;
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function asObject(value: Json | undefined): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value;
}

function standaloneSchema(schema: z.ZodType, title: string): Json {
  return { title, ...asObject(toJson(z.toJSONSchema(schema, jsonSchemaOptions("output")))) };
}

function components(names: Map<z.ZodType, string>, io: "input" | "output"): JsonObject {
  const registry = z.registry<{ id: string }>();
  for (const [schema, id] of names) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    ...jsonSchemaOptions(io),
    uri: (id) => `#/components/schemas/${id}`,
  });
  const out: JsonObject = {};
  for (const [id, schema] of Object.entries(schemas)) {
    // The OpenAPI 3.1 document sets the dialect; components carry neither
    // $schema nor $id.
    const { $schema: _dialect, $id: _id, ...rest } = asObject(toJson(schema));
    out[id] = rest;
  }
  return out;
}

function ref(names: Map<z.ZodType, string>, schema: z.ZodType, io: "input" | "output"): Json {
  const id = names.get(schema);
  if (id !== undefined) return { $ref: `#/components/schemas/${id}` };
  const { $schema: _dialect, ...rest } = asObject(
    toJson(z.toJSONSchema(schema, jsonSchemaOptions(io))),
  );
  return rest;
}

function parameters(schema: z.ZodObject | undefined, location: "path" | "query"): Json[] {
  if (schema === undefined) return [];
  const json = asObject(toJson(z.toJSONSchema(schema, jsonSchemaOptions("input"))));
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(asObject(json.properties)).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    schema: property,
  }));
}

function errorResponses(errors: readonly ErrorCode[]): JsonObject {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of errors) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const out: JsonObject = {};
  for (const [status, codes] of byStatus) {
    out[String(status)] = {
      description: `Error code ${codes.map((code) => `\`${code}\``).join(" or ")}.`,
      content: {
        "application/json": { schema: ref(RESPONSE_COMPONENTS, errorBodySchema, "output") },
      },
    };
  }
  return out;
}

function operation(route: RouteDefinition): JsonObject {
  const op: JsonObject = {
    operationId: route.id,
    summary: route.summary,
    security: [{ [route.security]: [] }],
    parameters: [...parameters(route.pathParams, "path"), ...parameters(route.query, "query")],
    responses: {
      "200": {
        description: route.summary,
        content: {
          "application/json": { schema: ref(RESPONSE_COMPONENTS, route.response, "output") },
        },
      },
      ...errorResponses(route.errors),
    },
  };
  if (route.description !== undefined) op.description = route.description;
  if (route.body !== undefined) {
    op.requestBody = {
      required: true,
      content: { "application/json": { schema: ref(REQUEST_COMPONENTS, route.body, "input") } },
    };
  }
  return op;
}

export function buildOpenApi(routes: readonly RouteDefinition[] = ROUTES): JsonObject {
  const paths: { [path: string]: JsonObject } = {};
  for (const route of routes) {
    const item = paths[route.path] ?? {};
    paths[route.path] = item;
    if (item[route.method] !== undefined) {
      throw new Error(`duplicate operation ${route.method.toUpperCase()} ${route.path}`);
    }
    item[route.method] = operation(route);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "AgentDesk HTTP API",
      version: "1.0.0",
      description:
        "List, read, answer, and cancel decisions, and list and read agent sessions. Clients ignore unknown response fields, because later versions may add fields.",
    },
    paths,
    components: {
      schemas: {
        ...components(RESPONSE_COMPONENTS, "output"),
        ...components(REQUEST_COMPONENTS, "input"),
      },
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "An AgentDesk API token." },
      },
    },
  };
}

// Paths relative to spec/, mapped to their documents.
export function buildSpecDocuments(): Record<string, Json> {
  return {
    "openapi.json": buildOpenApi(),
    "schemas/decision.schema.json": standaloneSchema(decisionSchema, "Decision"),
    "schemas/agent-session.schema.json": standaloneSchema(agentSessionSchema, "AgentSession"),
    "schemas/webhook-event.schema.json": standaloneSchema(webhookEventSchema, "WebhookEvent"),
  };
}

// Sorts object keys at every depth; arrays keep their order.
export function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[key] = sortKeys(value[key] as Json);
  }
  return out;
}

// Formats with the workspace's pinned Biome and repository configuration.
// `logicalPath` is the committed path, such as spec/openapi.json, whatever
// directory the bytes are written to.
export function formatJson(logicalPath: string, text: string): string {
  const result = spawnSync(
    "pnpm",
    ["exec", "biome", "format", `--config-path=${REPO_ROOT}`, `--stdin-file-path=${logicalPath}`],
    { cwd: REPO_ROOT, input: text, encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`biome format ${logicalPath} exited ${result.status}:\n${result.stderr}`);
  }
  return result.stdout;
}

// Paths relative to spec/, mapped to their exact bytes.
export function renderSpec(): Map<string, string> {
  const files = new Map<string, string>();
  for (const [path, document] of Object.entries(buildSpecDocuments())) {
    files.set(path, formatJson(`spec/${path}`, `${JSON.stringify(sortKeys(document), null, 2)}\n`));
  }
  return files;
}

// Replaces `dir` with exactly the rendered files.
export function writeSpec(dir: string, files: Map<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name)
          .slice(dir.length + 1)
          .split("\\")
          .join("/"),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export type SpecDifference = {
  // Relative to spec/.
  path: string;
  // `missing`: generated but not committed. `unexpected`: committed but not
  // generated. `changed`: both, with different bytes.
  kind: "changed" | "missing" | "unexpected";
};

// Compares a committed spec directory with a generated one, byte for byte.
// The result is sorted by path; an empty result means they match.
export function compareSpecDirs(committedDir: string, generatedDir: string): SpecDifference[] {
  const committed = new Set(listFiles(committedDir));
  const generated = new Set(listFiles(generatedDir));
  const differences: SpecDifference[] = [];
  for (const path of new Set([...committed, ...generated])) {
    if (!committed.has(path)) {
      differences.push({ path, kind: "missing" });
    } else if (!generated.has(path)) {
      differences.push({ path, kind: "unexpected" });
    } else if (
      !readFileSync(join(committedDir, path)).equals(readFileSync(join(generatedDir, path)))
    ) {
      differences.push({ path, kind: "changed" });
    }
  }
  return differences.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Generates into a fresh temporary directory under `tmpParent`, compares it
// with `committedDir`, and removes the temporary directory. `committedDir` is
// only read.
export function checkSpec(committedDir = SPEC_DIR, tmpParent = tmpdir()): SpecDifference[] {
  const tmp = mkdtempSync(join(tmpParent, "agentdesk-spec-"));
  try {
    const generatedDir = join(tmp, "spec");
    writeSpec(generatedDir, renderSpec());
    return compareSpecDirs(committedDir, generatedDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
