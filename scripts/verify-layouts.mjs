#!/usr/bin/env node
/**
 * Headless-browser verification for the topology visualizations.
 *
 * For every layout (?layout=<id>) it loads the dashboard in headless
 * Chrome and checks:
 *   1. No visible SVG text overlaps any other visible SVG text
 *      (glyphs drawn *inside* nodes carry data-inside="true" and are
 *      white-on-solid-fill by design, so they are excluded).
 *   2. No visible SVG text overlaps any node disc.
 *   3. Pan (background drag) and zoom (wheel) actually change the view
 *      transform — for graph modes and the matrix alike.
 *   4. Saves a screenshot per layout for human review.
 *
 * Usage: BASE_URL=http://localhost:5099 node scripts/verify-layouts.mjs
 * Exit code is non-zero when any check fails.
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5099";
const SHOTS =
  process.env.SHOTS_DIR ?? "/tmp/topo-shots";
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
// Modes where we additionally flip the "aggregate edges" switch on and
// re-scan, so badge pills are exercised outside community auto-aggregation.
const AGGREGATE_EXTRA = new Set(["force", "compound"]);

const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function overlapArea(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

async function scanOverlaps(page, isMatrix) {
  return page.evaluate((isMatrix) => {
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    if (isMatrix) {
      // Measure individual text nodes (via Range) so color-swatch spans
      // (no text) can't produce false overlaps with their own labels.
      const texts = [];
      const root = document.querySelector('[data-testid="matrix-viewport"]');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.textContent ?? "").trim();
        if (!t) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        texts.push({
          t: t.slice(0, 40),
          kind: n.parentElement?.tagName ?? "?",
          r: { x: r.x, y: r.y, w: r.width, h: r.height },
        });
      }
      return { texts, discs: [] };
    }
    const texts = [...document.querySelectorAll('[data-testid="topology-svg"] text')]
      .filter((el) => !el.hasAttribute("data-inside"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0.5 && r.height > 0.5;
      })
      .map((el) => ({
        t: (el.textContent ?? "").trim().slice(0, 40),
        kind: el.getAttribute("data-label") ?? "?",
        r: rectOf(el),
      }));
    const discs = [...document.querySelectorAll('[data-testid="topology-svg"] g.network-node circle')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => rectOf(el));
    return { texts, discs };
  }, isMatrix);
}

function findViolations({ texts, discs }, eps = 2) {
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const area = overlapArea(texts[i].r, texts[j].r);
      if (area > eps)
        out.push(
          `TEXT/TEXT "${texts[i].t}"[${texts[i].kind}] ↔ "${texts[j].t}"[${texts[j].kind}] area=${area.toFixed(1)}`,
        );
    }
    for (let k = 0; k < discs.length; k++) {
      const area = overlapArea(texts[i].r, discs[k]);
      if (area > eps)
        out.push(
          `TEXT/NODE "${texts[i].t}"[${texts[i].kind}] ↔ node#${k} area=${area.toFixed(1)}`,
        );
    }
  }
  return out;
}

async function graphTransform(page) {
  return page.evaluate(() => {
    const g = document.querySelector('[data-testid="topology-svg"] > g');
    return g ? g.getAttribute("transform") : null;
  });
}

async function matrixTransform(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="matrix-viewport"]');
    return el ? el.style.transform : null;
  });
}

async function testPanZoom(page, isMatrix) {
  const box = await page.evaluate((m) => {
    const el = m
      ? document.querySelector('[data-testid="matrix-viewport"]')?.parentElement
      : document.querySelector('[data-testid="topology-svg"]');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, isMatrix);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const get = () => (isMatrix ? matrixTransform(page) : graphTransform(page));
  const before = await get();
  if (!before) return "no transform target found";
  // Zoom via wheel over the canvas center.
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240);
  await sleep(600);
  const zoomed = await get();
  if (zoomed === before) return "wheel zoom did not change transform";
  // Pan via background drag.
  await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.3 + 120, box.y + box.h * 0.3 + 80, {
    steps: 12,
  });
  await page.mouse.up();
  await sleep(600);
  const panned = await get();
  if (panned === zoomed) return "background drag did not change transform";
  return null;
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

let failures = 0;
for (const layout of LAYOUTS) {
  const isMatrix = layout === "matrix";
  const errors = [];
  try {
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
    await sleep(1200); // let force layout + transitions settle

    const scan = await scanOverlaps(page, isMatrix);
    errors.push(...findViolations(scan));
    console.log(
      `  [${layout}] texts=${scan.texts.length} discs=${scan.discs.length}`,
    );

    const pz = await testPanZoom(page, isMatrix);
    if (pz) errors.push(`PAN/ZOOM: ${pz}`);

    if (AGGREGATE_EXTRA.has(layout)) {
      // Flip the aggregation switch on and re-scan (badge pills appear).
      const sw = page.getByRole("switch", {
        name: "Aggregate inter-group edges",
      });
      if ((await sw.count()) > 0) {
        await sw.click();
        await sleep(800);
        const scan2 = await scanOverlaps(page, false);
        errors.push(
          ...findViolations(scan2).map((v) => `aggregated: ${v}`),
        );
        console.log(
          `  [${layout}+agg] texts=${scan2.texts.length} discs=${scan2.discs.length}`,
        );
      }
    }

    await page.screenshot({ path: `${SHOTS}/${layout}.png` });
  } catch (e) {
    errors.push(`ERROR: ${e.message?.split("\n")[0]}`);
  }
  if (errors.length > 0) {
    failures += 1;
    console.log(`❌ ${layout}: ${errors.length} problem(s)`);
    for (const e of errors.slice(0, 12)) console.log(`     - ${e}`);
  } else {
    console.log(`✅ ${layout}: no overlaps, pan+zoom OK`);
  }
}

await browser.close();
console.log(
  failures === 0
    ? `\nALL ${LAYOUTS.length} LAYOUTS PASS`
    : `\n${failures} LAYOUT(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
