import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

export const handle = (page: Page, node: string, port: "in" | "out"): Locator =>
  page.getByTestId(`port-${node}-${port}`).locator(".react-flow__handle");

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drag a wire from one port to another with real mouse events; `beforeRelease` runs while hovering the target. */
export async function wire(page: Page, from: Locator, to: Locator, beforeRelease?: () => Promise<void>) {
  const a = await center(from);
  const b = await center(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 8 });
  await page.mouse.move(b.x, b.y, { steps: 8 });
  if (beforeRelease) await beforeRelease();
  await page.mouse.up();
}

/** Drop an asset-browser card onto the canvas at a point relative to the canvas' top-left corner. */
export async function dropCard(page: Page, name: string, x: number, y: number) {
  await page.getByTestId(`card-${name}`).dragTo(page.getByTestId("canvas"), { targetPosition: { x, y } });
}

/** Drop another pipeline's dataset (Datasets tab, Other pipelines) onto the canvas, relative to its top-left corner. */
export async function dropDataset(page: Page, folder: string, name: string, x: number, y: number) {
  await page.getByTestId("tab-datasets").click();
  await page.getByTestId("other-datasets").click();
  await page.getByTestId(`dataset-card-${folder}-${name}`).dragTo(page.getByTestId("canvas"), { targetPosition: { x, y } });
  await page.getByTestId("tab-processors").click();
}

/** Run the demo CLI against the e2e's local GitLab stand-in (like pushing to a processor repo). */
export function demo(...args: string[]) {
  const root = join(process.env.STUDIO_E2E_SCRATCH!, "gitlab");
  execFileSync("uv", ["run", "--project", "../backend", "python", "-m", "foundry_studio.demo", "--root", root, ...args], {
    stdio: "pipe",
  });
}
