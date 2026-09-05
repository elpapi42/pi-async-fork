import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

async function loadRenderer() {
  const directory = await mkdtemp(join(tmpdir(), "pi-async-fork-render-"));
  await writeFile(join(directory, "tui-stub.mjs"), `
    export class Text {
      constructor(text, paddingX, paddingY) { this.text = text; this.paddingX = paddingX; this.paddingY = paddingY; }
      setText(text) { this.text = text; }
    }
    export class Container {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); }
    }
    export class Spacer { constructor(size) { this.size = size; } }
  `);
  const source = await readFile(join(process.cwd(), "src/forks/render.ts"), "utf8");
  await writeFile(join(directory, "render.ts"), source.replace('from "@earendil-works/pi-tui"', 'from "./tui-stub.mjs"'));
  return {
    renderer: await import(`${pathToFileURL(join(directory, "render.ts")).href}?t=${Date.now()}`),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function theme() {
  return { fg: (_color: string, text: string) => text, bold: (text: string) => text };
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
