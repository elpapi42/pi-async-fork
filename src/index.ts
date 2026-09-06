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

const NAME_DESCRIPTION = "Choose one or two short lowercase letter-only words, separated by one hyphen if there are two. Do not add numbers. The tool adds a generated seven-digit suffix to your name and returns the complete fork ID. Use that returned ID for later calls.";
const TASK_DESCRIPTION = "Describe the focused task you want the fork to complete. State what to do and where the fork's decision authority ends. The fork reports blockers and ambiguities outside that authority instead of resolving them on your behalf.";
const DESCRIPTION_DESCRIPTION = "Summarize the fork's purpose in 3 to 6 words for the user. Describe the work, not the fork mechanics. Example: \"Trace login session validation\".";
const EFFORT_DESCRIPTION = "Choose the fork's reasoning effort. Select it from the primary cognitive job and required reasoning depth. Use the lowest effort that can reliably complete the task. Effort changes reasoning depth, not task scope. Use fast for bounded read-only evidence gathering, including lookups, codebase exploration, documentation or web research, exact checks, inventories, and source or relationship tracing. Fast returns facts and does not make final judgments, recommendations, diagnoses, approval or gate decisions, or changes. Use balanced for bounded judgment or settled execution, including review, plan validation, test interpretation, bounded diagnosis, research synthesis, implementation planning, and scoped changes. Use deep for frontier uncertainty or the hardest reasoning, including novel architecture, unclear root causes, conflicting evidence, difficult security or data analysis, complex system behavior, major product decisions, broad blast radius, and hard-to-reverse choices. If fast evidence needs judgment, use balanced; if it exposes complex uncertainty, use deep. If unsure, use balanced. Deep is expensive and has more reasoning capability than you. Use it only when that additional capability is necessary for the outcome.";
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
