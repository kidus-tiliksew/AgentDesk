import {
  type AgentSession,
  type Decision,
  decisionInputFieldsSchema,
  type ErrorCode,
  statusInputSchema,
  topicInputSchema,
  validateDecisionInput,
} from "@agentdesk/contract";
import { z } from "zod";
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
  run(svc: ServiceCall, caller: ToolCaller, args: unknown): Promise<ToolResult>;
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
    async run(_svc, _caller, args) {
      parse(awaitInputSchema.safeParse(args));
      // The poll loop and its event stream arrive in the next gateway slice.
      return {
        content: [
          { type: "text", text: "await is not available yet; call check to read the decision" },
        ],
        isError: true,
      };
    },
  },
  {
    name: "check",
    description: "Read the current state, answer, and note of up to 50 decisions without waiting.",
    schema: checkInputSchema,
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

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// The `tools/list` result: exactly ask, await, check, cancel, and status
// (req-agent-tools AC-1.2), with input schemas generated from the contract.
export function listTools() {
  return TOOLS.map((tool) => {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(tool.schema, { io: "input" });
    return { name: tool.name, description: tool.description, inputSchema };
  });
}

export function hasTool(name: string): boolean {
  return BY_NAME.has(name);
}

// Runs one tool. Invalid arguments and service errors become tool results with
// `isError: true` carrying the contract error body, so `not_found` for another
// user's decision passes through unchanged (AC-7.1). An UpstreamError
// propagates to the transport.
export async function callTool(
  svc: ServiceCall,
  caller: ToolCaller,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const tool = BY_NAME.get(name);
  if (tool === undefined) {
    throw new Error(`Unknown tool ${name}`);
  }
  try {
    return await tool.run(svc, caller, args ?? {});
  } catch (caught) {
    if (caught instanceof InvalidArguments) {
      return error("invalid", caught.message, caught.field);
    }
    if (caught instanceof ServiceError) {
      return error(caught.code, caught.message, caught.field);
    }
    throw caught;
  }
}

function result(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
}

function error(code: ErrorCode, message: string, field?: string): ToolResult {
  const body = { error: field === undefined ? { code, message } : { code, message, field } };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}
