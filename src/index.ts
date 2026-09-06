import { Type } from "@sinclair/typebox";
import { loadConfiguration, TIERS, type Tier } from "./configuration.js";
import { Controller } from "./forks/controller.js";
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

const NAME_DESCRIPTION = "Choose one or two short lowercase letter-only words, separated by one hyphen if there are two. Do not add numbers. The tool appends a generated seven-digit suffix and returns the complete fork ID. Use that returned ID for later calls.";
const TASK_DESCRIPTION = "The focused task for the fork. State what to do and where the fork's decision authority ends. The fork reports blockers and ambiguities outside that authority instead of resolving them on your behalf.";
const EFFORT_DESCRIPTION = "Optional reasoning effort. Use the lowest effort that can reliably handle the task: fast for quick lookups, simple checks, or narrow validation; balanced for normal exploration, implementation, and testing; deep for ambiguous debugging, architecture or design decisions, security or concurrency analysis, high-risk reviews, or tasks where subtle mistakes are costly. If unsure, use balanced.";
const ID_DESCRIPTION = "Use the complete fork ID returned by create_fork. Do not shorten, modify, or reconstruct it.";

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
    description: `Create an asynchronous fork for a focused task. It returns the complete fork ID after task acceptance. Progress reports, final reports, or terminal notices arrive as messages. ${NAME_DESCRIPTION}`,
    parameters: Type.Object({
      name: Type.String({ description: NAME_DESCRIPTION }),
      task: Type.String({ description: TASK_DESCRIPTION }),
      effort: Type.Optional(Type.Union(TIERS.map((effort) => Type.Literal(effort)), { description: EFFORT_DESCRIPTION })),
    }),
    renderCall: renderCreateForkCall,
    renderResult: renderCreateForkResult,
    async execute(toolCallId: string, params: { name: string; task: string; effort?: Tier }, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const forkId = await getController(ctx).create(ctx, toolCallId, params.name, params.task, params.effort ?? "balanced", signal);
      return { content: [{ type: "text", text: forkId }], details: { forkId } };
    },
  });

  pi.registerTool({
    name: "steer_fork",
    label: "Steer async fork",
    description: `Send a steering message to an active async fork. ${ID_DESCRIPTION}`,
    parameters: Type.Object({
      forkId: Type.String({ description: ID_DESCRIPTION }),
      message: Type.String({ description: "Instruction for the fork's current task." }),
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
    description: `Get the current status of an async fork. ${ID_DESCRIPTION}`,
    parameters: Type.Object({ forkId: Type.String({ description: ID_DESCRIPTION }) }),
    renderCall: renderForkStatusCall,
    renderResult: renderForkStatusResult,
    async execute(_toolCallId: string, params: { forkId: string }, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const status = await getController(ctx).status(ctx, params.forkId);
      return { content: [{ type: "text", text: `${params.forkId}: ${status.state}` }], details: status };
    },
  });
}
