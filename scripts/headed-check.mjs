#!/usr/bin/env node
/**
 * Headed-browser legibility check: opens a visible Chrome window, visits
 * every visualization (?layout=<id>), and saves a screenshot per layout
 * for human/agent visual review.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5001";
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/topo-shots-headed";
mkdirSync(SHOTS, { recursive: true });

const LAYOUTS = [
  "force",
  "hierarchical",
  "orthogonal",
  "radial",
  "compound",
  "bundled",
  "constraint",
  "community",
  "matrix",
];

const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: false,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

for (const layout of LAYOUTS) {
  const isMatrix = layout === "matrix";
  await page.goto(`${BASE}/?layout=${layout}`, {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page
    .waitForSelector(
      isMatrix
        ? '[data-testid="matrix-viewport"]'
        : '[data-testid="topology-svg"] g.network-node',
      { timeout: 15000 },
    )
    .catch(() => null);
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: `${SHOTS}/${layout}.png` });
  console.log(`shot ${layout}`);
}

console.log("done — leaving browser open for 5s");
await new Promise((r) => setTimeout(r, 5000));
await browser.close();
