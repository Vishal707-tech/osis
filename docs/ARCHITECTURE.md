# O.S.I.S. technical architecture and engineering record

## Current prototype upgrade (2026-09-09)

The following contract supersedes older two-mode/complete-only descriptions in the historical design record below. See [README](../README.md) for current setup/API/resource variables and [validation record](VALIDATION.md) for measured acceptance results.

### Pre-change audit

Audited Express routes/services, React/TanStack routes/context/SVG map, both incident pipelines, PostGIS schema/views, SAR preprocessing, classical/hybrid/PoSeATSea evaluation artifacts, metric characterization, RK4/environment providers, local files and read-only AIS database inventory, Python/Node/browser tests and documentation before editing. Baseline backend/default frontend tests passed. Gaps were explicit outcomes, input uploads, bounded on-demand provider access, nullable PostGIS evidence and no-spill/error acceptance—not the scientific integrator or DEMO scoring.

Local AIS inventory was independently verified as 24 fixes from five MMSIs dated September 3–4, 2026. The repository CSVs are three detector-evaluation summaries, not historical AIS; no usable local environmental NetCDF subsets were found. None of that AIS is used for the June 2024 scene. Existing 110 MB checkpoint files and GeoTIFFs are reused locally and remain ignored, not added to Git.

### Data flow and contracts

```text
DEMO registry (spill / no-spill / inconclusive)
REAL trusted archived registry OR explicit on-demand CDSE request
UPLOAD bounded VV+VH GeoTIFF byte stream + declared metadata
  -> Express validation, admission/size guards
  -> trusted scene/path adapter (no client paths or URLs)
  -> existing Python detector/preprocessing
  -> report_contract.finalize -> exactly one outcome
       SPILL_DETECTED | NO_SPILL_DETECTED | ANALYSIS_INCONCLUSIVE
  -> valid positive evidence: characterization -> strict environment -> RK4
       independent hindcast/forecast -> observed historical AIS -> compatibility/gaps
  -> JSON archive, optional PostGIS mirror -> typed React report + footprint + diagnostics
```

`outcome` is distinct from evidence `status` (`completed`, `partial`, `no_candidates`). A positive detection can have unavailable age/environment/AIS. Inconclusive detections retain candidate masks/geometry but do not trigger new attribution. `availability: REAL_DATA_UNAVAILABLE` identifies absent provider/dependency access without introducing a fourth detection outcome. Invalid API/oversized transport errors use structured inconclusive error envelopes; accepted invalid uploads are durable inconclusive reports.

`backend/scripts/report_contract.py` supplies version 2.0, three outcomes, footprint, limitations and per-field evidence categories: OBSERVED, MODELED, INFERRED, DEMO/SYNTHETIC, UNAVAILABLE. User SAR acquisition/source is declared, not authenticated. Reanalysis is MODELED; age remains unavailable for a single real observation; the six-hour default origin time is explicitly a scenario. Existing DEMO calculations/rank ordering are unchanged.

`backend/src/services/sar-input.service.js` adapts the existing Sentinel service and strict Python SAR contract. No new framework/parser/model was installed. Uploads are two 512×512 single-band FLOAT32 EPSG:4326 GeoTIFFs. TIFF tags/shape/dtype/georeferencing/coverage are checked before inference; display photographs are unsupported. The existing hybrid detector remains the default because the recorded six-scene comparison showed a coastal standalone PoSeATSea miss recovered by fusion; this small bounding-box benchmark is not operational accuracy validation. Conservative coverage/texture/confidence gates are explicit prototype policy; classical-only dark regions cannot establish oil.

`bounded-fetch.js` limits body bytes while streaming and keeps request timeout active through body completion. CDSE uses metadata-first selection and two sequential server-cropped polarization subsets, not SAFE archive downloads. Trusted AOI ≤0.2° per side, ≤5 catalog records, one acquisition, ≤8 MiB/response, zero auto retries, 60-second cooldown, one-hour single-scene cache. Python remains two concurrent bounded processes with fixed native raster size/two torch CPU threads. Upload temporary files are deleted in finally. Report count is capped rather than silently deleting evidence; expired adapter-owned CDSE caches are cleaned, including after previous abnormal exits.

Migration 003 allows null spill/origin/image time, checks outcomes and adds a correctly named compatibility-score view without breaking legacy consumers. Local JSON remains the read archive; missing migration/database yields an explicit local-fallback persistence label. Tests run migrations and empty-evidence round-trips in a rolled-back transaction.

### Frontend and acceptance

The existing `/analysis` selection/report context remains independent of legacy fixture IDs. Report-ID keys reset raster/layers/candidate/map state. No-spill reports retain detector, timestamp, preview and footprint; inconclusive reports retain diagnostics and known footprint. Invalid uploads without georeferencing explicitly label the contextual map as not an analyzed area. Upload transfer/processing, API/network errors and retry controls are visible. Other research routes retain their existing fixture banners and loading/error views.

The original mocked-browser regression remains for fast report/layer switching, now including no-spill/inconclusive/network/upload validation. `frontend/tests/live-analysis.test.mjs` separately starts real Vite + Express + Python and drives installed Chrome through its built-in debugging protocol. It does not download a browser or satellite products. It exposed a real development hydration failure: React Store's named import from the CommonJS `use-sync-external-store` shim. Explicitly prebundling the existing shim in Vite fixes the inert SSR-only page; no dependency replacement was required. This distinction is retained in the validation record; neither automated test is a substitute for operational scientific calibration or broad visual/device acceptance.

### Remaining external boundaries

Matching licensed historical AIS, CMEMS/ERA5 trajectory coverage, authorized CDSE access, verified oil ground truth and age observations cannot be manufactured in code. The implemented adapters fail closed and preserve DEMO/UPLOAD. Authentication, distributed job queues/storage, calibrated uncertainty, weathering/coastal physics and wholly unobserved vessels remain outside this laptop SIH prototype.

## Scope

The repository now has a backend-computed incident workflow at `/analysis`, alongside the preserved research and legacy incident workflows. DEMO is a credential-free, deterministic synthetic exercise; REAL uses trusted archived SAR and strict local environment/AIS adapters with explicit partial reports when evidence is unavailable. This is an SIH prototype, not an operational surveillance service. Modeled origins and heuristic rankings are not observations or legal findings.

The DEMO design and earlier verification record below are preserved. For the current REAL contract, configuration, evidence labels, validation commands, local asset inventory and remaining blockers, see [REAL_ADAPTERS.md](REAL_ADAPTERS.md).

Installation, environment variables, database commands and API examples are in [README.md](../README.md).

## Repository audit and reuse decisions

| Existing component | Finding and treatment |
| --- | --- |
| Express backend (`backend/server.js`, `src/app.js`) | Preserved entry point, controllers and legacy routes; added an incident orchestration route. No replacement web framework. |
| PostgreSQL configuration and legacy spill/vessel/drift data | Preserved. Legacy characterization/regression tests passed against the configured database. Added bounded connection/query waits and sanitized connection-error logging. |
| `001_hindcast_schema.sql` | Preserved; depends on legacy schema. Not a fresh-database bootstrap. |
| Sentinel retrieval/processing scripts and `sentinel.service.js` | Preserved CDSE/Sentinel experiments. Availability depends on provider access, scene availability and processing prerequisites. Not silently used by the synthetic incident endpoint. |
| Classical, dual-polarization, hybrid and PoSeAtSea evaluation scripts | Preserved experimental work, generated research data and evaluation entry points. No claim that their trained-model or external dependencies are necessary for the new demo. |
| `characterize_spill.py` and characterization service | Reused metric polygon characterization and convex-hull utility directly. Legacy geometry tests passed. |
| `hindcast_runner.py`, `environment_provider.py`, hindcast service | Reused RK4 point-advection integrator rather than duplicating the drift mathematics. New constant-field fixture implements its provider interface. |
| AIS/vessel legacy routes and fixture data | Preserved. New exercise uses geographically/time-consistent generated tracks tied to its own synthetic scene, rather than mixing unrelated historical observations into an invented incident. A canonical CSV ingestion seam is available. |
| React/TanStack/Vite frontend, SVG ocean map, shared UI | Preserved stack, visual style and earlier pages. Added a dedicated computed analysis page with tile-free SVG layers and typed API calls. |
| Earlier mock values and fallback UI | Remain for the earlier interface with demo/fixture labeling. The new analysis page does not substitute these values for failed backend analysis. |
| Existing tests/build conventions | Kept legacy characterization command; added standard Node and Python tests. Fixed frontend lint/type issues without installing a new application framework. |

Before integration, the repository had useful scientific and visualization components but no single credential-independent scene-to-attribution report contract. Scene detection, characterization, modeled origin, vessel evidence and frontend fixture state were separate workflows. The new incident report is the integration boundary; old APIs are intentionally not removed.

## Current data flow

```text
POST /api/incidents/analyze
  Express validation and concurrency guard
    Python subprocess (no shell)
      seeded SAR-like scene and metadata
      invalid/land-pixel exclusion + 3x3 median filter
      adaptive dark-region threshold
      connected components + tiny-region rejection
      pixel-envelope polygons + metric characterization
      age interval from clear/positive observations
      fixture environmental provider
      existing RK4 integrator: backward and forward
      origin time window + sensitivity envelope
      generated AIS -> shared normalization
      observed-fix spatial/time filtering
      trajectory and speed/course consistency
      AIS gap hypotheses, separately labeled
      transparent weighted compatibility ranking
      provenance, uncertainty and complete report
    optional PostGIS mirror
    atomic local JSON archive
  report response
    typed frontend -> map, evidence, saved reports, JSON download
```

The report's `stages` describes completed processing stages. The UI shows a loading state during the single request, not invented real-time progress telemetry.

## Module responsibilities

### Scientific implementation

`backend/scripts/incident_pipeline.py`:

- `DemoSatelliteProvider`: deterministic 96 x 80 SAR-like dB raster, invalid/land mask, acquisition time, bounding box, VV polarization, orbit label and approximate resolution.
- `preprocess` / `detect`: median filtering, scene-median-minus-6-dB threshold, four-connected regions, minimum 12-pixel filter and convex pixel-edge polygons. Returns a mask and multiple detections; attribution uses the largest.
- `estimate_age`: derives the interval between synthetic clear and first-positive observations. Returns 6–9 hours in this exercise, central estimate 7.5 hours and low confidence.
- `FixtureEnvironmentProvider`: constant current/wind vectors and wave-height metadata. Waves are reported but do not drive advection.
- `drift`: calls the existing RK4 integrator with signed time increments; hourly points plus a fractional final backward step. Forecast horizons are 24, 48 and 72 hours.
- `normalize_ais` / `load_ais_csv`: timezone-aware normalization, coordinate/speed/course validation, deduplication and chronological sorting. CSV headers are `mmsi` (or `MMSI`), `timestamp`, `latitude`, `longitude`, `speed`, `course`; additional metadata can be retained.
- `correlate`: filters observed fixes within the inferred release window and 15 km of the central modeled origin. Long gaps split displayed tracks. Interpolated positions are hypotheses only.
- `analyze`: assembles scientific outputs, stage list, provenance and limitations.

`backend/data/demo/scenario.json` is the single synthetic scenario configuration. Four synthetic vessels are generated; the distant fourth vessel is filtered out. Demonstration MMSIs beginning `000` are not claimed real identities. Final rankings are calculated, not stored in the fixture.

### Scoring

The editable `WEIGHTS` configuration is:

| Feature | Weight | Definition |
| --- | ---: | --- |
| Origin proximity | 0.40 | Exponential decay of closest observed-fix distance, 4 km scale |
| Temporal proximity | 0.25 | Exponential decay from central release time, 2 hour scale |
| Trajectory proximity | 0.20 | Minimum distance between eligible fixes and backward path, 4 km scale |
| Speed consistency | 0.075 | Reported AIS speed versus speed inferred from adjacent non-gap fixes |
| Heading/course consistency | 0.075 | AIS course versus bearing between adjacent non-gap fixes |

Scores are uncalibrated indices on a 0–100 scale. Spatial and temporal evidence dominate by design. Trajectory proximity is a simple corridor-distance feature, not a probabilistic trajectory match; correlated spatial features can double-count evidence. The fixed search radius is a demo parameter, not an uncertainty-calibrated production search.

AIS gaps longer than one hour receive duration, endpoints, a linearly estimated position, origin-window overlap and relevance. Gaps reduce attribution confidence, not increase responsibility score. Three or fewer sparse observations cannot support strong continuity inference. Entirely unobserved vessels cannot be identified by this data source.

### Backend orchestration and persistence

- `src/services/incident.service.js`: UUIDs, bounded Python execution, report archive and optional DB mirroring.
- `src/routes/incidents.routes.js`: scene discovery, analysis, incident listing, report sections, candidate evidence and report download.
- `src/app.js`: registers the new routes and returns controlled JSON errors.
- `scripts/migrate.js`: allowlisted migration runner using transactions.
- Existing `/api/spills`, `/api/drift`, `/api/vessels`, `/api/detection` and `/api/reports` retain their original requirements.

Analysis is limited to two active subprocesses, 60 seconds and 8 MiB stdout. Python is invoked without a shell. Missing Python returns 503; timeout returns 504; invalid requests return 400. Scientific-process failures return 422. Database failures do not replace computed output with fabricated data.

Local JSON is the authoritative read store for the incident API, including when mirroring is enabled. Writes use a temporary file and rename. This is appropriate for a single-process demo, not a multi-node archival system. A corrupt archive file can currently cause listing to fail; retention, repair tooling and distributed job scheduling are future work.

### Database design

`002_incidents.sql` is additive and independent of legacy integer spill IDs:

- `osis_incidents`: UUID, detection/image timestamps, WGS84 primary spill polygon, WGS84 modeled origin point and full JSONB report.
- GiST indexes on spill/origin geometry; B-tree image-time index.
- Views: `osis_spills`, `osis_origins`, `osis_drift`, `osis_candidates`, `osis_ais_positions`, `osis_ais_anomalies`.
- JSONB preserves dimensions, confidence, age, imagery, trajectories, vessel metadata, weighted features, AIS continuity and provenance without schema duplication.
- AIS position views expose retained candidates' tracks; filtered-out raw AIS is not persisted as a normalized historical AIS warehouse.
- Candidate filtering in the new demo is in Python, not a global PostGIS AIS query.

The migration integration test applies migration 002 twice and verifies spatial geometry, JSONB and evidence views within a transaction that is rolled back. This verifies compatibility without leaving test incidents or schema changes in the user's database. Run the documented migration command to install it persistently; mirroring is disabled by default.

For production, introduce normalized partitioned AIS tables, spatial/time indexes, ingestion provenance and query-based candidate retrieval. Existing useful legacy tables should remain or be migrated explicitly.

### Frontend

`frontend/src/api/incidents.ts` defines report types and request helpers. `frontend/src/routes/analysis.tsx` provides:

- Scene and forecast selection; analysis loading, errors and empty states.
- Saved incident selection and report download.
- Tile-free map with raster, slick polygons, origin uncertainty, hindcast, forecast, candidate tracks and dashed AIS gap hypotheses.
- Timestamped trajectories, measured units, age range, environment and provenance.
- Candidate ranking and per-feature evidence selection.

Root navigation and dashboard link to this workflow. Earlier pages retain their interface and fixture labels. The generated TanStack route tree includes `/analysis`. Formatting and TypeScript fixes also touch shared map/UI components, incident context and earlier routes.

## Verification record — 2026-09-09

| Check | Result |
| --- | --- |
| `npm --prefix backend test` | Passed: HTTP integration suite plus 10 Python scientific tests. Optional DB test skipped in this command by design. |
| Explicit `OSIS_TEST_DATABASE=true` DB test | Passed: connected to configured PostgreSQL, repeatable migration, PostGIS geometry, JSONB and views; rolled back. |
| `npm --prefix backend run test:legacy` | Passed all Phase 4B characterization and Phase 4A drift regression checks, including HTTP endpoints. |
| `npm --prefix frontend run lint` | Exit 0, zero errors, 10 Fast Refresh warnings. |
| `npm --prefix frontend run build` | Exit 0, client/SSR/Nitro Cloudflare output generated. Non-blocking plugin/build-option notices remain. |
| TypeScript `--noEmit` | Exit 0. |
| Actual backend startup | Listening on port 5000; health HTTP 200. |
| Actual frontend startup | Vite listening on port 3000; `/analysis` HTTP 200 with analysis UI markup. |
| Live 48-hour analysis + report retrieval | HTTP 201; 14 stages; downloaded report equals generated report; CORS response present. |
| Browser interaction/visual automation | Not executed. HTTP/SSR delivery, types and build are verified; rendered layer interactions require a browser check. |

Scientific tests cover detection/masks/geometry, invalid/land pixels, empty/uniform/noisy rasters, age validation, backward/forward time direction, CSV normalization, candidate filtering/scoring, gap separation and deterministic report generation. HTTP tests cover validation, report sections/download, durable serialization, missing interpreter and a simulated DB outage.

Live exercise output:

- Incident: `58a1dac7-971c-4b00-84e6-1452e8d89b5e`.
- Two slick-like detections.
- Age: 6–9 hours; central estimate 7.5 hours.
- Central origin: approximately 15.224503 N, 72.397673 E at 2026-09-03 22:30 UTC.
- Origin sensitivity radius: 3.165 km, not a statistical confidence interval.
- 49 forecast points for 48 hours.
- Leading synthetic candidate: DEMO Tanker Alpha, score 73.05, nearest eligible observed fix 1.247 km from modeled origin.
- Weaker synthetic candidates: Service Gamma 49.47 and Cargo Beta 47.80.
- One two-hour AIS discontinuity.
- Durable local report, DB mirroring disabled.

## External data and credentials

The complete demo requires no external credentials, model download, tile service or paid API. Python and a writable local archive are required.

Existing real Sentinel/CDSE and environmental/provider experiments retain their provider-specific configuration and account requirements. Production AIS requires a legally usable historical dataset or licensed provider. Never put credentials into fixtures, frontend bundles or reports. Optional PostGIS operations require `DATABASE_URL`.

Bounded archived-data adapters are now wired for REAL mode, but are not production services. See [REAL_ADAPTERS.md](REAL_ADAPTERS.md). The earlier integration priorities below remain relevant beyond that constrained contract:

1. Replace scene loading with calibrated/georeferenced Sentinel-1 raster loading, preserving acquisition/projection/nodata metadata.
2. Supply real clear/positive observation evidence; otherwise return an unknown or broad age interval.
3. Implement spatially/time-varying environmental sampling through the integrator's provider interface.
4. Load and normalize the appropriately licensed AIS subset, preserving static vessel metadata and observation provenance.
5. Validate model outputs and time/geographic coverage before using the existing reporting contract.

Do not silently combine a synthetic environment or synthetic vessels with a real scene and label the report real.

## Known limitations and production priorities

- Baseline dark-region segmentation is not an oil-specific classifier; low wind and biological films can look similar.
- Convex envelopes can overestimate area and omit fine geometry.
- Release interval assumes detectability approximates release.
- Constant-field point advection omits diffusion, weathering, shore interaction and wave-driven transport.
- Ranking is an explainable compatibility heuristic, not calibrated responsibility probability.
- AIS analysis cannot establish deliberate disabling or identify wholly unobserved vessels.
- Only the largest detected slick receives attribution in the current report.
- Real acquisition, operational ML and global AIS indexing are not integrated into the demo endpoint.
- No authentication, production rate limiting, job queue or multi-tenant isolation; CORS is permissive for local development.
- Production deployment should use strict TLS verification, managed secrets, scoped CORS, authentication, durable shared storage, async jobs and readiness checks.
- The legacy database configuration includes a provider-specific TLS relaxation; review and replace with trusted CA validation before production.
- The preserved Cloudflare build target is not a standalone Node SSR production deployment. Configure hosting and public backend URL explicitly.

No external service blocker remains for the deterministic demonstration. The opt-in Chromium saved-report switching regression now passes; its mocked-API scope and commands are documented in [REAL_ADAPTERS.md](REAL_ADAPTERS.md). Scientific validation on real scenes, broader browser acceptance testing and production hardening remain separate acceptance gates.