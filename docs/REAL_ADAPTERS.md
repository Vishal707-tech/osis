# REAL archived-data adapters

## Scope and evidence labels

O.S.I.S. supports **DEMO**, **REAL**, and **UPLOAD**. DEMO remains deterministic and credential-free, including spill/no-spill/inconclusive exercises. REAL uses trusted archived Sentinel-1 subsets or explicitly requested bounded CDSE subsets; UPLOAD uses validated user-provided VV/VH GeoTIFFs. Both attempt the same strict local environmental/AIS adapters when detection passes the quality gate. No DEMO imagery, climatology, zero-filled currents, fictional vessels or seeded tracks replace missing evidence. Model weights are never downloaded. See the README for the upload byte protocol and CDSE resource guards.

- `REAL`: archived raster or operator-attested observed AIS input, not confirmation of oil or responsibility.
- `INFERRED`: experimental dark-slick geometry or heuristic vessel compatibility.
- `REAL_REANALYSIS`: CMEMS/ERA5 model products, not direct local measurements.
- `MODELED`: conditional RK4 trajectory and origin.
- `UNAVAILABLE`: evidence cannot be evaluated with the supplied inputs.

REAL release age is always `null`: one SAR image does not date a release. The default six-hour hindcast and its +/-1-hour AIS search window are analyst scenarios, **not measured age or an inferred release interval**. Even if every other stage succeeds, the report remains `partial` while age is unavailable.

## Configuration

Use operator-controlled environment variables with absolute file paths. Do not commit credentials or edit an existing `.env` as part of test setup. The sample environment file documents these options; this integration does not modify `.env`.

| Variable | Meaning |
| --- | --- |
| `PYTHON_PATH` | Main orchestration interpreter; defaults to `python`. Environmental sampling requires existing NumPy, xarray and a compatible NetCDF backend (tested with netCDF4). |
| `REAL_SAR_PYTHON` | Separate SAR interpreter; defaults to the orchestration interpreter. The existing `.venv-ml` contains the raster/ML dependencies in this workspace. |
| `REAL_MODEL_PATH` | Trusted hybrid checkpoint; defaults to `best_sar_model.pth` in the repository root. Classical detection does not load a checkpoint. |
| `REAL_CURRENT_NETCDF` | Local surface-current CMEMS subset. |
| `REAL_WIND_NETCDF` | Local ERA5 wind subset. Both current and wind are required. |
| `REAL_AIS_CSV` | Legally usable historical observed AIS subset, not a generated fixture. |
| `REAL_AIS_MANIFEST` | JSON coverage attestation for that AIS file. |
| `OSIS_REPORT_DIR` | Writable local JSON report archive; defaults to the backend data/incidents directory. |
| `OSIS_PERSIST_POSTGRES` | Optional report mirroring when exactly `true`. Apply migrations 002 + 003 to support all outcomes and nullable geometry. |

The SAR environment uses the existing NumPy, PyTorch, tifffile, OpenCV, segmentation-models-pytorch and experiment dependencies. Even classical mode currently imports the shared experiment module, so it still requires that environment. Hybrid uses CPU inference, two PyTorch threads, no encoder download and strict `weights_only=True` checkpoint loading. Use only trusted checkpoints.

## Scene registry and SAR contract

Scenes are operator-controlled entries in the backend data/real-scenes.json registry, not client-supplied paths. Registry VV/VH paths must resolve within the backend data directory. The API excludes those paths from scene listings and reports.

Current scene:

- ID: `s1a-20240619-karnataka`.
- Product: `S1A_IW_GRDH_1SDV_20240619T004837_20240619T004902_054385_069DE8_E3DA_COG.SAFE`.
- Acquisition: `2024-06-19T00:48:37Z`.
- Bounds: `[74.7, 13.2, 74.78, 13.28]` (west, south, east, north).
- Explicit raster units: `db`; `linear` is also supported when declared in the registry.

Supported rasters are single-page, single-band 512x512, north-up EPSG:4326 PixelIsArea GeoTIFF subsets, at most 8 MiB each. Pixel scale and tiepoint must match the registry bounds within 1e-6 degrees; transformation matrices are unsupported. Nonfinite, nodata and nonpositive linear values are excluded. At least 50% joint valid VV/VH coverage is required.

Detection runs at native resolution. Reports contain a 128x128 subsampled VV preview and a 4x4 max-pooled mask for display, not detection. Asset SHA-256 hashes, joint coverage, detector version and hybrid checkpoint hash are retained. The checkpoint size limit is 200 MiB.

The SAR subprocess has a 35-second timeout. Output is spooled to a temporary file and rejected above 4 MiB after the subprocess returns; this is not a live disk quota. Invalid JSON, nonfinite constants/numeric overflow, wrong scene ID, malformed top-level structures and invalid/out-of-scene centroids are rejected. Only scene, detector, detections and mask fields may update orchestration output. Missing interpreter, bad checkpoint, validation failure or timeout yields unavailable detection, not synthetic evidence.

Geometry uses simplified outer pixel-center contours, omits holes and can differ materially from native mask area. Only the largest retained candidate is backtracked. Scores are uncalibrated compatibility indices, not probability of oil. Low wind, biological films and land artifacts remain possible lookalikes.

## Environmental NetCDF contract

Supply small, rectilinear, CF-decodable subsets in UTC with coverage around the entire modeled trajectory, not only the image footprint. Each file and each decoded selected component must be at most 128 MiB.

| Requirement | Current | Wind |
| --- | --- | --- |
| Variables | `uo`, `vo` | `u10`, `v10` |
| Units on every component | `m/s`, `m s-1` or `m s**-1` | Same |
| Maximum nearest timestamp offset | 13 hours | 1 hour |
| Maximum nearest coordinate offset, per axis | 0.15 degrees | 0.3 degrees |

Coordinates must be nonempty, one-dimensional, finite and strictly monotonic (ascending or descending). Required names are `latitude`, `longitude`, `time`; aliases `lat`, `lon`, `valid_time` are accepted. Time must decode to NumPy datetime64, not an unsupported calendar/object array. After optional surface-depth selection, component dimensions must be exactly time/latitude/longitude, in any order. Extra ensemble dimensions and curvilinear grids are unsupported. If depth exists, the shallowest level must be nonnegative and within 1 m of the surface.

Sampling uses nearest neighbors, never interpolation, extrapolation or missing-value replacement. Negative query longitudes are normalized only for a clearly 0..360 grid. Every RK4 sample and every returned trajectory point must lie inside both files' spatial/time bounds and meet the offset tolerances. Interior temporal gaps and missing values can therefore invalidate a trajectory even when file start/end dates cover it. Both fields must first be valid at detection time. Hindcast and forecast are then attempted independently: failure of one does not erase the other.

Original xarray dataset handles are retained and closed even when renamed/depth-selected views are used, including failure paths on Windows. Lazy read errors become sanitized unavailable reasons and preserve prior SAR evidence.

Leeway is assumed to be 0.03 and velocity sensitivity 0.15 m/s. The point-advection model omits diffusion, weathering, coastline interaction and waves; sensitivity radii are not calibrated confidence bounds.

## Historical AIS contract

The observed CSV is at most 8 MiB and 20,000 rows. Required headers are `mmsi` (or `MMSI`), `timestamp`, `latitude`, `longitude`; speed/course/heading and identity are retained where available. Missing speed/course remain null and contribute no invented consistency evidence. Timestamps require a timezone, coordinates use WGS84, speed uses knots and course degrees. Normalization rejects malformed/nonfinite fixes and deduplicates observations.

The JSON manifest is at most 64 KiB and requires:

| Key | Value/semantics |
| --- | --- |
| `source` | Nonempty description of the actual provider/dataset. |
| `dataKind` | Exactly `observed`; do not attest generated data as observed. |
| `speedUnits` | Exactly `knots`. |
| `courseUnits` | Exactly `degrees`. |
| `bbox` | Four numbers in west/south/east/north order. |
| `start`, `end` | Timezone-qualified coverage timestamps. |

The attested region must cover the +/-15 km latitude/longitude search box around the modeled origin, and the time range must cover its +/-1-hour scenario window. Rows are filtered to that region/window before correlation. Empty or wrong-period coverage is `unavailable`, not evidence that no vessel was present. File and manifest hashes, rejection counts and the operator-attested coverage caveat are retained.

REAL never queries the seeded `vessel_tracks` table. Existing distance/time/trajectory scoring is reused; AIS gaps do not establish deliberate disabling, guilt or responsibility, and gaps are not interpolated as observations. Receiver completeness and the truth of an operator's source attestation are not independently verified.

## API, status and persistence

`GET /api/incidents/scenes` lists explicit DEMO/REAL scenes. Example request to `POST /api/incidents/analyze`:

```json
{
  "mode": "REAL",
  "sceneId": "s1a-20240619-karnataka",
  "detector": "hybrid",
  "hindcastHours": 6,
  "forecastHours": 24
}
```

Supported detectors are `classical` and `hybrid`; hindcast must be 1-48 hours, forecast 24/48/72 hours. Unknown fields/scenes and invalid scenarios return HTTP 400. The service allows two active analyses, bounds pipeline output to 8 MiB and times out at 60 seconds. Missing main Python is HTTP 503; this differs from a missing SAR interpreter, which produces a locally saved partial report with HTTP 201.

- `partial`: available evidence retained; unavailable fields are null or empty arrays with explicit `stageStatus` reasons.
- `no_candidates`: detector completed without retained candidates; not detector failure and not proof of clean water.
- `completed`: used by the full DEMO workflow; current REAL age limitations prevent this status.

An environmental `completed` stage means initial fields were valid at detection; consult individual hindcast/forecast stages for full trajectory coverage. The `stages` list contains successful stages only. AIS/attribution require a usable modeled origin, regardless of whether forecast succeeds.

Reports are atomically archived as local JSON and retrieved without recomputation. With migration 003 PostgreSQL accepts all three outcomes; a missing migration/database yields `unavailable_local_fallback`. `outcome` is SPILL_DETECTED / NO_SPILL_DETECTED / ANALYSIS_INCONCLUSIVE, independently of partial downstream evidence. Unavailable SAR/provider access is also labeled REAL_DATA_UNAVAILABLE. Report/map state remains keyed by report ID and independent of next-scene selection and legacy fixtures.

## Verification commands (PowerShell)

These commands use the current workspace's absolute path. Adjust `$repo` when cloning elsewhere. Tests use temporary generated fixtures only; those fixtures are never runtime REAL assets.

```powershell
$repo = 'c:/Users/VINEET SINGH/OneDrive/Desktop/OSIS/SIH-PS26143 - Copy'
Set-Location "$repo/backend"
npm.cmd test
python -m unittest discover -s tests -p 'test_*.py' -v
& "$repo/.venv-ml/Scripts/python.exe" -m unittest discover -s tests -p 'test_*.py' -v
node "$repo/backend/scripts/test_phase4b_characterization.js"

# Actual archived-raster/checkpoint HTTP integration, no mock SAR output.
$env:OSIS_TEST_REAL_SAR = 'true'
$env:REAL_SAR_PYTHON = "$repo/.venv-ml/Scripts/python.exe"
node --test "$repo/backend/tests/real-incidents.test.js"
Remove-Item Env:OSIS_TEST_REAL_SAR

Set-Location "$repo/frontend"
npm.cmd test
# Optional installed Chromium; no browser download or additional npm framework.
$env:OSIS_TEST_BROWSER = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node --test "$repo/frontend/tests/saved-reports.test.mjs"
Remove-Item Env:OSIS_TEST_BROWSER
& "$repo/frontend/node_modules/.bin/tsc.cmd" --noEmit
npm.cmd run build
git -C $repo diff --check
```

The default interpreter in this workspace supports NetCDF but skips four ML raster tests. The ML interpreter runs those raster tests and skips the NetCDF class; run both suites rather than treating skipped tests as validated. Database migration testing is separately opt-in via `OSIS_TEST_DATABASE=true`. Legacy characterization needs the configured database and its existing API prerequisites.

The actual-raster HTTP test deliberately makes environment/AIS assets unavailable, checks both detectors, hashes, null stages, report endpoints and local JSON round-trips. Database calls are intercepted to exercise mirror outage without querying seeded AIS. Frontend server-render tests cover report variants. The mocked-browser regression covers report switching, raster/layer reset, no-spill/inconclusive/network/upload validation. The separate live acceptance test starts Vite/Express/Python and drives installed Chrome, including actual local SAR upload when enabled. Temporary test profiles/products are removed afterward; no browser framework is installed.

The browser harness is not a production-server end-to-end or visual acceptance test. Download behavior, pan/zoom gestures, responsive styling, all REAL report variants and external API failures still need broader browser acceptance. Without `OSIS_TEST_BROWSER`, that test is explicitly skipped.

### Superseded archived-adapter validation record (2026-09-09)

The following counts describe the earlier two-mode snapshot only, not the current acceptance suite. Logs were recovered and baseline suites rerun during the current audit; current verified results are maintained in [VALIDATION.md](VALIDATION.md). In particular, the current missing-Chrome cleanup probe took approximately 1.2 seconds, not the earlier “under one second” claim.

- Backend `npm.cmd test` with archived SAR enabled: two Node tests passed, opt-in database migration test skipped; Python ran 40 tests with four ML-dependent skips.
- Complementary ML interpreter: 40 Python tests, nine NetCDF-dependent skips; no failures. Together the two interpreters exercised all 40 Python tests.
- Actual archived classical and hybrid HTTP reports: local JSON and API round-trips passed; zero database queries in that test.
- Late environmental-read failure and independent hindcast/forecast failure regressions passed, retaining serializable partial reports.
- Legacy Phase 4B characterization and Phase 4A regression checks passed against the configured database.
- Frontend: all six tests passed with Chromium enabled. With `OSIS_TEST_BROWSER` unset, normal `npm.cmd test` discovered all six, passed five and explicitly skipped the browser test. No test directories or test-profile Chrome processes remained after the successful run.
- The intentional nonexistent-browser probe returned `ENOENT`; the earlier under-one-second timing claim is superseded by the current measured approximately 1.2-second run. The runner clears its deadline even on failed launch, and no test directory remained.
- TypeScript, Prettier checks on the analysis route and frontend tests, and production build passed. Build emitted configuration warnings, not errors.
- Git whitespace validation passed. Existing `.env` was not edited.

## Local asset inventory and remaining blockers (2026-09-09)

- Archived classical/hybrid HTTP detection succeeded with 90.29% joint valid coverage. Classical retained 12 experimental candidates; hybrid retained one with contour area 0.028 km² and mask area 0.033371 km². These are software smoke-test observations, not oil-detection accuracy claims or ground truth.
- A recursive inspection of the backend data directory found no `.nc`, `.nc4` or `.netcdf` subsets and only three CSVs, all detector evaluation summaries rather than AIS fixes. All four REAL environment/AIS variables were unset in the inspected shell. This is a local inventory, not proof that compatible assets are unavailable elsewhere or unconfigured in another process.
- A read-only database inventory found 24 fixes for five vessels, spanning `2026-09-03T15:30:00Z` to `2026-09-04T00:00:00Z`. Those fixes cannot support the June 2024 SAR scene and are deliberately excluded from REAL.
- Compatible licensed historical AIS and CMEMS/ERA5 subsets covering the scene **and each modeled trajectory** remain the operational data blockers. No fully observational scene-to-vessel attribution has been validated. Age would still remain unavailable with those assets.
- Production authentication, asynchronous jobs, shared durable storage, scientific calibration and broader browser acceptance remain outside this archived-data integration.