import { Type } from "@sinclair/typebox";
import { loadConfiguration, TIERS, type Tier } from "./configuration.js";
import { Controller } from "./forks/controller.js";
import type { ActivityCollection, ActivityEntry } from "./forks/agent.js";
import { RESULT_TYPE } from "./forks/ledger.js";
import { assertForkToolsAvailable, FORK_CHILD_ERROR, isForkChildSession } from "./forks/session.js";
import {
  renderCreateForkCall,
  renderCreateForkResult,
  renderForkResultMessage,
  renderForkStatusCall,
  renderForkStatusResult,
  renderSteerForkCall,
  renderSteerForkResult,
} from "./forks/render.js";

const NAME_DESCRIPTION = "Choose one or two short lowercase letter-only words, separated by one hyphen if there are two. Do not add numbers. The tool adds a generated seven-digit suffix to your name and returns the complete fork ID. Use that returned ID for later calls.";
const TASK_DESCRIPTION = "Describe the focused task you want the fork to complete. State what to do and where the fork's decision authority ends. The fork reports blockers and ambiguities outside that authority instead of resolving them on your behalf.";
const DESCRIPTION_DESCRIPTION = "Summarize the fork's purpose in 3 to 6 words for the user. Describe the work, not the fork mechanics. Example: \"Trace login session validation\".";
const EFFORT_DESCRIPTION = "Choose the fork's reasoning effort. Select it from the primary cognitive job and required reasoning depth. Use the lowest effort that can reliably complete the task. Effort changes reasoning depth, not task scope. Use fast for bounded read-only evidence gathering, including lookups, codebase exploration, documentation or web research, exact checks, inventories, and source or relationship tracing. Fast returns facts and does not make final judgments, recommendations, diagnoses, approval or gate decisions, or changes. Use balanced for bounded judgment or settled execution, including review, plan validation, test interpretation, bounded diagnosis, research synthesis, implementation planning, and scoped changes. Use deep for frontier uncertainty or the hardest reasoning, including novel architecture, unclear root causes, conflicting evidence, difficult security or data analysis, complex system behavior, major product decisions, broad blast radius, and hard-to-reverse choices. If fast evidence needs judgment, use balanced; if it exposes complex uncertainty, use deep. If unsure, use balanced. Deep is expensive and has more reasoning capability than you. Use it only when that additional capability is necessary for the outcome.";
const ID_DESCRIPTION = "Use the complete fork ID returned by create_fork. Do not shorten, modify, or reconstruct it.";
const STATUS_LIMIT_DESCRIPTION = "Optional positive integer. When supplied, return only the latest observed activity entries. Without it, return all observed entries within output limits.";

function activityTimestamp(timestamp: unknown): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "unknown-time";
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return "unknown-time";
  }
}

function activityArgs(entry: ActivityEntry): string {
  try {
    return JSON.stringify(entry.args);
  } catch {
    return "[unserializable args]";
  }
}

function activityEntryText(entry: ActivityEntry): string {
  const timestamp = activityTimestamp(entry.timestamp);
  if (entry.kind === "thinking" || entry.kind === "message") return `${timestamp} ${entry.kind}`;
  const markers = [
    entry.redacted ? "[redacted]" : "",
    entry.truncated ? "[truncated]" : "",
    entry.argsTruncated ? "[source-truncated]" : "",
  ].filter(Boolean).join(" ");
  return `${timestamp} tool ${entry.toolName ?? "unknown"} ${activityArgs(entry)}${markers ? ` ${markers}` : ""}`;
}

function activityText(activity: ActivityCollection): string {
  const lines = ["Observed activity (best effort):"];
  if (activity.entries.length === 0) lines.push("No mapped activity observed.");
  else lines.push(...activity.entries.map(activityEntryText));
  if (activity.stopReason === "deadline") lines.push("Activity collection reached its three-second deadline.");
  if (activity.stopReason === "stream-ended") lines.push("Activity stream ended before the collection window closed.");
  if (activity.stopReason === "error") lines.push("Activity collection encountered an error.");
  if (activity.stopReason === "aborted") lines.push("Activity collection was aborted.");
  if (activity.outputTruncated) lines.push("Activity output was truncated.");
  return lines.join("\n");
}

export default function register(pi: any): void {
  pi.registerMessageRenderer(RESULT_TYPE, renderForkResultMessage);

  let controller: Controller | undefined;
  let unavailable: string | undefined;

  const getController = (ctx: any): Controller => {
    assertForkToolsAvailable(ctx.sessionManager);
    if (unavailable) throw new Error(unavailable);
    if (!controller) {
      try {
        controller = new Controller(pi, loadConfiguration(ctx.cwd));
      } catch (error) {
        unavailable = error instanceof Error ? error.message : String(error);
        throw new Error(unavailable);
      }
    }
    return controller;
  };

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    controller = undefined;
    unavailable = undefined;
    if (isForkChildSession(ctx.sessionManager)) {
      unavailable = FORK_CHILD_ERROR;
      return;
    }
    try {
      controller = new Controller(pi, loadConfiguration(ctx.cwd));
      await controller.start(ctx);
    } catch (error) {
      controller = undefined;
      unavailable = error instanceof Error ? error.message : String(error);
    }
  });

  pi.on("session_before_tree", async () => {
    await controller?.beforeTree();
  });

  pi.on("session_tree", async (_event: unknown, ctx: any) => {
    await controller?.afterTree(ctx);
  });

  pi.on("session_shutdown", async () => {
    await controller?.stop();
    controller = undefined;
  });

  pi.registerTool({
    name: "create_fork",
    label: "Create async fork",
    description: `Create an asynchronous fork for a focused task. You receive the complete fork ID after task acceptance. Progress reports, final reports, or terminal notices arrive as messages. ${NAME_DESCRIPTION}`,
    parameters: Type.Object({
      name: Type.String({ description: NAME_DESCRIPTION }),
      task: Type.String({ description: TASK_DESCRIPTION }),
      description: Type.String({ description: DESCRIPTION_DESCRIPTION }),
      effort: Type.Optional(Type.Union(TIERS.map((effort) => Type.Literal(effort)), { description: EFFORT_DESCRIPTION })),
    }),
    renderCall: renderCreateForkCall,
    renderResult: renderCreateForkResult,
    async execute(toolCallId: string, params: { name: string; task: string; description: string; effort?: Tier }, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const forkId = await getController(ctx).create(ctx, toolCallId, params.name, params.task, params.description, params.effort ?? "balanced", signal);
      return { content: [{ type: "text", text: forkId }], details: { forkId } };
    },
  });

  pi.registerTool({
    name: "steer_fork",
    label: "Steer async fork",
    description: `Send a steering message to an active async fork. ${ID_DESCRIPTION}`,
    parameters: Type.Object({
      forkId: Type.String({ description: ID_DESCRIPTION }),
      message: Type.String({ description: "Write an instruction for the fork's current task." }),
    }),
    renderCall: renderSteerForkCall,
    renderResult: renderSteerForkResult,
    async execute(_toolCallId: string, params: { forkId: string; message: string }, signal: AbortSignal, _onUpdate: any, ctx: any) {
      await getController(ctx).steer(ctx, params.forkId, params.message, signal);
      return { content: [{ type: "text", text: `Steering accepted for ${params.forkId}.` }] };
    },
  });

  pi.registerTool({
    name: "fork_status",
    label: "Async fork status",
    description: `Get the current status of an async fork. For active forks, this also collects an observed activity history through an independent from-start replay. Collection stops after one second without an event or three seconds total, so it is best effort and can take one to three seconds. Activity is unavailable after automatic cleanup. ${ID_DESCRIPTION}`,
    parameters: Type.Object({
      forkId: Type.String({ description: ID_DESCRIPTION }),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: STATUS_LIMIT_DESCRIPTION })),
    }),
    renderCall: renderForkStatusCall,
    renderResult: renderForkStatusResult,
    async execute(_toolCallId: string, params: { forkId: string; limit?: number }, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const status = await getController(ctx).status(ctx, params.forkId, params.limit, signal);
      const text = status.activity ? `${params.forkId}: ${status.state}\n\n${activityText(status.activity)}` : `${params.forkId}: ${status.state}`;
      return {
        content: [{ type: "text", text }],
        details: status.activity ? { ...status, activityText: activityText(status.activity) } : status,
      };
    },
  });
}
