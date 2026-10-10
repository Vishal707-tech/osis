// Opt-in installed Chromium smoke test, using existing Node/Vite/React only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
test(
  "browser switches saved DEMO/REAL reports without stale evidence",
  {
    skip: !process.env.OSIS_TEST_BROWSER,
    timeout: 60000,
  },
  async () => {
    const directory = await mkdtemp(path.join(root, ".osis-browser-test-"));
    let server, child, browserTimer;
    try {
      const report = (script, payload, env = {}) => {
        const result = spawnSync(
          process.env.PYTHON_PATH || "python",
          [path.join(root, "../backend/scripts", script)],
          {
            input: JSON.stringify(payload),
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, ...env },
          },
        );
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        return {
          ...JSON.parse(result.stdout),
          id: `test-${script}`,
          detectedAt: "2026-09-09T00:00:00Z",
          persistence: { local: "test_only", database: "disabled" },
        };
      };
      const demo = report("incident_pipeline.py", { forecastHours: 24 });
      const real = report(
        "real_incident_pipeline.py",
        { sceneId: "s1a-20240619-karnataka" },
        { REAL_SAR_PYTHON: path.join(directory, "missing-python") },
      );
      const noSpill = report("incident_pipeline.py", { sceneId: "demo-no-spill" });
      noSpill.id = "test-no-spill";
      const inconclusive = report("incident_pipeline.py", { sceneId: "demo-inconclusive" });
      inconclusive.id = "test-inconclusive";
      await writeFile(
        path.join(directory, "reports.json"),
        JSON.stringify({ demo, real, noSpill, inconclusive }),
      );
      await writeFile(
        path.join(directory, "index.html"),
        '<!doctype html><html><body><div id="root"></div><pre id="result">RUNNING</pre><script type="module" src="./entry.jsx"></script></body></html>',
      );
      await writeFile(
        path.join(directory, "entry.jsx"),
        `
      import { verifySwitching } from '../tests/saved-reports.browser.jsx';
      import reports from './reports.json';
      const errors = [];
      const originalError = console.error;
      console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
      try {
        await verifySwitching(reports);
        if (errors.length) throw new Error(errors.join('\\n'));
        document.getElementById('result').textContent = 'OSIS_BROWSER_PASS';
      } catch (error) {
        document.getElementById('result').textContent = 'OSIS_BROWSER_FAIL: ' + error.stack;
      }
    `,
      );
      await build({
        root: directory,
        configFile: false,
        logLevel: "error",
        resolve: { alias: { "@": path.join(root, "src") } },
        esbuild: { jsx: "automatic" },
        build: { target: "esnext", outDir: path.join(directory, "dist") },
      });
      server = createServer(async (req, res) => {
        try {
          const name = req.url === "/" ? "index.html" : req.url.slice(1);
          const file = path.resolve(directory, "dist", name);
          if (!file.startsWith(path.join(directory, "dist") + path.sep))
            throw new Error("Invalid path");
          const body = await readFile(file);
          res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      child = spawn(
        process.env.OSIS_TEST_BROWSER,
        [
          "--headless",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${path.join(directory, "profile")}`,
          "--dump-dom",
          "--virtual-time-budget=20000",
          `http://127.0.0.1:${server.address().port}/`,
        ],
        { windowsHide: true },
      );
      // Clear our own deadline on launch failure too; spawn's timeout can linger after ENOENT.
      browserTimer = setTimeout(() => child.kill(), 40000);
      browserTimer.unref();
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 0, stderr.slice(-2000));
      const result = stdout.match(/<pre id="result">[\s\S]*?<\/pre>/)?.[0];
      assert.equal(
        result,
        '<pre id="result">OSIS_BROWSER_PASS</pre>',
        result || stderr.slice(-2000),
      );
    } finally {
      clearTimeout(browserTimer);
      if (child && child.exitCode === null) child.kill();
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
