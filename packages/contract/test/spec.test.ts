import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentSessionSchema,
  decisionSchema,
  ERROR_STATUS,
  ROUTES,
  type RouteDefinition,
  webhookEventSchema,
} from "@agentdesk/contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  buildOpenApi,
  buildSpecDocuments,
  checkSpec,
  compareSpecDirs,
  formatJson,
  LINK_DESCRIPTION,
  REPO_ROOT,
  renderSpec,
  SPEC_DIR,
  writeSpec,
} from "../scripts/spec-lib.js";

// component-contract §Route table and specification;
// req-public-api-and-webhooks REQ-1, AC-1.1.

// Each render formats four files through Biome.
const SLOW = 60_000;

// biome-ignore lint/suspicious/noExplicitAny: walking parsed JSON documents.
type Doc = any;

const routes: readonly RouteDefinition[] = ROUTES;
const SPEC_FILES = [
  "openapi.json",
  "schemas/agent-session.schema.json",
  "schemas/decision.schema.json",
  "schemas/webhook-event.schema.json",
];

let rendered: Map<string, string>;
const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentdesk-spec-test-"));
  temps.push(dir);
  return dir;
}

beforeAll(() => {
  rendered = renderSpec();
}, SLOW);

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// Every (method, path, operationId) in an OpenAPI document.
function operations(doc: Doc): [string, string, string][] {
  return Object.entries(doc.paths as Record<string, Record<string, Doc>>).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]): [string, string, string] => [
      method,
      path,
      op.operationId as string,
    ]),
  );
}

// Paths of every `default` keyword, skipping property names under `properties`.
function defaultKeywords(value: Doc, path = "#"): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const found = key === "default" && !path.endsWith("/properties") ? [`${path}/default`] : [];
    return [...found, ...defaultKeywords(child, `${path}/${key}`)];
  });
}

const parse = (path: string): Doc => JSON.parse(rendered.get(path) ?? "");
const committed = (path: string): Doc => JSON.parse(readFileSync(join(SPEC_DIR, path), "utf8"));

describe("route coverage", () => {
  test.each([
    ["committed", () => committed("openapi.json")],
    ["generated", () => parse("openapi.json")],
  ])("every route appears once in the %s spec/openapi.json with its method and path", (_, load) => {
    const found = operations(load());
    expect(found).toHaveLength(routes.length);
    for (const route of routes) {
      expect(
        found.filter(([, , id]) => id === route.id),
        route.id,
      ).toEqual([[route.method, route.path, route.id]]);
    }
  });

  test("the coverage check fails when a route is omitted", () => {
    const found = operations(buildOpenApi(routes.slice(1)));
    expect(found.map(([, , id]) => id)).not.toContain(routes[0]?.id);
    expect(found).toHaveLength(routes.length - 1);
  });

  test("a duplicate method and path cannot be generated", () => {
    expect(() => buildOpenApi([...routes, routes[0] as RouteDefinition])).toThrow(
      "duplicate operation GET /v1/decisions",
    );
  });
});

describe("OpenAPI document", () => {
  test("is OpenAPI 3.1 with relative /v1 paths and bearer security", () => {
    const doc = parse("openapi.json");
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toBeUndefined();
    expect(Object.keys(doc.paths).every((p) => p.startsWith("/v1/"))).toBe(true);
    expect(doc.components.securitySchemes.bearer).toMatchObject({ type: "http", scheme: "bearer" });
  });

  test.each(routes.map((r) => [r.id, r] as const))("%s: operation details", (_, route) => {
    const op = parse("openapi.json").paths[route.path][route.method];
    expect(op.security).toEqual([{ bearer: [] }]);
    expect(op.parameters.map((p: Doc) => [p.in, p.name])).toEqual([
      ...Object.keys(route.pathParams?.shape ?? {}).map((n) => ["path", n]),
      ...Object.keys(route.query?.shape ?? {}).map((n) => ["query", n]),
    ]);
    for (const p of op.parameters.filter((p: Doc) => p.in === "path")) {
      expect(p.required).toBe(true);
    }
    expect(op.requestBody !== undefined).toBe(route.body !== undefined);
    const statuses = ["200", ...new Set(route.errors.map((c) => String(ERROR_STATUS[c])))].sort();
    expect(Object.keys(op.responses).sort()).toEqual(statuses);
    for (const status of statuses.slice(1)) {
      expect(op.responses[status].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/ErrorBody",
      });
    }
  });

  test("409 names both conflict and locked", () => {
    const op = parse("openapi.json").paths["/v1/decisions/{decision_id}/answer"].post;
    expect(op.responses["409"].description).toBe("Error code `conflict` or `locked`.");
  });

  test("responses reference the shared read shapes", () => {
    const doc = parse("openapi.json");
    const schemaOf = (path: string, method: string) =>
      doc.paths[path][method].responses["200"].content["application/json"].schema.$ref;
    expect(schemaOf("/v1/decisions", "get")).toBe("#/components/schemas/DecisionPage");
    expect(schemaOf("/v1/decisions/{decision_id}", "get")).toBe("#/components/schemas/Decision");
    expect(schemaOf("/v1/decisions/{decision_id}/answer", "post")).toBe(
      "#/components/schemas/Decision",
    );
    expect(schemaOf("/v1/agent-sessions", "get")).toBe("#/components/schemas/AgentSessionPage");
    expect(doc.components.schemas.DecisionPage.properties.items.items).toEqual({
      $ref: "#/components/schemas/Decision",
    });
  });
});

describe("JSON Schema views", () => {
  test("query parameters use the input view: a defaulted limit is optional", () => {
    const params = parse("openapi.json").paths["/v1/decisions"].get.parameters;
    const limit = params.find((p: Doc) => p.name === "limit");
    expect(limit).toMatchObject({ in: "query", required: false });
    expect(limit.schema).toMatchObject({ type: "integer", minimum: 1, maximum: 100, default: 50 });
    expect(params.every((p: Doc) => p.required === false)).toBe(true);
  });

  test("the answer body uses the input view: note is optional", () => {
    const doc = parse("openapi.json");
    expect(
      doc.paths["/v1/decisions/{decision_id}/answer"].post.requestBody.content["application/json"],
    ).toEqual({ schema: { $ref: "#/components/schemas/AnswerSubmission" } });
    const body = doc.components.schemas.AnswerSubmission;
    expect(body.required).toEqual(["answer"]);
    expect(body.properties.note).toEqual({ type: "string", maxLength: 2000 });
  });

  test("responses use the output view: every field is required", () => {
    const { Decision, AgentSession } = parse("openapi.json").components.schemas;
    expect(Decision.required).toEqual(Object.keys(decisionSchema.shape));
    expect(Decision.required).toContain("priority");
    expect(AgentSession.required).toEqual(Object.keys(agentSessionSchema.shape));
  });

  test("output objects are closed at every depth", () => {
    const schemas = parse("openapi.json").components.schemas;
    for (const name of [
      "Decision",
      "AgentSession",
      "DecisionPage",
      "AgentSessionPage",
      "ErrorBody",
    ]) {
      expect(schemas[name].additionalProperties, name).toBe(false);
    }
    expect(schemas.ErrorBody.properties.error.additionalProperties).toBe(false);
    expect(schemas.Decision.properties.options.anyOf[0].items.additionalProperties).toBe(false);
  });

  test("components carry neither $schema nor $id", () => {
    for (const schema of Object.values(parse("openapi.json").components.schemas as Doc)) {
      expect(schema).not.toHaveProperty("$schema");
      expect(schema).not.toHaveProperty("$id");
    }
  });
});

describe("standalone payload schemas", () => {
  const options = { target: "draft-2020-12", io: "output", unrepresentable: "throw" } as const;

  test.each([
    ["schemas/decision.schema.json", "Decision", decisionSchema],
    ["schemas/agent-session.schema.json", "AgentSession", agentSessionSchema],
    ["schemas/webhook-event.schema.json", "WebhookEvent", webhookEventSchema],
  ] as const)("%s is z.toJSONSchema output in the output view", (path, title, schema) => {
    const doc = parse(path);
    expect(doc.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(doc.title).toBe(title);
    // Only the link description differs from plain z.toJSONSchema output.
    const plain = JSON.parse(JSON.stringify(z.toJSONSchema(schema, options)));
    const strip = (value: Doc): Doc =>
      JSON.parse(JSON.stringify(value), (key, v) =>
        key === "description" && v === LINK_DESCRIPTION ? undefined : v,
      );
    const { title: _, ...rest } = strip(doc);
    expect(rest).toEqual(plain);
  });

  test("the decision payload has every Decision field and no defaults", () => {
    const doc = parse("schemas/decision.schema.json");
    expect(doc.required).toEqual(Object.keys(decisionSchema.shape));
    expect(doc.additionalProperties).toBe(false);
    expect(defaultKeywords(doc)).toEqual([]);
    // Positive control: the input-view limit parameter has a default.
    expect(defaultKeywords(parse("openapi.json"))).toHaveLength(2);
  });

  test("the webhook event payload carries a Decision or an AgentSession", () => {
    const doc = parse("schemas/webhook-event.schema.json");
    expect(doc.anyOf).toHaveLength(2);
    expect(doc.anyOf[0].properties.data.required).toEqual(Object.keys(decisionSchema.shape));
    expect(doc.anyOf[1].properties.data.required).toEqual(Object.keys(agentSessionSchema.shape));
  });
});

// component-contract §Read shapes and webhook events: the published Decision
// carries interactive, the chat surface, and the described relay fields in
// every document that publishes it.
describe("decision relay fields", () => {
  const INTERACTIVE = {
    type: "boolean",
    description: "True when the user may be watching this session and can answer in its chat",
  };
  const decisionSchemas = (): [string, Doc][] => [
    ["openapi.json", parse("openapi.json").components.schemas.Decision],
    ["decision", parse("schemas/decision.schema.json")],
    ["webhook-event", parse("schemas/webhook-event.schema.json").anyOf[0].properties.data],
  ];

  test("publish interactive, chat, chat_message, and relayed_by_agent_session_id", () => {
    for (const [where, decision] of decisionSchemas()) {
      const { properties, required } = decision;
      expect(required, where).toEqual(
        expect.arrayContaining(["interactive", "chat_message", "relayed_by_agent_session_id"]),
      );
      expect(properties.interactive, where).toEqual(INTERACTIVE);
      expect(properties.answered_via, where).toEqual({
        anyOf: [
          { type: "string", enum: ["app", "notification", "api", "chat", "default"] },
          { type: "null" },
        ],
      });
      expect(properties.chat_message, where).toEqual({
        anyOf: [{ type: "string", minLength: 1, maxLength: 4000 }, { type: "null" }],
        description: decisionSchema.shape.chat_message.description,
      });
      expect(properties.relayed_by_agent_session_id, where).toEqual({
        type: ["string", "null"],
        description: decisionSchema.shape.relayed_by_agent_session_id.description,
      });
      expect(properties.chat_message.description, where).toMatch(
        /answered_via is chat; null otherwise/,
      );
      expect(properties.relayed_by_agent_session_id.description, where).toMatch(
        /answered_via is chat; null otherwise/,
      );
    }
  });

  test("publish the described notification_action", () => {
    for (const [where, decision] of decisionSchemas()) {
      const { properties, required } = decision;
      expect(required, where).toContain("notification_action");
      expect(properties.notification_action, where).toEqual({
        anyOf: [{ type: "string", enum: ["push", "digest", "mute"] }, { type: "null" }],
        description: decisionSchema.shape.notification_action.description,
      });
      expect(properties.notification_action.description, where).toMatch(
        /chose for this decision's creation; null until routing has run/,
      );
    }
  });

  test("the resolve input is not published and the request bodies are unchanged", () => {
    const doc = parse("openapi.json");
    expect(Object.keys(doc.components.schemas).sort()).toEqual([
      "AgentSession",
      "AgentSessionPage",
      "AnswerSubmission",
      "Decision",
      "DecisionPage",
      "ErrorBody",
    ]);
    expect(Object.keys(doc.components.schemas.AnswerSubmission.properties)).toEqual([
      "answer",
      "note",
    ]);
    for (const [path, text] of rendered) {
      if (path === "openapi.json") continue;
      expect(text, path).not.toContain("decision_id");
    }
    const bodies = operations(doc).filter(([method, path]) => doc.paths[path][method].requestBody);
    expect(bodies.map(([, , id]) => id)).toEqual(["decisions.answer"]);
  });
});

describe("agent session link", () => {
  const linkSchemas = (): [string, Doc][] => [
    ["openapi.json", parse("openapi.json").components.schemas.AgentSession.properties.link],
    ["agent-session", parse("schemas/agent-session.schema.json").properties.link],
    [
      "webhook-event",
      parse("schemas/webhook-event.schema.json").anyOf[1].properties.data.properties.link,
    ],
  ];

  test("publishes format uri with an http or https description", () => {
    for (const [where, link] of linkSchemas()) {
      expect(link, where).toEqual({
        anyOf: [{ type: "string", format: "uri", description: LINK_DESCRIPTION }, { type: "null" }],
      });
    }
  });

  test("the runtime validator still rejects other protocols", () => {
    const base = {
      id: "s1",
      display_name: "n",
      topic: "t",
      state: "working",
      line: "l",
      status_at: "2026-01-01T00:00:00Z",
      last_activity_at: "2026-01-01T00:00:00Z",
      stale: false,
      ended_at: null,
      pending_decision_count: 0,
    };
    expect(agentSessionSchema.safeParse({ ...base, link: "https://x.test/a" }).success).toBe(true);
    for (const link of ["ftp://x.test/a", "file:///etc/passwd", "mailto:a@x.test"]) {
      expect(agentSessionSchema.safeParse({ ...base, link }).success, link).toBe(false);
    }
  });
});

describe("determinism", () => {
  test("generates exactly the four spec files", () => {
    expect([...rendered.keys()].sort()).toEqual(SPEC_FILES);
    expect(Object.keys(buildSpecDocuments()).sort()).toEqual(SPEC_FILES);
  });

  test(
    "two renders into separate roots produce identical bytes",
    () => {
      const [a, b] = [join(tempDir(), "spec"), join(tempDir(), "nested", "spec")];
      writeSpec(a, rendered);
      writeSpec(b, renderSpec());
      expect(compareSpecDirs(a, b)).toEqual([]);
      for (const path of SPEC_FILES) {
        expect(readFileSync(join(a, path)).equals(readFileSync(join(b, path))), path).toBe(true);
      }
    },
    SLOW,
  );

  test("output holds no absolute paths or timestamps", () => {
    for (const [path, text] of rendered) {
      expect(text, path).not.toContain(REPO_ROOT);
      expect(text, path).not.toContain(tmpdir());
      expect(text, path).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(text.endsWith("}\n"), path).toBe(true);
      expect(text, path).not.toContain("\r");
    }
  });

  test(
    "Biome formatting is a fixed point",
    () => {
      for (const [path, text] of rendered) {
        expect(formatJson(`spec/${path}`, text), path).toBe(text);
      }
    },
    SLOW,
  );

  test(
    "the committed spec passes biome check",
    () => {
      const result = spawnSync("pnpm", ["exec", "biome", "check", "spec"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
    SLOW,
  );
});

describe("spec comparison", () => {
  function freshSpec(): string {
    const dir = join(tempDir(), "spec");
    writeSpec(dir, rendered);
    return dir;
  }

  test("passes on freshly generated output", () => {
    expect(compareSpecDirs(freshSpec(), freshSpec())).toEqual([]);
  });

  test("fails when one schema file differs, naming it", () => {
    const committedDir = freshSpec();
    const path = join(committedDir, "schemas/decision.schema.json");
    writeFileSync(path, readFileSync(path, "utf8").replace('"maxLength": 120', '"maxLength": 121'));
    expect(compareSpecDirs(committedDir, freshSpec())).toEqual([
      { path: "schemas/decision.schema.json", kind: "changed" },
    ]);
  });

  test("names missing and unexpected files in sorted order", () => {
    const committedDir = freshSpec();
    unlinkSync(join(committedDir, "openapi.json"));
    writeFileSync(join(committedDir, "schemas/extra.schema.json"), "{}\n");
    writeFileSync(join(committedDir, "schemas/agent-session.schema.json"), "{}\n");
    expect(compareSpecDirs(committedDir, freshSpec())).toEqual([
      { path: "openapi.json", kind: "missing" },
      { path: "schemas/agent-session.schema.json", kind: "changed" },
      { path: "schemas/extra.schema.json", kind: "unexpected" },
    ]);
  });

  test("an absent committed directory reports every file missing", () => {
    expect(compareSpecDirs(join(tempDir(), "none"), freshSpec())).toEqual(
      SPEC_FILES.map((path) => ({ path, kind: "missing" })),
    );
  });

  test(
    "checkSpec reads the committed directory and removes its temporary output",
    () => {
      const committedDir = freshSpec();
      const tmpParent = tempDir();
      expect(checkSpec(committedDir, tmpParent)).toEqual([]);
      expect(readdirSync(tmpParent)).toEqual([]);

      const path = join(committedDir, "schemas/webhook-event.schema.json");
      writeFileSync(path, `${readFileSync(path, "utf8")} `);
      const before = readFileSync(path);
      expect(checkSpec(committedDir, tmpParent)).toEqual([
        { path: "schemas/webhook-event.schema.json", kind: "changed" },
      ]);
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(readdirSync(tmpParent)).toEqual([]);
    },
    SLOW,
  );
});
