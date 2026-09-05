import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

type RenderContext = {
  args?: { name?: unknown; tier?: unknown; task?: unknown };
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

function callText(args: RenderContext["args"], forkId: unknown, theme: any): string {
  const tier = typeof args?.tier === "string" ? args.tier : "balanced";
  const id = typeof forkId === "string" ? forkId : pendingId(args);
  return `${theme.fg("toolTitle", theme.bold("fork"))} ${theme.fg("muted", `[${tier}]`)} ${theme.fg("accent", id)}`;
}

function resultBody(content: unknown, forkId: unknown): string {
  if (typeof content !== "string") return "";
  if (typeof forkId !== "string") return content;
  const prefix = `${forkId}:\n\n`;
  return content.startsWith(prefix) ? content.slice(prefix.length) : content;
}

export function renderForkResultMessage(message: any, { outputPad = 0 }: { outputPad?: number }, theme: any) {
  const forkId = typeof message?.details?.forkId === "string" ? message.details.forkId : "unknown";
  const kind = message?.details?.kind;
  const icon = kind === "response"
    ? theme.fg("success", "✓")
    : kind === "notice"
      ? theme.fg("warning", "⚠")
      : theme.fg("muted", "•");
  const header = `${icon} ${theme.fg("toolTitle", theme.bold("fork"))} ${theme.fg("accent", forkId)}`;
  const container = new Container();
  container.addChild(new Text(header, outputPad, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Markdown(resultBody(message?.content, message?.details?.forkId), outputPad, 0, getMarkdownTheme()));
  return container;
}

export function renderCreateForkCall(args: any, theme: any, context: RenderContext) {
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  component.setText(callText(args, context.state.forkId, theme));
  return component;
}

export function renderCreateForkResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: RenderContext) {
  const forkId = result?.details?.forkId;
  if (!context.isError && typeof forkId === "string" && context.state.forkId !== forkId) {
    context.state.forkId = forkId;
    context.invalidate();
  }

  const output = textContent(result);
  if (context.isError) return new Text(theme.fg("error", output || "Fork creation failed."), 0, 0);
  if (!expanded) return new Container();

  const task = typeof context.args?.task === "string" ? context.args.task : "";
  if (!task) return new Container();
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
  container.addChild(new Text(theme.fg("dim", task), 0, 0));
  return container;
}
