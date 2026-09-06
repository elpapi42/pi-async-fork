import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

async function loadRenderer() {
  const directory = await mkdtemp(join(tmpdir(), "pi-async-fork-render-"));
  await writeFile(join(directory, "coding-agent-stub.mjs"), "export function getMarkdownTheme() { return {}; }\n");
  await writeFile(join(directory, "tui-stub.mjs"), `
    export class Text {
      constructor(text, paddingX, paddingY) { this.text = text; this.paddingX = paddingX; this.paddingY = paddingY; }
      setText(text) { this.text = text; }
    }
    export class Container {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); }
    }
    export class Box extends Container {
      constructor(paddingX, paddingY, bgFn) { super(); this.paddingX = paddingX; this.paddingY = paddingY; this.bgFn = bgFn; }
    }
    export class Spacer { constructor(size) { this.size = size; } }
    export class Markdown { constructor(text, paddingX, paddingY, theme, options) { this.text = text; this.paddingX = paddingX; this.paddingY = paddingY; this.theme = theme; this.options = options; } }
  `);
  const source = await readFile(join(process.cwd(), "src/forks/render.ts"), "utf8");
  await writeFile(join(directory, "identity.ts"), await readFile(join(process.cwd(), "src/forks/identity.ts"), "utf8"));
  await writeFile(
    join(directory, "render.ts"),
    source
      .replace('from "@earendil-works/pi-coding-agent"', 'from "./coding-agent-stub.mjs"')
      .replace('from "@earendil-works/pi-tui"', 'from "./tui-stub.mjs"'),
  );
  return {
    renderer: await import(`${pathToFileURL(join(directory, "render.ts")).href}?t=${Date.now()}`),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function theme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function text(component: any): string {
  if (typeof component?.text === "string") return component.text;
  return Array.isArray(component?.children) ? component.children.map(text).filter(Boolean).join("\n") : "";
}

test("renders pending and completed fork IDs in the call line", async () => {
  const { renderer, cleanup } = await loadRenderer();
  try {
    const state: Record<string, unknown> = {};
    const pending = renderer.renderCreateForkCall({ name: "review", description: "Review active authorization rules", effort: "fast" }, theme(), { state });
    assert.equal(text(pending), "create_fork [fast] review-… · Review active authorization rules");

    renderer.renderCreateForkResult(
      { content: [], details: { forkId: "review-1234567" } },
      { expanded: false },
      theme(),
      { state, args: { name: "review", description: "Review active authorization rules", effort: "fast" }, isError: false, invalidate: () => { throw new Error("must not invalidate while rendering"); } },
    );
    assert.equal(text(pending), "create_fork [fast] review-1234567 · Review active authorization rules");
    const completed = renderer.renderCreateForkCall({ name: "review", description: "Review active authorization rules", effort: "fast" }, theme(), { state, lastComponent: pending });
    assert.equal(text(completed), "create_fork [fast] review-1234567 · Review active authorization rules");
    assert.equal(text(renderer.renderCreateForkCall({ name: "review", tier: "fast" }, theme(), { state: {} })), "create_fork [fast] review-…");
  } finally {
    await cleanup();
  }
});

test("renders fork result messages without duplicating the fork ID", async () => {
  const { renderer, cleanup } = await loadRenderer();
  try {
    const colors: string[] = [];
    const renderTheme = {
      ...theme(),
      fg: (color: string, text: string) => { colors.push(color); return text; },
      bg: (color: string, text: string) => { colors.push(color); return text; },
    };
    const progress = renderer.renderForkResultMessage(
      { content: "research-1234567:\n\nThis is an intermediate progress report. The fork is still working and can receive steering.\n\nProgress with `code`.", details: { forkId: "research-1234567", kind: "progress", description: "Trace login session validation" } },
      { expanded: true, outputPad: 2 },
      renderTheme,
    );
    assert.equal(text(progress), "● fork research-1234567 · Trace login session validation: working\nProgress with `code`.");

    const response = renderer.renderForkResultMessage(
      { content: "research-1234567:\n\nThis is the final report. The fork finished and can no longer receive steering. Treat this report as an internal work event. Do not write user-visible text only because it arrived.\n\nResult with `code`.", details: { forkId: "research-1234567", kind: "response", description: "Trace login session validation" } },
      { expanded: true, outputPad: 2 },
      renderTheme,
    );
    assert.equal(text(response), "✓ fork research-1234567 · Trace login session validation: completed\nResult with `code`.");
    assert.equal(response.paddingX, 1);
    assert.equal(response.paddingY, 1);
    assert.equal(response.bgFn("panel"), "panel");
    assert.equal(response.children[2].options.color("body"), "body");
    assert.ok(colors.includes("customMessageBg"));
    assert.ok(colors.includes("customMessageText"));

    const collapsed = renderer.renderForkResultMessage(
      { content: "research-1234567:\n\nThis is the final report. The fork finished and can no longer receive steering. Treat this report as an internal work event. Do not write user-visible text only because it arrived.\n\nHidden result.", details: { forkId: "research-1234567", kind: "response", description: "Trace login session validation" } },
      { expanded: false, outputPad: 2 },
      theme(),
    );
    assert.equal(text(collapsed), "✓ fork research-1234567 · Trace login session validation: completed");
    assert.equal(collapsed.children.length, 1);

    const notice = renderer.renderForkResultMessage(
      { content: "research-1234567:\n\nThis is a terminal notice. The fork finished and can no longer receive steering. Treat this notice as an internal work event. Do not write user-visible text only because it arrived.\n\nNo final response.", details: { forkId: "research-1234567", kind: "notice", description: "Trace login session validation" } },
      { expanded: true },
      theme(),
    );
    assert.equal(text(notice), "⚠ fork research-1234567 · Trace login session validation: terminal\nNo final response.");

    const legacyResponse = renderer.renderForkResultMessage(
      { content: "research-1234567:\n\nThis is the final report. The fork finished and can no longer receive steering.\n\nHistorical response.", details: { forkId: "research-1234567", kind: "response" } },
      { expanded: true },
      theme(),
    );
    assert.equal(text(legacyResponse), "✓ fork research-1234567: completed\nHistorical response.");

    const legacyNotice = renderer.renderForkResultMessage(
      { content: "research-1234567:\n\nThis is a terminal notice. The fork can no longer receive steering.\n\nHistorical notice.", details: { forkId: "research-1234567", kind: "notice" } },
      { expanded: true },
      theme(),
    );
    assert.equal(text(legacyNotice), "⚠ fork research-1234567: terminal\nHistorical notice.");

    const legacy = renderer.renderForkResultMessage(
      { content: "research-1234567:\n\nLegacy result.", details: { forkId: "research-1234567" } },
      { expanded: true },
      theme(),
    );
    assert.equal(text(legacy), "• fork research-1234567\nLegacy result.");
  } finally {
    await cleanup();
  }
});

test("renders steering and status calls without successful result output", async () => {
  const { renderer, cleanup } = await loadRenderer();
  try {
    const steerState: Record<string, unknown> = {};
    const steerCall = renderer.renderSteerForkCall({ forkId: "review-1234567" }, theme(), { state: steerState });
    assert.equal(text(steerCall), "steer_fork review-1234567");
    assert.equal(
      text(renderer.renderSteerForkResult({ content: [{ type: "text", text: "Steering accepted." }] }, { expanded: false }, theme(), { state: steerState, isError: false, invalidate() {} })),
      "",
    );
    const expandedSteer = renderer.renderSteerForkResult(
      { content: [] },
      { expanded: true },
      theme(),
      { state: steerState, args: { message: "Inspect the controller first." }, isError: false, invalidate() {} },
    );
    assert.equal(expandedSteer.children[0].size, 1);
    assert.equal(text(expandedSteer), "─── Message ───\nInspect the controller first.");
    assert.equal(
      text(renderer.renderSteerForkResult({ content: [{ type: "text", text: "Fork is not active." }] }, { expanded: false }, theme(), { state: steerState, isError: true, invalidate() {} })),
      "Fork is not active.",
    );

    const statusState: Record<string, unknown> = {};
    const pendingStatus = renderer.renderForkStatusCall({ forkId: "review-1234567" }, theme(), { state: statusState });
    assert.equal(text(pendingStatus), "fork_status review-1234567");
    renderer.renderForkStatusResult(
      { content: [{ type: "text", text: "review-1234567: working" }], details: { state: "working" } },
      { expanded: false },
      theme(),
      { state: statusState, args: { forkId: "review-1234567" }, isError: false, invalidate: () => { throw new Error("must not invalidate while rendering"); } },
    );
    assert.equal(text(pendingStatus), "fork_status review-1234567: working");
    assert.equal(text(renderer.renderForkStatusCall({ forkId: "review-1234567" }, theme(), { state: statusState })), "fork_status review-1234567: working");
    assert.equal(
      text(renderer.renderForkStatusResult({ content: [{ type: "text", text: "Not found." }] }, { expanded: false }, theme(), { state: statusState, isError: true, invalidate() {} })),
      "Not found.",
    );
  } finally {
    await cleanup();
  }
});

test("uses semantic theme colors for fork status states", async () => {
  const { renderer, cleanup } = await loadRenderer();
  try {
    const colorTheme = {
      ...theme(),
      fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
    };
    const mappings = [
      ["completed", "success"],
      ["working", "accent"],
      ["starting", "warning"],
      ["idle", "warning"],
      ["interrupted", "error"],
      ["failed", "error"],
      ["future-state", "muted"],
    ];
    for (const [state, color] of mappings) {
      const call = renderer.renderForkStatusCall(
        { forkId: "review-1234567" },
        colorTheme,
        { state: { status: state } },
      );
      assert.match(text(call), new RegExp(`<${color}>${state}</${color}>$`));
    }
  } finally {
    await cleanup();
  }
});

test("renders one expanded task without reentrant invalidation and keeps creation errors visible", async () => {
  const { renderer, cleanup } = await loadRenderer();
  try {
    const state: Record<string, unknown> = {};
    const call = renderer.renderCreateForkCall({ name: "review", description: "Inspect fork controller lifecycle", effort: "fast" }, theme(), { state });
    const expanded = renderer.renderCreateForkResult(
      { content: [{ type: "text", text: "review-1234567" }], details: { forkId: "review-1234567" } },
      { expanded: true },
      theme(),
      {
        state,
        args: { name: "review", description: "Inspect fork controller lifecycle", effort: "fast", task: "Inspect the controller." },
        isError: false,
        invalidate: () => { throw new Error("must not invalidate while rendering"); },
      },
    );
    assert.equal(text(call), "create_fork [fast] review-1234567 · Inspect fork controller lifecycle");
    assert.equal(expanded.children[0].size, 1);
    assert.equal(text(expanded), "─── Task ───\nInspect the controller.");

    const failure = renderer.renderCreateForkResult(
      { content: [{ type: "text", text: "Missing configuration." }] },
      { expanded: false },
      theme(),
      { state, isError: true, invalidate: () => {} },
    );
    assert.equal(text(failure), "Missing configuration.");
  } finally {
    await cleanup();
  }
});
