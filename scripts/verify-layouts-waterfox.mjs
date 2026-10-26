#!/usr/bin/env node
/**
 * Headless-Waterfox verification (via geckodriver + W3C WebDriver).
 *
 * Mirrors scripts/verify-layouts.mjs: for every layout it checks
 *   1. no visible SVG text overlaps any other visible SVG text,
 *   2. no visible SVG text overlaps any node disc,
 *   3. wheel-zoom and background-drag change the view transform
 *      (graph modes and matrix alike),
 * and saves a screenshot per layout.
 *
 * Requires geckodriver listening on port 4444, e.g.:
 *   /tmp/gd/geckodriver --port 4444
 */
const WD = "http://localhost:4444";
const BASE = process.env.BASE_URL ?? "http://localhost:5001";
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/topo-shots-waterfox";

const { mkdirSync, writeFileSync } = await import("node:fs");
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
const AGGREGATE_EXTRA = new Set(["force", "compound"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(`${WD}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`);
  const json = await res.json();
  return json.value;
}

const sessionId = await wd("POST", "/session", {
  capabilities: {
    alwaysMatch: {
      browserName: "firefox",
      "moz:firefoxOptions": {
        binary: "/Applications/Waterfox.app/Contents/MacOS/waterfox",
        args: ["-headless"],
      },
    },
  },
}).then((v) => v.sessionId ?? v);
console.log("session:", sessionId);

const api = {
  goto: (url) => wd("POST", `/session/${sessionId}/url`, { url }),
  exec: (script, args = []) =>
    wd("POST", `/session/${sessionId}/execute/sync`, { script, args }),
  actions: (actions) =>
    wd("POST", `/session/${sessionId}/actions`, { actions }),
  shot: (path) =>
    wd("GET", `/session/${sessionId}/screenshot`).then((b64) =>
      writeFileSync(path, Buffer.from(b64, "base64")),
    ),
};

await wd("POST", `/session/${sessionId}/window/rect`, {
  width: 1440,
  height: 900,
});
console.log(
  "viewport:",
  await api.exec("return {w: window.innerWidth, h: window.innerHeight};"),
);

function overlapArea(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

const SCAN_SCRIPT = `
  const isMatrix = arguments[0];
  const R = (r) => ({x: r.x, y: r.y, w: r.width, h: r.height});
  if (isMatrix) {
    const texts = [];
    const root = document.querySelector('[data-testid="matrix-viewport"]');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || "").trim();
      if (!t) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      texts.push({t: t.slice(0, 40), kind: n.parentElement ? n.parentElement.tagName : "?", r: R(r)});
    }
    return {texts: texts, discs: []};
  }
  const texts = [...document.querySelectorAll('[data-testid="topology-svg"] text')]
    .filter((el) => !el.hasAttribute("data-inside"))
    .map((el) => ({el: el, r: R(el.getBoundingClientRect())}))
    .filter((e) => e.r.w > 0.5 && e.r.h > 0.5)
    .map((e) => ({t: (e.el.textContent || "").trim().slice(0, 40),
                   kind: e.el.getAttribute("data-label") || "?",
                   r: e.r}));
  const discs = [...document.querySelectorAll('[data-testid="topology-svg"] g.network-node circle')]
    .map((el) => R(el.getBoundingClientRect()))
    .filter((r) => r.w > 0 && r.h > 0);
  return {texts: texts, discs: discs};
`;

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

async function waitFor(selector, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const n = await api.exec(
      "return document.querySelectorAll(arguments[0]).length;",
      [selector],
    );
    if (n > 0) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(500);
  }
}

async function getTransform(isMatrix) {
  if (isMatrix)
    return api.exec(
      `const el = document.querySelector('[data-testid="matrix-viewport"]');
       return el ? el.style.transform : null;`,
    );
  return api.exec(
    `const g = document.querySelector('[data-testid="topology-svg"] > g');
     return g ? g.getAttribute("transform") : null;`,
  );
}

async function testPanZoom(isMatrix) {
  const box = await api.exec(
    `const el = ${isMatrix ? `document.querySelector('[data-testid="matrix-viewport"]').parentElement` : `document.querySelector('[data-testid="topology-svg"]')`};
     const r = el.getBoundingClientRect();
     return {x: r.x, y: r.y, w: r.width, h: r.height};`,
  );
  const cx = Math.round(box.x + box.w / 2);
  const cy = Math.round(box.y + box.h / 2);
  const before = await getTransform(isMatrix);
  if (!before) return "no transform target found";
  // Wheel-zoom over the canvas center.
  await api.actions([
    {
      type: "wheel",
      id: "wheel1",
      actions: [{ type: "scroll", x: cx, y: cy, deltaX: 0, deltaY: -240, duration: 100 }],
    },
  ]);
  await sleep(800);
  const zoomed = await getTransform(isMatrix);
  if (zoomed === before) return "wheel zoom did not change transform";
  // Background drag.
  const sx = Math.round(box.x + box.w * 0.3);
  const sy = Math.round(box.y + box.h * 0.3);
  await api.actions([
    {
      type: "pointer",
      id: "mouse1",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: sx, y: sy },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: 300, x: sx + 120, y: sy + 80 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await sleep(800);
  await api.actions([{ type: "pointer", id: "mouse1", parameters: { pointerType: "mouse" }, actions: [] }]);
  const panned = await getTransform(isMatrix);
  if (panned === zoomed) return "background drag did not change transform";
  return null;
}

let failures = 0;
for (const layout of LAYOUTS) {
  const isMatrix = layout === "matrix";
  const errors = [];
  try {
    await api.goto(`${BASE}/?layout=${layout}`);
    const ok = await waitFor(
      isMatrix
        ? '[data-testid="matrix-viewport"]'
        : '[data-testid="topology-svg"] g.network-node',
      20000,
    );
    if (!ok) throw new Error("topology did not render in time");
    await sleep(1500);

    const scan = await api.exec(SCAN_SCRIPT, [isMatrix]);
    errors.push(...findViolations(scan));
    console.log(
      `  [${layout}] texts=${scan.texts.length} discs=${scan.discs.length}`,
    );

    const pz = await testPanZoom(isMatrix);
    if (pz) errors.push(`PAN/ZOOM: ${pz}`);

    if (AGGREGATE_EXTRA.has(layout)) {
      const clicked = await api.exec(
        `const sw = [...document.querySelectorAll('[role="switch"]')]
           .find((el) => (el.getAttribute("aria-label") || "").includes("Aggregate"));
         if (sw) { sw.click(); return true; } return false;`,
      );
      if (clicked) {
        await sleep(800);
        const scan2 = await api.exec(SCAN_SCRIPT, [false]);
        errors.push(
          ...findViolations(scan2).map((v) => `aggregated: ${v}`),
        );
        console.log(
          `  [${layout}+agg] texts=${scan2.texts.length} discs=${scan2.discs.length}`,
        );
      }
    }

    await api.shot(`${SHOTS}/${layout}.png`);
  } catch (e) {
    errors.push(`ERROR: ${String(e && e.message ? e.message : e).split("\n")[0]}`);
  }
  if (errors.length > 0) {
    failures += 1;
    console.log(`❌ ${layout}: ${errors.length} problem(s)`);
    for (const e of errors.slice(0, 12)) console.log(`     - ${e}`);
  } else {
    console.log(`✅ ${layout}: no overlaps, pan+zoom OK`);
  }
}

await wd("DELETE", `/session/${sessionId}`);
console.log(
  failures === 0
    ? `\nALL ${LAYOUTS.length} LAYOUTS PASS (Waterfox)`
    : `\n${failures} LAYOUT(S) FAILED (Waterfox)`,
);
process.exit(failures === 0 ? 0 : 1);
