import {
  type AgentSession,
  type Decision,
  decisionInputFieldsSchema,
  type ErrorCode,
  resolveInputSchema,
  statusInputSchema,
  topicInputSchema,
  validateDecisionInput,
} from "@agentdesk/contract";
import { z } from "zod";
import { pollDecision } from "./await.js";
import { type ServiceCall, ServiceError } from "./convex.js";

// component-gateway §Tools. Each tool parses its arguments with the contract
// before any service call, so an invalid call changes nothing (req-agent-tools
// AC-1.3). Parsing drops unknown arguments, and the caller's user and agent
// session are added after parsing, so no argument can name an identity
// (AC-7.2).

const decisionIdSchema = z.string().min(1);

const awaitInputSchema = z.object({
  decision_id: decisionIdSchema,
  timeout_seconds: z.int().min(1).max(600).default(300),
});
const checkInputSchema = z.object({ decision_ids: z.array(decisionIdSchema).min(1).max(50) });
const cancelInputSchema = z.object({ decision_id: decisionIdSchema });
// The contract's status input has no topic; the status tool requires one
// (REQ-8).
const statusToolInputSchema = statusInputSchema.extend({ topic: topicInputSchema });

// The caller every tool acts for, resolved from the credential and the
// `Mcp-Session-Id` header.
export interface ToolCaller {
  userId: string;
  agentSessionId: string;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

interface Tool {
  name: string;
  description: string;
  // Published as the tool's inputSchema.
  schema: z.ZodType;
  // The tool's argument for each service field it renames, such as
  // `decisionId` for `decision_id`. A service refusal names the argument.
  fields?: Readonly<Record<string, string>>;
  // The argument a service `Decision not found` names, for a tool that takes
  // decision ids.
  decisionArgument?: string;
  // `signal` aborts when the client disconnects; only `await` outlives a
  // single service call.
  run(
    svc: ServiceCall,
    caller: ToolCaller,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}

class InvalidArguments extends Error {
  constructor(
    message: string,
    readonly field: string | undefined,
  ) {
    super(message);
  }
}

// Parses with zod and turns the first issue into an error naming its field.
function parse<T>(result: z.ZodSafeParseResult<T>): T {
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const field = issue?.path.map(String).join(".");
  throw new InvalidArguments(issue?.message ?? "Invalid arguments", field || undefined);
}

const TOOLS: Tool[] = [
  {
    name: "ask",
    description:
      "Ask the user for a decision. Returns the decision id at once, without waiting; call await or check for the answer.",
    schema: decisionInputFieldsSchema,
    async run(svc, caller, args) {
      // The full schema adds the cross-field rules, checked at this request's
      // time.
      const input = parse(validateDecisionInput(args, Date.now()));
      const decision = (await svc("decisions/create", { ...input, ...caller })) as Decision;
      // A create is pending; an idempotent replay reports the stored decision's
      // state (req-agent-tools AC-2.2).
      return result({ decision_id: decision.id, state: decision.state });
    },
  },
  {
    name: "await",
    description:
      "Wait until a decision is answered, expires, or is cancelled, or until timeout_seconds elapse.",
    schema: awaitInputSchema,
    fields: { decisionId: "decision_id" },
    decisionArgument: "decision_id",
    async run(svc, caller, args, signal) {
      const input = parse(awaitInputSchema.safeParse(args));
      const decision = await pollDecision(
        svc,
        "decisions/poll",
        { ...caller, decisionId: input.decision_id },
        input.timeout_seconds,
        signal,
      );
      if (decision !== null) {
        // The settled decision with its answer and note (req-agent-tools
        // AC-3.1).
        return result(decision);
      }
      // The limit elapsed; the decision is unchanged (AC-3.2).
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ state: "pending", decision_id: input.decision_id }),
          },
          { type: "text", text: AWAIT_AGAIN },
        ],
        isError: false,
      };
    },
  },
  {
    name: "check",
    description: "Read the current state, answer, and note of up to 50 decisions without waiting.",
    schema: checkInputSchema,
    fields: { decisionIds: "decision_ids" },
    decisionArgument: "decision_ids",
    async run(svc, caller, args) {
      const input = parse(checkInputSchema.safeParse(args));
      const decisions = (await svc("decisions/check", {
        ...caller,
        decisionIds: input.decision_ids,
      })) as Decision[];
      return result({ decisions });
    },
  },
  {
    name: "cancel",
    description: "Cancel a pending decision.",
    schema: cancelInputSchema,
    fields: { decisionId: "decision_id" },
    decisionArgument: "decision_id",
    async run(svc, caller, args) {
      const input = parse(cancelInputSchema.safeParse(args));
      const decision = (await svc("decisions/cancel", {
        ...caller,
        decisionId: input.decision_id,
      })) as Decision;
      return result(decision);
    },
  },
  {
    name: "resolve",
    description:
      "Record an answer the user gave in this chat to a pending decision. Pass the user's message word for word as chat_message. Never record an answer the user did not write.",
    schema: resolveInputSchema,
    fields: { decisionId: "decision_id", chatMessage: "chat_message" },
    decisionArgument: "decision_id",
    async run(svc, caller, args) {
      const input = parse(resolveInputSchema.safeParse(args));
      try {
        // The message goes as received, untrimmed (req-decision-requests
        // AC-8.2).
        const decision = (await svc("decisions/resolve", {
          ...caller,
          decisionId: input.decision_id,
          answer: input.answer,
          chatMessage: input.chat_message,
        })) as Decision;
        return result(decision);
      } catch (caught) {
        if (!(caught instanceof ServiceError) || caught.code !== "conflict") {
          throw caught;
        }
      }
      // The decision is no longer pending. One read gives the agent the
      // recorded state and answer (req-agent-tools AC-9.2); a `not_found`
      // from it passes through instead.
      const decision = (await svc("decisions/poll", {
        ...caller,
        decisionId: input.decision_id,
      })) as Decision;
      return error("conflict", `Decision is already ${decision.state}`, undefined, { decision });
    },
  },
  {
    name: "status",
    description: "Set this agent session's current status line, shown to the user.",
    schema: statusToolInputSchema,
    async run(svc, caller, args) {
      const input = parse(statusToolInputSchema.safeParse(args));
      const session = (await svc("agents/status", { ...input, ...caller })) as AgentSession;
      return result(session);
    },
  },
];

export const AWAIT_AGAIN = "Call await again with the same decision_id";

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// Each tool's top-level argument names, from its published input schema.
const ARGUMENTS = new Map(
  TOOLS.map((tool) => [tool.name, new Set(Object.keys(inputSchema(tool).properties ?? {}))]),
);

function inputSchema(tool: Tool) {
  const { $schema: _, ...schema } = z.toJSONSchema(tool.schema, { io: "input" });
  return schema;
}

// The `tools/list` result: exactly ask, await, check, cancel, resolve, and
// status (req-agent-tools AC-1.2), with input schemas generated from the contract.
export function listTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: inputSchema(tool),
  }));
}

export function hasTool(name: string): boolean {
  return BY_NAME.has(name);
}

// Runs one tool. Invalid arguments and service errors become tool results with
// `isError: true` carrying the contract error body. A service error keeps its
// code, so `not_found` for another user's decision reads as for a missing one
// (AC-7.1), and its field names the tool's own argument. An UpstreamError
// propagates to the transport.
export async function callTool(
  svc: ServiceCall,
  caller: ToolCaller,
  name: string,
  args: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<ToolResult> {
  const tool = BY_NAME.get(name);
  if (tool === undefined) {
    throw new Error(`Unknown tool ${name}`);
  }
  try {
    return await tool.run(svc, caller, args ?? {}, signal);
  } catch (caught) {
    if (caught instanceof InvalidArguments) {
      return error("invalid", caught.message, caught.field);
    }
    if (caught instanceof ServiceError) {
      const refusal = publicServiceError(
        caught,
        tool.fields ?? {},
        ARGUMENTS.get(name) ?? new Set(),
        tool.decisionArgument,
      );
      return error(refusal.code, refusal.message, refusal.field);
    }
    throw caught;
  }
}

export interface PublicError {
  code: ErrorCode;
  message: string;
  field?: string;
}

// Service fields the gateway fills in from the credential and the session. No
// tool takes one as an argument, so a refusal on one names no field.
const CALLER_FIELDS: Readonly<Record<string, string>> = {
  userId: "The connection's user could not be resolved",
  credentialId: "The connection could not be resolved",
  agentSessionId: "This MCP session could not be resolved; initialize a new session",
};

// Service fields that carry decision ids. Convex refuses a malformed one with
// `Invalid <field>` (convex/decisions/model.ts#parseId).
const DECISION_ID_FIELDS = new Set(["decisionId", "decisionIds"]);

const DECISION_NOT_FOUND = "Decision not found";

// Restates a service error in the caller's terms. `fields` renames service
// fields to arguments; a field already named as an argument stays. A caller
// field, or one the caller never sent, is left out, and a message about a
// field the caller never sent is replaced, so no Convex argument name reaches
// the caller. The code never changes.
export function publicServiceError(
  error: ServiceError,
  fields: Readonly<Record<string, string>>,
  args: ReadonlySet<string>,
  decisionArgument?: string,
): PublicError {
  const { code, message, field } = error;
  if (field === undefined) {
    // Convex names no field for a missing or foreign decision.
    return code === "not_found" && message === DECISION_NOT_FOUND && decisionArgument !== undefined
      ? { code, message, field: decisionArgument }
      : { code, message };
  }
  const [head = "", ...rest] = field.split(".");
  const callerMessage = CALLER_FIELDS[head];
  if (callerMessage !== undefined) {
    return { code, message: callerMessage };
  }
  const renamed = fields[head];
  if (renamed !== undefined) {
    if (DECISION_ID_FIELDS.has(head)) {
      // `decisionIds.3` names the fourth of `decision_ids`; the field names
      // the argument and the message names the member.
      const member = rest.length === 0 ? renamed : `${renamed}[${rest.join(".")}]`;
      return {
        code,
        message:
          message === `Invalid ${field}`
            ? `${member} is not a valid decision id`
            : message.replaceAll(head, renamed),
        field: renamed,
      };
    }
    return {
      code,
      message: message.replaceAll(head, renamed),
      field: [renamed, ...rest].join("."),
    };
  }
  if (args.has(head)) {
    return { code, message, field };
  }
  return { code, message: "AgentDesk refused the request" };
}

function result(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
}

// `extra` adds top-level fields beside the error, such as the stored decision
// a `resolve` conflict carries.
function error(
  code: ErrorCode,
  message: string,
  field?: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  const body = {
    error: field === undefined ? { code, message } : { code, message, field },
    ...extra,
  };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}
