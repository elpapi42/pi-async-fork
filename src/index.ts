import { Type } from "@sinclair/typebox";
import { loadConfiguration, TIERS, type Tier } from "./configuration.js";
import { Controller } from "./forks/controller.js";

const NAME_DESCRIPTION = "Choose one or two short lowercase letter-only words, separated by one hyphen if there are two. Do not add numbers. The tool appends a generated seven-digit suffix and returns the complete fork ID. Use that returned ID for later calls.";
const ID_DESCRIPTION = "Use the complete fork ID returned by create_fork. Do not shorten, modify, or reconstruct it.";

export default function register(pi: any): void {
  let controller: Controller | undefined;
  let unavailable: string | undefined;

  const getController = (ctx: any): Controller => {
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
    description: `Create a durable asynchronous fork and return its ID immediately. ${NAME_DESCRIPTION}`,
    parameters: Type.Object({
      name: Type.String({ description: NAME_DESCRIPTION }),
      task: Type.String({ description: "Bounded work for the fork." }),
      tier: Type.Optional(Type.Union(TIERS.map((tier) => Type.Literal(tier)))),
    }),
    async execute(toolCallId: string, params: { name: string; task: string; tier?: Tier }, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const forkId = await getController(ctx).create(ctx, toolCallId, params.name, params.task, params.tier ?? "balanced", signal);
      return { content: [{ type: "text", text: forkId }], details: { forkId } };
    },
  });

  pi.registerTool({
    name: "steer_fork",
    label: "Steer async fork",
    description: `Send a steering message to an active async fork. ${ID_DESCRIPTION}`,
    parameters: Type.Object({
      forkId: Type.String({ description: ID_DESCRIPTION }),
      message: Type.String({ description: "Follow-up work or steering instruction." }),
    }),
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
    async execute(_toolCallId: string, params: { forkId: string }, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const status = await getController(ctx).status(ctx, params.forkId);
      return { content: [{ type: "text", text: `${params.forkId}: ${status.state}` }], details: status };
    },
  });
}
