# O.S.I.S.
## Oil Spill Identification & Source Attribution System

SIH 2026 prototype: available SAR imagery → slick characterization → release-window inference → origin hindcast → forward drift → historical AIS correlation → evidence-ranked vessel candidates.

**Use `/analysis` for the backend-computed SIH prototype.** Select DEMO, REAL (archived or bounded on-demand CDSE), or UPLOAD. DEMO imagery, environment, observations and identities are explicitly synthetic. REAL/UPLOAD never substitute those fixtures for missing evidence. This is not an operational pollution surveillance service or a finding of legal responsibility.

Every accepted analysis produces exactly one `outcome`: **SPILL_DETECTED**, **NO_SPILL_DETECTED**, or **ANALYSIS_INCONCLUSIVE**. This is separate from downstream completeness (`status`). Missing real access is `availability: REAL_DATA_UNAVAILABLE` with an inconclusive outcome. No-spill and inconclusive dashboards retain scene footprint where known, diagnostics, provenance, processing timestamp and downloadable reports.

## Quick start

Prerequisites: Node.js 22.12+ (or a compatible newer release), npm, Python 3.10+ on PATH. The deterministic pipeline uses Python's standard library and existing geometry/RK4 code; no pip installation or external account is required.

Run from the repository root:

```sh
npm --prefix backend ci
npm --prefix frontend ci
```

Start these in **two terminals**:

```sh
npm --prefix backend start
```

```sh
npm --prefix frontend run dev -- --host 127.0.0.1 --port 3000
```

Open **http://localhost:3000/analysis**. Backend defaults to http://localhost:5000.

1. Select the synthetic Arabian Sea, no-spill, or inconclusive exercise. These require no credentials.
2. Choose a 24, 48 or 72 hour forecast.
3. Click **Analyze DEMO pipeline**.
4. Toggle SAR, slick polygons, origin uncertainty, hindcast, forecast, vessel tracks and AIS gaps.
5. Select a candidate to inspect weighted evidence.
6. Download the JSON report. Saved reports can be reopened after restarting the backend.

The map retains the project's SVG visualization and needs no external tiles. The dashboard links to this workflow. Other pages preserve the earlier research/demo interface and label fixture content; they are not substitutes for the computed incident report.

### Configuration

Defaults work without `.env`. Examples are in `backend/.env.example` and `frontend/.env.example`. **Do not overwrite an existing `.env` or commit credentials.**

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5000` | Express port |
| `PYTHON_PATH` | `python` | Interpreter executable, not a shell command |
| `OSIS_REPORT_DIR` | `backend/data/incidents` | Writable local JSON archive |
| `OSIS_PERSIST_POSTGRES` | disabled | Set exactly `true` to mirror new reports to PostGIS |
| `DATABASE_URL` | none | PostgreSQL connection string, required only for DB operations/legacy APIs |
| `OSIS_TEST_DATABASE` | disabled | Opt-in DB test; set in shell before starting the test |
| `VITE_API_URL` | `http://localhost:5000` | Browser-accessible API origin; restart/rebuild frontend after changing |
| `REAL_SAR_PYTHON` | main interpreter | Existing ML environment with NumPy, torch, tifffile, OpenCV, matplotlib, segmentation-models-pytorch; on this workspace use the absolute `.venv-ml/Scripts/python.exe` path |
| `REAL_MODEL_PATH` | existing root `best_sar_model.pth` | Trusted local hybrid checkpoint; never downloaded automatically |
| `CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET` | none | OAuth client credentials with Sentinel Hub Catalog/Process access; only used when on-demand is selected |
| `REAL_CURRENT_NETCDF`, `REAL_WIND_NETCDF` | none | Compatible bounded CMEMS `uo/vo` and ERA5 `u10/v10` subsets, explicit m/s units |
| `REAL_AIS_CSV`, `REAL_AIS_MANIFEST` | none | Licensed observed historical fixes plus coverage/unit/source attestation |
| `OSIS_MAX_ANALYSES` | 2 | Concurrent analyses, hard maximum 2 |
| `OSIS_ANALYSES_PER_MINUTE` | 20 | Global local-prototype admission budget, hard maximum 30 |
| `OSIS_UPLOAD_MAX_MIB`, `OSIS_DOWNLOAD_MAX_MIB` | 8 | Per-polarization file/response ceiling; configurable downward only |
| `OSIS_REQUEST_TIMEOUT_MS` | 15000 | CDSE timeout including streamed body; hard maximum 20000 |
| `OSIS_MAX_REPORTS` | 100 | Local archive count cap; configurable downward. Export/remove older reports when full; no automatic evidence deletion |

Local JSON is the incident API's read store; PostGIS is an optional mirror. Database outages are explicitly reported as `unavailable_local_fallback`. A writable report directory and working Python interpreter are required. `/api/health` is **liveness**, not database/scientific-provider readiness.

## Optional database setup

Use a PostgreSQL database with PostGIS available, and a role allowed to create the extension (or ask the database administrator to provision PostGIS). Configure `DATABASE_URL`, then:

```sh
npm --prefix backend run migrate
```

This applies **`002_incidents.sql` and `003_analysis_outcomes.sql`** transactionally. These additive, repeatable migrations create the incident archive/views and allow nullable geometry/acquisition for no-spill and inconclusive reports. Migration 003 also adds the outcome constraint and `osis_candidate_compatibility` view without breaking the legacy view name. They do not delete legacy records or seed fictional vessels.

`001_hindcast_schema.sql` is preserved for the earlier application and depends on its existing schema. For a database that already has those legacy tables:

```sh
npm --prefix backend run migrate -- 001_hindcast_schema.sql
```

Do not run the old `seed.js` as part of the new demo setup. The new demo needs neither legacy seeding nor migration 001.

After migration, set `OSIS_PERSIST_POSTGRES=true` and restart the backend to mirror new incident reports. Existing local archives are not automatically backfilled.

## API

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/health` | API liveness |
| GET | `/api/incidents/scenes` | Available explicitly labeled demo scenes |
| POST | `/api/incidents/analyze` | Complete computed and archived incident |
| GET | `/api/incidents` | Saved incident summaries |
| GET | `/api/incidents/:id` | Full report |
| GET | `/api/incidents/:id/spill` | Detections, primary slick, raster, mask and age |
| GET | `/api/incidents/:id/origin` | Modeled origin and backward trajectory |
| GET | `/api/incidents/:id/drift` | Backward/forward trajectories and environment |
| GET | `/api/incidents/:id/vessels` | Candidates, anomalies and scoring configuration |
| GET | `/api/incidents/:id/vessels/:mmsi` | Incident-specific vessel evidence |
| GET | `/api/incidents/:id/report` | Downloadable JSON report |

Analysis body:

```json
{"sceneId":"demo-arabian-sea","forecastHours":24}
```

Both fields are optional with the values above as defaults. DEMO scene IDs also include `demo-no-spill` and `demo-inconclusive`. Unknown options, string horizons and unsupported horizons are rejected. Python processing is bounded to two simultaneous analyses, 60 seconds and 8 MiB output (SAR child: 35 seconds). CDSE acquisition has separate bounded requests before Python starts. Errors include 400 validation, 404 missing incident, 413 oversized body, 429 capacity, 503 missing Python, 504 timeout, and 507 archive capacity. Transport failures return an inconclusive error envelope, not a fake successful incident; the frontend preserves recovery controls.

### REAL and UPLOAD

- **REAL archived:** choose `s1a-20240619-karnataka`; select hybrid or classical. The local June 19, 2024 VV/VH subset is operator-controlled. Hybrid reuses existing PoSeATSea/classical fusion; classical-only oil-like candidates remain inconclusive. Quality/confidence thresholds are prototype gates, not calibrated accuracy.
- **REAL on demand:** check “Fetch CDSE subset on demand”. Example body: `{"mode":"REAL","sceneId":"s1a-20240619-karnataka","onDemand":true,"detector":"hybrid","forecastHours":24,"hindcastHours":6}`. Search at most five metadata records for the selected day, then fetch two 512×512 polarization subsets for one acquisition, provider-cropped to the registry AOI. No arbitrary URLs, archive downloads or background polling. Missing access returns `REAL_DATA_UNAVAILABLE`, never DEMO data.
- **UPLOAD:** choose UPLOAD, provide co-registered VV and VH GeoTIFFs, acquisition UTC, calibrated `db`/`linear` units and SAR attestation. Supported input is single-page/single-band FLOAT32, 512×512, north-up EPSG:4326 PixelIsArea, at most 8 MiB per file and 0.2° per AOI side. RGB/JPEG/PNG and raw SAFE products are intentionally unsupported. Do not rename photos to `.tif`.
- `POST /api/incidents/upload` uses `application/octet-stream`: VV bytes followed by VH bytes. Header `X-OSIS-SAR-Metadata` is URI-encoded JSON containing `vvBytes`, `vvName`, `vhName`, `acquiredAt`, `rasterUnits`, `sarAttested:true`. This bounded protocol uses existing Express, not an added multipart framework. Invalid inputs within the body limit receive saved inconclusive reports; oversized/aborted transfers receive transport errors and recovery UI.
- Upload runs the same hybrid detector and strict environmental/AIS orchestration. Forecast supports 24/48/72 hours and hindcast scenario 1–48 hours, defaulting to 24 and six hours; optional metadata fields are `forecastHours` and `hindcastHours`. Neither duration is an observed release age. Raw upload files are removed in `finally`; report preview/mask/hashes remain. Timestamp/source authenticity is operator-attested, not independently authenticated.

### Laptop safety

Hard limits: 0.2° AOI sides, five catalog metadata records, one selected acquisition, two sequential VV/VH outputs, 8 MiB per download, 15-second request deadlines, zero automatic retries, 60-second CDSE admission cooldown, one upload transfer, two Python analyses, and 100 reports. Cache is one scene (up to 16 MiB) for one hour in the OS temporary directory; failed products are deleted and adapter-owned expired caches are cleaned on subsequent acquisitions. Graceful expiry uses an unreferenced timer. Abrupt OS termination can leave temporary files; this is a single-process laptop prototype, not a distributed job/storage service. Environmental files/components are capped at 128 MiB, AIS CSV at 8 MiB/20,000 rows, manifest at 64 KiB. No model/data artifacts are added to Git.

Example using Node (shell-independent, backend must be running):

```sh
node -e "fetch('http://localhost:5000/api/incidents/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({forecastHours:24})}).then(async r=>{if(!r.ok)throw new Error(await r.text());const x=await r.json();console.log({id:x.id,age:x.age,origin:x.origin,leadingCandidate:x.leadingCandidate})}).catch(e=>{console.error(e);process.exitCode=1})"
```

Legacy `/api/spills`, `/api/detection`, `/api/drift`, `/api/vessels` and `/api/reports` routes remain available with their original data/provider requirements.

## Tests and build

```sh
npm --prefix backend test
npm --prefix backend run test:legacy
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
node frontend/node_modules/typescript/bin/tsc --project frontend/tsconfig.json --noEmit
```

The backend suite includes deterministic outcomes, geometry/RK4, scoring/gaps, strict environmental/AIS coverage, upload and resource-safety regressions. Optional actual archived-SAR tests require `OSIS_TEST_REAL_SAR=true` and the existing ML interpreter. Run Python tests under both the default and ML environments where dependencies differ. PostGIS tests apply migrations twice and exercise all three outcomes **inside a rolled-back transaction**.

Set `OSIS_TEST_BROWSER` to the absolute installed Chrome executable for DOM/canvas regressions. Add `OSIS_TEST_LIVE=true` for the real frontend + Express + Python acceptance test; it starts isolated servers and closes them afterward. It deliberately disables CDSE credentials and performs no satellite download. See `docs/VALIDATION.md` for the current measured results and exact scope.

Enable the optional test without editing `.env`:

```sh
node -e "const r=require('node:child_process').spawnSync(process.execPath,['--test','backend/tests/database.test.js'],{stdio:'inherit',env:{...process.env,OSIS_TEST_DATABASE:'true'}});process.exit(r.status??1)"
```

Production build retains the existing TanStack/Nitro Cloudflare target. Use the development server for the local judging demo; deployment requires configuring the public backend URL and appropriate hosting/security.

## Scientific scope and limitations

- The new scene provider produces seeded SAR-like dB values, not a downloaded Sentinel-1 acquisition.
- Median filtering and adaptive dark-region thresholding are a **baseline**, not a trained oil classifier. Two connected slick-like formations are detected; attribution runs on the largest.
- Convex pixel envelopes may overestimate slick area. Geometry is computed in metric space using existing utilities.
- The 6–9 hour age range comes from synthetic clear/positive observations and assumes detectability approximates release; it is not morphology-based precise dating.
- Hindcast and forecast reuse RK4 point advection with currents plus wind leeway. Constant fixtures omit diffusion, weathering, coast interaction and wave transport.
- Uncertainty radii are sensitivity envelopes, not calibrated confidence intervals.
- Vessel scores are transparent, uncalibrated compatibility indices. Spatial/time proximity dominates; speed/heading features check AIS consistency.
- AIS discontinuities reduce confidence and are not proof that a transponder was deliberately disabled. Interpolated gap hypotheses are never treated as observations.
- Identifying wholly unobserved non-AIS vessels requires additional sensor evidence and is not implemented.
- Existing Sentinel/CDSE and hybrid experiments are connected through explicit REAL/UPLOAD adapters, never implicitly through DEMO. A single SAR image cannot date a release: REAL/UPLOAD age is unavailable. The hindcast origin/time is a modeled analyst scenario, not observed attribution.
- Local database inspection found 24 fixes/five vessels dated September 3–4, 2026, not June 2024. They are excluded from archived-scene attribution. Matching licensed AIS and CMEMS/ERA5 trajectory coverage are external blockers.

See [technical architecture and repository audit](docs/ARCHITECTURE.md) for module responsibilities, real-data seams and production upgrades.