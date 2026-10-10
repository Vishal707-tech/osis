'use strict';

/**
 * ===========================================================================
 * O.S.I.S. — Oil Spill Identification System
 * hindcast.service.js  —  Phase 3 Node.js ↔ Python integration layer
 * ===========================================================================
 *
 * Responsibilities
 * ─────────────────
 *  1. Fetch the spill record from PostgreSQL (centroid, age, polygon,
 *     detected_at).
 *  2. Validate: spill exists, centroid is set, estimated_age_hours > 0.
 *  3. Spawn hindcast_runner.py via child_process.spawn (Windows-safe;
 *     no shell interpolation of user data).
 *  4. Capture stdout (JSON) and stderr (diagnostics) separately.
 *  5. Apply a 120-second hard timeout.
 *  6. Parse and validate the Python JSON result.
 *  7. Persist to PostgreSQL in a single atomic transaction:
 *       BEGIN
 *         INSERT hindcast_runs  (status = 'running')
 *         INSERT drift_predictions  (one row per trajectory step)
 *         UPDATE hindcast_runs SET status = 'completed'
 *       COMMIT
 *     ROLLBACK on any failure.
 *  8. Return { runId, spillId, pythonResult } to the controller.
 *
 * PostGIS geometry convention (CRITICAL)
 * ──────────────────────────────────────
 *  ST_MakePoint(longitude, latitude)   ← PostGIS always wants lon first
 *  Python JSON returns [lat, lon]       ← must swap before building WKT
 *
 * Python executable
 * ─────────────────
 *  process.env.PYTHON_PATH || 'python'
 *  Works on Windows without requiring python3.
 * ===========================================================================
 */

const { spawn }  = require('child_process');
const path       = require('path');
const pool       = require('../config/db');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PYTHON_EXE    = process.env.PYTHON_PATH || 'python';
const SCRIPT_PATH   = path.resolve(__dirname, '../../scripts/hindcast_runner.py');
const TIMEOUT_MS    = 180_000;          // 180 seconds
const ENSEMBLE_SIZE = 50;
const TIMESTEP_S    = 3600;
const LEEWAY        = 0.03;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert the Python hull_polygon [[lat,lon],...] into a PostGIS-compatible
 * WKT POLYGON string.
 *
 * PostGIS expects: POLYGON((lon lat, lon lat, ...))
 * Python returns:  [[lat, lon], ...]
 *
 * Returns null if the hull has fewer than 3 distinct points.
 */
function hullToWkt(hullPolygon) {
  if (!Array.isArray(hullPolygon) || hullPolygon.length < 3) return null;
  try {
    // Swap [lat,lon] → "lon lat"
    const coords = hullPolygon.map(([lat, lon]) => `${lon} ${lat}`);
    // Close the ring
    coords.push(coords[0]);
    return `POLYGON((${coords.join(', ')}))`;
  } catch {
    return null;
  }
}

/**
 * Extract a valid GeoJSON polygon ring from the spill's geometry so it can
 * be forwarded to Python as --polygon "[[lat,lon],...]".
 *
 * The DB stores geom in PostGIS; we query ST_AsGeoJSON which returns
 * GeoJSON with coordinates in [lon, lat] order.  Python expects [lat, lon].
 *
 * Returns null if no usable polygon is found.
 */
function extractSpillPolygon(geojsonStr) {
  if (!geojsonStr) return null;
  try {
    const gj = JSON.parse(geojsonStr);
    const ring = gj.coordinates && gj.coordinates[0];
    if (!ring || ring.length < 4) return null;          // need at least 3 + close
    // GeoJSON: [lon, lat] → Python expects [lat, lon]
    return ring.map(([lon, lat]) => [lat, lon]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * runHindcast(spillId)
 *
 * @param {number} spillId  - integer primary key from the spills table
 * @returns {Promise<{runId:number, spillId:number, pythonResult:object}>}
 * @throws  {Object}  { code: 'NOT_FOUND'|'VALIDATION'|'PYTHON'|'DB', message }
 */
async function runHindcast(spillId) {
  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Fetch spill from DB
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`[hindcast] Starting hindcast for spill_id=${spillId}`);

  const spillRes = await pool.query(
    `SELECT
       id,
       ST_Y(centroid)          AS lat,
       ST_X(centroid)          AS lon,
       estimated_age_hours,
       detected_at,
       ST_AsGeoJSON(geom)      AS geojson
     FROM spills
     WHERE id = $1`,
    [spillId]
  );

  if (spillRes.rows.length === 0) {
    throw { code: 'NOT_FOUND', message: `Spill ${spillId} not found` };
  }

  const spill = spillRes.rows[0];

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Validate
  // ─────────────────────────────────────────────────────────────────────────
  if (spill.lat == null || spill.lon == null) {
    throw { code: 'VALIDATION', message: 'Spill centroid is not set' };
  }
  const ageHours = parseFloat(spill.estimated_age_hours);
  if (!isFinite(ageHours) || ageHours <= 0) {
    throw {
      code: 'VALIDATION',
      message: `estimated_age_hours is invalid (${spill.estimated_age_hours})`
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: Build Python CLI args
  // ─────────────────────────────────────────────────────────────────────────
  const lat = parseFloat(spill.lat);
  const lon = parseFloat(spill.lon);

  // Format obs-time as ISO-8601 UTC string
  const obsTime = spill.detected_at instanceof Date
    ? spill.detected_at.toISOString().replace('.000Z', 'Z')
    : String(spill.detected_at).replace(' ', 'T') + 'Z';

  const pyArgs = [
    SCRIPT_PATH,
    '--lat',           String(lat),
    '--lon',           String(lon),
    '--age-hours',     String(ageHours),
    '--ensemble-size', String(ENSEMBLE_SIZE),
    '--timestep',      String(TIMESTEP_S),
    '--leeway',        String(LEEWAY),
    '--obs-time',      obsTime,
  ];

  // Optional polygon
  const polygon = extractSpillPolygon(spill.geojson);
  if (polygon) {
    pyArgs.push('--polygon', JSON.stringify(polygon));
  }

  console.log(`[hindcast] Spawning Python: ${PYTHON_EXE} ${SCRIPT_PATH}`);
  console.log(`[hindcast] Args: lat=${lat}, lon=${lon}, age=${ageHours}h, obs=${obsTime}, polygon=${polygon ? 'yes' : 'no'}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4–5: Spawn Python and capture output
  // ─────────────────────────────────────────────────────────────────────────
  const pythonResult = await spawnPython(pyArgs);

  console.log(`[hindcast] Python completed. Steps=${pythonResult.n_steps}, particles=${pythonResult.actual_particle_count}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Step 6: Persist to DB (transactional)
  // ─────────────────────────────────────────────────────────────────────────
  const runId = await persistHindcast(spillId, pythonResult);

  console.log(`[hindcast] Persistence complete. run_id=${runId}`);

  return { runId, spillId, pythonResult };
}

// ---------------------------------------------------------------------------
// Python process management
// ---------------------------------------------------------------------------

/**
 * Spawn the Python hindcast engine and return the parsed JSON result.
 * Rejects on: spawn failure, timeout, non-zero exit, invalid JSON,
 *             or Python result.status !== 'completed'.
 */
function spawnPython(pyArgs) {
  return new Promise((resolve, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut  = false;
    let proc;

    try {
      proc = spawn(PYTHON_EXE, pyArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,          // suppress console window on Windows
      });
    } catch (spawnErr) {
      return reject({
        code: 'PYTHON',
        message: `Failed to spawn Python process: ${spawnErr.message}`
      });
    }

    // Hard timeout
    const timer = setTimeout(() => {
      timedOut = true;
      console.warn('[hindcast] Python process timed out — sending SIGTERM');
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3000);
      reject({ code: 'PYTHON', message: 'Python process timed out after 120 s' });
    }, TIMEOUT_MS);

    proc.stdout.on('data', chunk => { stdoutBuf += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });

    proc.on('error', err => {
      clearTimeout(timer);
      if (!timedOut) {
        reject({
          code: 'PYTHON',
          message: `Python process error: ${err.message}`
        });
      }
    });

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      if (timedOut) return;

      // Log stderr as diagnostics (not credentials / not the full particle ensemble)
      if (stderrBuf.trim()) {
        console.warn('[hindcast] Python stderr:', stderrBuf.trim().slice(0, 500));
      }

      if (exitCode !== 0) {
        // Try to extract error from stdout JSON if present
        let errMsg = `Python exited with code ${exitCode}`;
        try {
          const parsed = JSON.parse(stdoutBuf);
          if (parsed.errors) errMsg += `: ${parsed.errors.join('; ')}`;
        } catch { /* stdout not JSON */ }
        return reject({ code: 'PYTHON', message: errMsg });
      }

      if (!stdoutBuf.trim()) {
        return reject({ code: 'PYTHON', message: 'Python produced no output' });
      }

      let parsed;
      try {
        parsed = JSON.parse(stdoutBuf);
      } catch (jsonErr) {
        return reject({
          code: 'PYTHON',
          message: `Python output is not valid JSON: ${jsonErr.message}`
        });
      }

      if (parsed.status !== 'completed') {
        const errs = Array.isArray(parsed.errors) ? parsed.errors.join('; ') : parsed.status;
        return reject({ code: 'PYTHON', message: `Python reported failure: ${errs}` });
      }

      resolve(parsed);
    });
  });
}

// ---------------------------------------------------------------------------
// Database persistence (single transaction)
// ---------------------------------------------------------------------------

/**
 * Persist a completed Python hindcast result to PostgreSQL.
 *
 * @param {number} spillId
 * @param {object} r  - parsed Python JSON
 * @returns {Promise<number>} runId
 */
async function persistHindcast(spillId, r) {
  console.log(`[hindcast] DB persistence started for spill_id=${spillId}`);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── 1. Create hindcast_runs row (status = 'running') ─────────────────
    const originLat  = r.origin.lat;
    const originLon  = r.origin.lon;
    const hullWkt    = hullToWkt(r.origin.hull_polygon);

    const runInsertSQL = `
      INSERT INTO hindcast_runs (
        spill_id,
        status,
        physics_model,
        data_source,
        ensemble_size,
        timestep_seconds,
        hmax_hours,
        leeway,
        release_window_start,
        release_window_end,
        origin_timestamp,
        origin_centroid,
        origin_polygon,
        origin_uncertainty_km,
        origin_major_axis_km,
        origin_minor_axis_km,
        origin_orientation_deg,
        created_at
      ) VALUES (
        $1,  $2,  $3,  $4,  $5,
        $6,  $7,  $8,  $9,  $10,
        $11,
        ST_SetSRID(ST_MakePoint($12, $13), 4326),
        CASE WHEN $14::text IS NOT NULL
             THEN ST_SetSRID(ST_GeomFromText($14), 4326)
             ELSE NULL END,
        $15, $16, $17, $18,
        NOW()
      )
      RETURNING id`;

    const runValues = [
      spillId,                                        // $1
      'running',                                      // $2  status
      r.physics_model,                                // $3
      r.data_source,                                  // $4
      r.ensemble_size,                                // $5
      r.timestep_seconds,                             // $6
      r.hmax_hours,                                   // $7
      r.leeway,                                       // $8
      r.release_window.earliest_utc,                  // $9  release_window_start
      r.release_window.latest_utc,                    // $10 release_window_end
      r.release_window.center_utc,                    // $11 origin_timestamp
      originLon,                                      // $12 ST_MakePoint(lon, lat)
      originLat,                                      // $13
      hullWkt,                                        // $14 polygon WKT (nullable)
      r.origin.uncertainty_radius_km,                 // $15
      r.origin.major_axis_km,                         // $16
      r.origin.minor_axis_km,                         // $17
      r.origin.orientation_deg,                       // $18
    ];

    const runRes = await client.query(runInsertSQL, runValues);
    const runId  = runRes.rows[0].id;

    // ── 2. Insert drift_predictions (one row per trajectory step) ─────────
    //
    // We store the ensemble MEDIAN position for each step — NOT individual
    // particles.  Direction is always 'backward'.
    //
    const dpSQL = `
      INSERT INTO drift_predictions (
        spill_id,
        run_id,
        step_index,
        timestamp,
        geom,
        direction,
        sigma_km,
        ensemble_spread_km,
        current_speed_ms,
        wind_speed_ms
      ) VALUES (
        $1, $2, $3, $4,
        ST_SetSRID(ST_MakePoint($5, $6), 4326),
        'backward',
        $7, $8, $9, $10
      )`;

    for (const step of r.trajectory) {
      await client.query(dpSQL, [
        spillId,                      // $1
        runId,                        // $2
        step.step,                    // $3  step_index
        step.timestamp_utc,           // $4
        step.median_lon,              // $5  ST_MakePoint(lon, lat)
        step.median_lat,              // $6
        step.sigma_km,                // $7
        step.ensemble_spread_km,      // $8
        step.current_speed_ms,        // $9
        step.wind_speed_ms,           // $10
      ]);
    }

    // ── 3. Mark run as completed ──────────────────────────────────────────
    await client.query(
      `UPDATE hindcast_runs
       SET status = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [runId]
    );

    await client.query('COMMIT');
    console.log(`[hindcast] DB persistence complete. run_id=${runId}, trajectory_rows=${r.trajectory.length}`);
    return runId;

  } catch (dbErr) {
    await client.query('ROLLBACK');
    console.error('[hindcast] DB transaction rolled back:', dbErr.message);
    throw { code: 'DB', message: `Database persistence failed: ${dbErr.message}` };
  } finally {
    client.release();
  }
}

module.exports = { runHindcast };
