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
    const pending = renderer.renderCreateForkCall({ name: "review", tier: "fast" }, theme(), { state });
    assert.equal(text(pending), "fork [fast] review-…");

    let invalidations = 0;
    renderer.renderCreateForkResult(
      { content: [], details: { forkId: "review-1234567" } },
      { expanded: false },
      theme(),
      { state, isError: false, invalidate: () => { invalidations += 1; } },
    );
    const completed = renderer.renderCreateForkCall({ name: "review", tier: "fast" }, theme(), { state, lastComponent: pending });
    assert.equal(text(completed), "fork [fast] review-1234567");
    renderer.renderCreateForkResult(
      { content: [], details: { forkId: "review-1234567" } },
      { expanded: false },
      theme(),
      { state, isError: false, invalidate: () => { invalidations += 1; } },
    );
    assert.equal(invalidations, 1);
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
    const response = renderer.renderForkResultMessage(
      { content: "research-1234567:\n\nResult with `code`.", details: { forkId: "research-1234567", kind: "response" } },
      { outputPad: 2 },
      renderTheme,
    );
    assert.equal(text(response), "✓ fork research-1234567\nResult with `code`.");
    assert.equal(response.paddingX, 1);
    assert.equal(response.paddingY, 1);
    assert.equal(response.bgFn("panel"), "panel");
    assert.equal(response.children[2].options.color("body"), "body");
    assert.ok(colors.includes("customMessageBg"));
    assert.ok(colors.includes("customMessageText"));

    const notice = renderer.renderForkResultMessage(
      { content: "research-1234567:\n\nNo final response.", details: { forkId: "research-1234567", kind: "notice" } },
      {},
      theme(),
    );
    assert.equal(text(notice), "⚠ fork research-1234567\nNo final response.");

    const legacy = renderer.renderForkResultMessage(
      { content: "research-1234567:\n\nLegacy result.", details: { forkId: "research-1234567" } },
      {},
      theme(),
    );
    assert.equal(text(legacy), "• fork research-1234567\nLegacy result.");
  } finally {
    await cleanup();
  }
});

test("renders the task only when expanded and keeps creation errors visible", async () => {
  const { renderer, cleanup } = await loadRenderer();
  try {
    const state: Record<string, unknown> = {};
    const collapsed = renderer.renderCreateForkResult(
      { content: [{ type: "text", text: "review-1234567" }], details: { forkId: "review-1234567" } },
      { expanded: false },
      theme(),
      { state, isError: false, invalidate: () => {} },
    );
    assert.equal(text(collapsed), "");

    const expanded = renderer.renderCreateForkResult(
      { content: [], details: { forkId: "review-1234567" } },
      { expanded: true },
      theme(),
      { state, args: { task: "Inspect the controller." }, isError: false, invalidate: () => {} },
    );
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
