// Server-rendering regressions using existing Vite/React and Python, no browser framework.
// Derived report variants below are TEST fixtures, never operational REAL assets.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
let directory, ReportView, demo, partial, noSpill, inconclusive;
const render = (report) => renderToStaticMarkup(createElement(ReportView, { report }));

before(async () => {
  directory = await mkdtemp(path.join(root, ".osis-render-test-"));
  const bundle = await build({
    root,
    configFile: false,
    logLevel: "error",
    build: { ssr: path.join(root, "src/routes/analysis.tsx"), write: false, minify: false },
    resolve: { alias: { "@": path.join(root, "src") } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  for (const item of output) {
    assert.equal(item.type, "chunk");
    const filePath = path.join(directory, item.fileName);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, item.code);
  }
  const entry = output.find((item) => item.isEntry);
  ({ ReportView } = await import(pathToFileURL(path.join(directory, entry.fileName)).href));
  const pipeline = (name, input, env = {}) => {
    const child = spawnSync(
      process.env.PYTHON_PATH || "python",
      [path.join(root, "../backend/scripts", name)],
      {
        input: JSON.stringify(input),
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, ...env },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    return {
      ...JSON.parse(child.stdout),
      id: name,
      detectedAt: "2026-09-09T00:00:00Z",
      persistence: { local: "test_only", database: "disabled" },
    };
  };
  demo = pipeline("incident_pipeline.py", { forecastHours: 24 });
  noSpill = pipeline("incident_pipeline.py", { sceneId: "demo-no-spill" });
  inconclusive = pipeline("incident_pipeline.py", { sceneId: "demo-inconclusive" });
  partial = pipeline(
    "real_incident_pipeline.py",
    { sceneId: "s1a-20240619-karnataka" },
    { REAL_SAR_PYTHON: path.join(directory, "missing-python") },
  );
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("DEMO still renders its computed geometry, age and vessel evidence", () => {
  const html = render(demo);
  assert.match(html, /DEMO/);
  assert.ok(html.includes(demo.candidates[0].name));
  assert.doesNotMatch(html, /Modeled origin unavailable/);
});

test("SAR failure renders unavailable stages without demo evidence", () => {
  const html = render(partial);
  assert.match(html, /REAL/);
  assert.match(html, /Preview unavailable/);
  assert.match(html, /AIS unavailable/);
  assert.match(html, /Modeled origin unavailable/);
  assert.ok(!html.includes(demo.candidates[0].name));
});

test("no candidates is distinct from detector failure", () => {
  const report = structuredClone(partial);
  report.status = "no_candidates";
  report.stageStatus.detection = {
    status: "completed",
    kind: "INFERRED",
    reason: "No dark-slick candidates",
  };
  const html = render(report);
  assert.match(html, /no_candidates/);
  assert.match(html, /No dark-slick candidates/);
});

test("SAR-only partial report renders geometry with null origin, age and AIS", () => {
  const report = { ...partial, detections: demo.detections, spill: demo.spill };
  const html = render(report);
  assert.match(html, /Perimeter/);
  assert.match(html, /Spill age unavailable/);
  assert.match(html, /No attribution generated/);
});

test("modeled origin without age or AIS remains explicitly conditional", () => {
  const report = {
    ...partial,
    origin: demo.origin,
    backward: demo.backward,
    forward: demo.forward,
  };
  const html = render(report);
  assert.match(html, /Origin sensitivity radius/);
  assert.match(html, /Not measured spill age/);
  assert.match(html, /AIS unavailable/);
});

test("no-spill dashboard retains outcome, footprint, detector and report export", () => {
  const html = render(noSpill);
  for (const label of [
    "NO_SPILL_DETECTED",
    "no significant oil-like anomaly",
    "Analyzed scene footprint",
    "Processing timestamp",
    "Download report JSON",
    "Evidence provenance",
  ])
    assert.ok(html.includes(label), label);
  assert.ok(!html.includes(demo.candidates[0].name));
});

test("inconclusive dashboard explains coverage and never becomes blank", () => {
  const html = render(inconclusive);
  assert.match(html, /ANALYSIS_INCONCLUSIVE/);
  assert.match(html, /Zero valid SAR coverage/);
  assert.match(html, /Analyzed scene footprint/);
});

test("invalid uploaded scene renders without a fabricated footprint or location", () => {
  const html = render({
    ...partial,
    mode: "UPLOAD",
    scene: { ...partial.scene, bbox: null, acquiredAt: "" },
  });
  assert.match(html, /Scene location unavailable/);
  assert.doesNotMatch(html, /aria-label="Analyzed scene footprint"/);
  assert.match(html, /user-provided/);
});
