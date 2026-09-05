import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

type RenderContext = {
  args?: { name?: unknown; tier?: unknown; task?: unknown; forkId?: unknown; message?: unknown };
  state: Record<string, unknown>;
  lastComponent?: unknown;
  isError?: boolean;
  invalidate: () => void;
};

function textContent(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function pendingId(args: RenderContext["args"]): string {
  const name = typeof args?.name === "string" && args.name.trim() ? args.name.trim() : "fork";
  return `${name}-…`;
}

function createCallText(args: RenderContext["args"], forkId: unknown, theme: any): string {
  const tier = typeof args?.tier === "string" ? args.tier : "balanced";
  const id = typeof forkId === "string" ? forkId : pendingId(args);
  return `${theme.fg("toolTitle", theme.bold("create_fork"))} ${theme.fg("muted", `[${tier}]`)} ${theme.fg("accent", id)}`;
}

function forkId(args: RenderContext["args"]): string {
  return typeof args?.forkId === "string" ? args.forkId : "unknown";
}

function section(title: string, body: unknown): Container {
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(title, 0, 0));
  container.addChild(new Text(typeof body === "string" ? body : "", 0, 0));
  return container;
}

function statusColor(state: string, theme: any): string {
  if (state === "completed") return theme.fg("success", state);
  if (state === "working") return theme.fg("accent", state);
  if (state === "starting" || state === "idle") return theme.fg("warning", state);
  if (state === "interrupted" || state === "failed") return theme.fg("error", state);
  return theme.fg("muted", state);
}

function resultBody(content: unknown, forkId: unknown): string {
  if (typeof content !== "string") return "";
  if (typeof forkId !== "string") return content;
  const prefix = `${forkId}:\n\n`;
  return content.startsWith(prefix) ? content.slice(prefix.length) : content;
}

export function renderForkResultMessage(message: any, { expanded }: { expanded: boolean; outputPad?: number }, theme: any) {
  const forkId = typeof message?.details?.forkId === "string" ? message.details.forkId : "unknown";
  const kind = message?.details?.kind;
  const icon = kind === "response"
    ? theme.fg("success", "✓")
    : kind === "notice"
      ? theme.fg("warning", "⚠")
      : theme.fg("muted", "•");
  const header = `${icon} ${theme.fg("toolTitle", theme.bold("fork"))} ${theme.fg("accent", forkId)}`;
  const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
  box.addChild(new Text(header, 0, 0));
  if (expanded) {
    box.addChild(new Spacer(1));
    box.addChild(new Markdown(
      resultBody(message?.content, message?.details?.forkId),
      0,
      0,
      getMarkdownTheme(),
      { color: (text: string) => theme.fg("customMessageText", text) },
    ));
  }
  return box;
}

export function renderCreateForkCall(args: any, theme: any, context: RenderContext) {
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  context.state.createCallComponent = component;
  component.setText(createCallText(args, context.state.forkId, theme));
  return component;
}

export function renderCreateForkResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: RenderContext) {
  const id = result?.details?.forkId;
  if (!context.isError && typeof id === "string" && context.state.forkId !== id) {
    context.state.forkId = id;
    const callComponent = context.state.createCallComponent;
    if (callComponent instanceof Text) callComponent.setText(createCallText(context.args, id, theme));
  }

  const output = textContent(result);
  if (context.isError) return new Text(theme.fg("error", output || "Fork creation failed."), 0, 0);
  if (!expanded || typeof context.args?.task !== "string") return new Container();
  return section(theme.fg("muted", "─── Task ───"), theme.fg("dim", context.args.task));
}

export function renderSteerForkCall(args: any, theme: any, _context: RenderContext) {
  return new Text(`${theme.fg("toolTitle", theme.bold("steer_fork"))} ${theme.fg("accent", forkId(args))}`, 0, 0);
}

export function renderSteerForkResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: RenderContext) {
  const output = textContent(result);
  if (context.isError) return new Text(theme.fg("error", output || "Fork steering failed."), 0, 0);
  if (!expanded || typeof context.args?.message !== "string") return new Container();
  return section(theme.fg("muted", "─── Message ───"), theme.fg("dim", context.args.message));
}

export function renderForkStatusCall(args: any, theme: any, context: RenderContext) {
  const state = typeof context.state.status === "string" ? `: ${statusColor(context.state.status, theme)}` : "";
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  context.state.statusCallComponent = component;
  component.setText(`${theme.fg("toolTitle", theme.bold("fork_status"))} ${theme.fg("accent", forkId(args))}${state}`);
  return component;
}

export function renderForkStatusResult(result: any, _options: { expanded: boolean }, theme: any, context: RenderContext) {
  const state = result?.details?.state;
  if (!context.isError && typeof state === "string" && context.state.status !== state) {
    context.state.status = state;
    const callComponent = context.state.statusCallComponent;
    if (callComponent instanceof Text) {
      callComponent.setText(`${theme.fg("toolTitle", theme.bold("fork_status"))} ${theme.fg("accent", forkId(context.args))}: ${statusColor(state, theme)}`);
    }
  }
  const output = textContent(result);
  if (context.isError) return new Text(theme.fg("error", output || "Fork status failed."), 0, 0);
  return new Container();
}
