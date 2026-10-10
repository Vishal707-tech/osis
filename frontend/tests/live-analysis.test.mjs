// Opt-in real frontend + Express + Python acceptance, using installed Chrome/CDP.
// No browser framework, satellite download, external credentials or mock incident API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const repo = path.resolve(root, "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test(
  "live frontend/backend acceptance: outcomes, map, report, upload and REAL recovery",
  {
    skip: process.env.OSIS_TEST_LIVE !== "true" || !process.env.OSIS_TEST_BROWSER,
    timeout: 180000,
  },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "osis-live-test-"));
    const children = [];
    const diagnostics = [];
    let socket;
    const start = (command, args, options = {}) => {
      const child = spawn(command, args, { windowsHide: true, ...options });
      children.push(child);
      child.stderr.on("data", (data) => diagnostics.push(String(data).slice(-2000)));
      child.stdout.on("data", (data) => diagnostics.push(String(data).slice(-2000)));
      child.on("error", () => {});
      return child;
    };
    try {
      const backendPort = await freePort(),
        frontendPort = await freePort();
      const api = `http://127.0.0.1:${backendPort}`;
      const frontend = `http://127.0.0.1:${frontendPort}`;
      start(
        process.execPath,
        [
          "-e",
          `const app=require('./src/app');process.env.CDSE_CLIENT_ID='';process.env.CDSE_CLIENT_SECRET='';app.listen(${backendPort},'127.0.0.1')`,
        ],
        {
          cwd: path.join(repo, "backend"),
          env: {
            ...process.env,
            OSIS_REPORT_DIR: path.join(directory, "reports"),
            OSIS_PERSIST_POSTGRES: "false",
            REAL_SAR_PYTHON:
              process.env.REAL_SAR_PYTHON || path.join(repo, ".venv-ml/Scripts/python.exe"),
            REAL_CURRENT_NETCDF: path.join(directory, "missing-current.nc"),
            REAL_WIND_NETCDF: path.join(directory, "missing-wind.nc"),
          },
        },
      );
      start(
        process.execPath,
        [
          path.join(root, "node_modules/vite/bin/vite.js"),
          "--host",
          "127.0.0.1",
          "--port",
          String(frontendPort),
          "--strictPort",
        ],
        {
          cwd: root,
          env: { ...process.env, VITE_API_URL: api },
        },
      );
      for (const url of [`${api}/api/health`, `${frontend}/analysis`]) {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) {
              ready = true;
              break;
            }
          } catch {}
          await delay(300);
        }
        assert.ok(ready, `Server did not start: ${url}`);
      }
      start(process.env.OSIS_TEST_BROWSER, [
        "--headless",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${path.join(directory, "profile")}`,
        "about:blank",
      ]);
      let port;
      for (let i = 0; i < 100; i++) {
        try {
          port = (await readFile(path.join(directory, "profile/DevToolsActivePort"), "utf8")).split(
            "\n",
          )[0];
          break;
        } catch {
          await delay(100);
        }
      }
      assert.ok(port, "Chrome debugging endpoint unavailable");
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      socket = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      let sequence = 0;
      const pending = new Map();
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (
          ["Runtime.exceptionThrown", "Network.loadingFailed", "Log.entryAdded"].includes(
            message.method,
          )
        )
          diagnostics.push(JSON.stringify(message).slice(-3000));
        if (message.id && pending.has(message.id)) {
          const { resolve, reject, timer } = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(timer);
          message.error
            ? reject(new Error(JSON.stringify(message.error)))
            : resolve(message.result);
        }
      });
      const command = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          }, 45000);
          pending.set(id, { resolve, reject, timer });
          socket.send(JSON.stringify({ id, method, params }));
        });
      await command("Runtime.enable");
      await command("Network.enable");
      await command("Log.enable");
      await command("Page.navigate", { url: `${frontend}/analysis` });
      const evaluate = async (expression) => {
        const result = await command("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          const diagnostic = await command("Runtime.evaluate", {
            expression: "document.body.innerText.slice(-12000)",
            returnByValue: true,
          });
          assert.fail(
            `${JSON.stringify(result.exceptionDetails)}\nUI: ${diagnostic.result.value}\nDIAGNOSTICS: ${diagnostics.slice(-16).join("\n")}`,
          );
        }
        return result.result.value;
      };
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`Boolean(document.querySelector('select[aria-label="Scene"]'))`)) break;
        await delay(200);
      }
      await delay(1500); // Initial SSR DOM exists before client hydration attaches handlers.
      const results = await evaluate(`(async () => {
      const wait = async (fn) => { for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('UI wait expired'); };
      const select = (el,value) => {el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));};
      const button = text => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
      const scene = () => document.querySelector('select[aria-label="Scene"]');
      const text = () => document.body.textContent;
      const outcomes = [];
      // Wait for a client-fetched option: SSR markup alone does not mean hydration is ready.
      await wait(()=>[...scene().options].some(o=>o.value==='s1a-20240619-karnataka'));
      for(const [id,outcome] of [['demo-arabian-sea','SPILL_DETECTED'],['demo-no-spill','NO_SPILL_DETECTED'],['demo-inconclusive','ANALYSIS_INCONCLUSIVE']]) {
        select(scene(),id);await new Promise(r=>setTimeout(r,80));button('Analyze DEMO pipeline').click();
        await wait(()=>document.querySelector('[aria-label="Analysis outcome"]')?.textContent.includes(outcome));
        if(!document.querySelector('[aria-label="Analyzed scene footprint"]'))throw Error('Scene footprint absent');
        if(!button('Download report JSON'))throw Error('Report export absent');
        outcomes.push(outcome);
      }
      document.querySelector('[aria-label="Zoom in"]').click();
      document.querySelector('[aria-label="Reset view"]').click();
      select(scene(),'upload');await wait(()=>button('Analyze uploaded SAR'));button('Analyze uploaded SAR').click();
      await wait(()=>text().includes('UPLOAD ERROR'));
      select(scene(),'s1a-20240619-karnataka');await wait(()=>button('Analyze REAL pipeline'));
      [...document.querySelectorAll('label')].find(l=>l.textContent.includes('Fetch CDSE subset')).querySelector('input').click();
      await new Promise(r=>setTimeout(r,80));button('Analyze REAL pipeline').click();
      await wait(()=>text().includes('REAL_DATA_UNAVAILABLE') && text().includes('CDSE_CLIENT_ID'));
      return {outcomes,uploadValidation:true,realUnavailable:true,map:true};
    })()`);
      assert.deepEqual(results.outcomes, [
        "SPILL_DETECTED",
        "NO_SPILL_DETECTED",
        "ANALYSIS_INCONCLUSIVE",
      ]);
      // Feed the actual archived GeoTIFFs through the browser file inputs and upload API.
      // This optional section requires the same local SAR assets as the backend integration test.
      if (process.env.OSIS_TEST_REAL_SAR === "true") {
        await evaluate(
          `(() => { const s=document.querySelector('select[aria-label="Scene"]'); s.value='upload'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`,
        );
        await delay(150);
        const documentNode = await command("DOM.getDocument");
        for (const pol of ["vv", "vh"]) {
          const input = await command("DOM.querySelector", {
            nodeId: documentNode.root.nodeId,
            selector: 'input[aria-label="' + pol.toUpperCase() + ' GeoTIFF"]',
          });
          assert.ok(input.nodeId);
          await command("DOM.setFileInputFiles", {
            nodeId: input.nodeId,
            files: [path.join(repo, "backend/data/sentinel-test/s1a_20240619_" + pol + "_db.tif")],
          });
        }
        await evaluate(`(async () => {
        const date=document.querySelector('input[aria-label="Acquisition time UTC"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(date,'2024-06-19T00:48');
        date.dispatchEvent(new Event('input',{bubbles:true}));
        document.querySelector('[aria-label="SAR upload"] input[type="checkbox"]').click();
        await new Promise(r=>setTimeout(r,100));
        [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Analyze uploaded SAR').click();
        for(let i=0;i<600;i++){if(document.body.textContent.includes('Upload analysis completed:')) return true; await new Promise(r=>setTimeout(r,50));}
        throw Error('Actual SAR upload did not complete');
      })()`);
        results.actualSarUpload = true;
      }
      const reports = await (await fetch(`${api}/api/incidents`)).json();
      assert.equal(reports.length, results.actualSarUpload ? 5 : 4);
      for (const summary of reports) {
        const response = await fetch(`${api}/api/incidents/${summary.id}/report`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-disposition"), /attachment/);
        const report = await response.json();
        assert.equal(report.outcome, summary.outcome);
        if (summary.mode === "UPLOAD") {
          assert.equal(report.stageStatus.detection.status, "completed", report.outcomeReason);
          assert.equal(report.detector.name, "hybrid");
        }
      }
      console.info(
        JSON.stringify({
          liveAcceptance: results,
          reportRoundTrips: reports.length,
          satelliteDownloads: 0,
        }),
      );
    } finally {
      socket?.close();
      for (const child of children.reverse()) {
        if (child.exitCode === null && child.pid) {
          if (process.platform === "win32")
            spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          else child.kill();
        }
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  },
);
