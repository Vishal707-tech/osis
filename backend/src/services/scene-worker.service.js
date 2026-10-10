'use strict';
/**
 * scene-worker.service.js
 * ========================
 * DAY 2 — Acquisition worker for queued Sentinel-1 scenes.
 *
 * Responsibilities:
 *   1. Atomically claim ONE queued scene at a time using
 *      SELECT … FOR UPDATE SKIP LOCKED — safe for multiple concurrent workers.
 *   2. Download the scene's VV+VH GeoTIFF rasters via the existing
 *      sentinel.service.js getSentinel1GrdImage (no new CDSE auth).
 *   3. Save rasters to the local scenes data directory.
 *   4. Write artifact_metadata JSONB and advance status to 'completed'.
 *   5. On any failure: status → 'failed', error recorded, worker continues.
 *   6. Stale-processing recovery: scenes stuck in 'processing' for longer
 *      than OSIS_WORKER_STALE_MS are reset to 'queued' on worker start.
 *
 * Does NOT:
 *   - Run SAR detection, drift, AIS, or any incident pipeline (Day 3+).
 *   - Duplicate CDSE authentication (reuses sentinel.service cachedToken).
 *   - Expose credentials in logs.
 *   - Modify any Day 1 poller behaviour.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const pool = require('../config/db');
const sentinel = require('./sentinel.service');
const incidentService = require('./incident.service');
const poller = require('./scene-poller.service');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Directory where acquired scene rasters are stored.
 * Default: backend/data/scenes/  (never committed to git — add to .gitignore)
 */
const SCENES_DIR = (() => {
  const raw = process.env.OSIS_SCENES_DIR;
  if (raw && typeof raw === 'string' && raw.trim()) return path.resolve(raw.trim());
  return path.resolve(__dirname, '../../data/scenes');
})();

/** Worker polling interval in milliseconds. Default: 30 seconds. */
const WORKER_INTERVAL_MS = (() => {
  const v = parseInt(process.env.OSIS_WORKER_INTERVAL_MS, 10);
  return Number.isFinite(v) && v >= 5000 ? v : 30000;
})();

/**
 * How long (ms) before a 'processing' scene is considered stale and
 * eligible for reset back to 'queued'. Default: 10 minutes.
 * Must be longer than the longest realistic download time.
 */
const STALE_MS = (() => {
  const v = parseInt(process.env.OSIS_WORKER_STALE_MS, 10);
  return Number.isFinite(v) && v >= 60000 ? v : 10 * 60 * 1000;
})();

/** Unique ID for this worker instance (helps multi-worker debugging). */
const WORKER_ID = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _timer = null;
let _running = false;
let _inFlight = false;   // prevents concurrent processNextScene calls
let _processedCount = 0;
let _failedCount = 0;
let _lastActivity = null;
let _lastError = null;

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Reset scenes stuck in 'processing' back to 'queued', or mark them 'failed'
 * if retry_count reaches 3 (or higher).
 * During stale recovery, retry_count is incremented.
 *
 * @returns {Promise<{recovered: number, failed: number}>} counts of re-queued and failed scenes
 */
async function recoverStaleScenes() {
  const cutoff = new Date(Date.now() - STALE_MS);

  // 1. Stale scenes whose incremented retry_count reaches or exceeds 3 -> mark 'failed'
  const failedResult = await pool.query(
    `UPDATE processed_scenes
        SET status        = 'failed',
            processing_at = NULL,
            worker_id     = NULL,
            retry_count   = COALESCE(retry_count, 0) + 1,
            error_message = CONCAT(COALESCE(error_message, ''), ' [stale recovery: retry limit reached]')
      WHERE status = 'processing'
        AND processing_at < $1
        AND COALESCE(retry_count, 0) >= 2`,
    [cutoff]
  );

  // 2. Stale scenes whose incremented retry_count is < 3 -> re-queue
  const recoveredResult = await pool.query(
    `UPDATE processed_scenes
        SET status        = 'queued',
            processing_at = NULL,
            worker_id     = NULL,
            retry_count   = COALESCE(retry_count, 0) + 1,
            error_message = CONCAT(COALESCE(error_message, ''), ' [reset: stale processing recovered]')
      WHERE status = 'processing'
        AND processing_at < $1
        AND COALESCE(retry_count, 0) < 2`,
    [cutoff]
  );

  return {
    recovered: recoveredResult.rowCount,
    failed: failedResult.rowCount,
  };
}

/**
 * Atomically claim the oldest queued scene.
 * Uses SELECT … FOR UPDATE SKIP LOCKED so two workers never claim the same row.
 * @returns {Promise<Object|null>} the claimed scene row, or null if queue empty
 */
async function claimNextScene() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, scene_id, collection, bbox, acquired_at, polarization,
              platform, orbit_direction, stac_feature, artifact_metadata
         FROM processed_scenes
        WHERE status = 'queued'
        ORDER BY acquired_at ASC NULLS LAST
        FOR UPDATE SKIP LOCKED
        LIMIT 1`
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const scene = rows[0];
    await client.query(
      `UPDATE processed_scenes
          SET status        = 'processing',
              processing_at = NOW(),
              worker_id     = $1,
              error_message = NULL
        WHERE id = $2`,
      [WORKER_ID, scene.id]
    );

    await client.query('COMMIT');
    return scene;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Atomically claim only the requested queued scene. */
async function claimSceneById(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, scene_id, collection, bbox, acquired_at, polarization,
              platform, orbit_direction, stac_feature, artifact_metadata
         FROM processed_scenes
        WHERE id = $1 AND status = 'queued'
        FOR UPDATE SKIP LOCKED`,
      [id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const scene = rows[0];
    await client.query(
      `UPDATE processed_scenes
          SET status = 'processing', processing_at = NOW(), worker_id = $1,
              error_message = NULL
        WHERE id = $2`,
      [WORKER_ID, scene.id]
    );
    await client.query('COMMIT');
    return scene;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark a scene as successfully completed, storing artifact metadata.
 * @param {number} id - processed_scenes.id
 * @param {Object} artifact - metadata about the acquired files
 */
async function markCompleted(id, artifact) {
  await pool.query(
    `UPDATE processed_scenes
        SET status            = 'completed',
            completed_at      = NOW(),
            artifact_metadata = $1::jsonb,
            error_message     = NULL
      WHERE id = $2`,
    [JSON.stringify(artifact), id]
  );
}

/**
 * Mark a scene as failed, recording a sanitised error message.
 * The retry_count is incremented so future tooling can apply backoff.
 * @param {number} id - processed_scenes.id
 * @param {string} message - safe error message (no credentials)
 */
async function markFailed(id, message) {
  // Truncate at 1000 chars; never log raw error objects that may contain tokens
  const safe = String(message || 'Unknown acquisition error').slice(0, 1000);
  await pool.query(
    `UPDATE processed_scenes
        SET status        = 'failed',
            error_message = $1,
            retry_count   = retry_count + 1
      WHERE id = $2`,
    [safe, id]
  );
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the scenes directory and a per-scene subdirectory exist.
 * The subdirectory name is derived from scene_id sanitised to filesystem-safe chars.
 * @param {string} sceneId - CDSE STAC scene ID
 * @returns {Promise<string>} absolute path to the scene directory
 */
async function ensureSceneDir(sceneId) {
  // Sanitise: keep only alphanumeric, dash, underscore, dot — prevent traversal
  const safe = String(sceneId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  if (!safe) throw new Error('Invalid scene_id: cannot construct safe directory name');

  const sceneDir = path.join(SCENES_DIR, safe);

  // Guard: final resolved path must still be inside SCENES_DIR
  const resolved = path.resolve(sceneDir);
  if (!resolved.startsWith(path.resolve(SCENES_DIR) + path.sep) &&
    resolved !== path.resolve(SCENES_DIR)) {
    throw new Error(`Path traversal detected for scene_id: ${sceneId}`);
  }

  await fs.mkdir(sceneDir, { recursive: true });
  return sceneDir;
}

// ---------------------------------------------------------------------------
// Core acquisition
// ---------------------------------------------------------------------------

/**
 * Download VV and VH rasters for the given scene and save to disk.
 * Reuses sentinel.service.js getSentinel1GrdImage — no duplicate auth.
 *
 * The scene's bbox comes from the STAC feature stored in processed_scenes.
 * The acquisition time window is derived from acquired_at (30-second window,
 * matching the existing sar-input.service.js onDemand convention).
 *
 * @param {Object} scene - row from processed_scenes
 * @returns {Promise<Object>} artifact metadata written to artifact_metadata
 */
async function acquireScene(scene) {
  const { scene_id, bbox: bboxRaw, acquired_at, stac_feature } = scene;

  const parseBbox = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return null;
    try { return JSON.parse(value); } catch (_) { return null; }
  };
  const metadata = typeof scene.artifact_metadata === 'string'
    ? JSON.parse(scene.artifact_metadata)
    : (scene.artifact_metadata || {});
  const feat = typeof stac_feature === 'string' ? JSON.parse(stac_feature) : (stac_feature || {});
  const storedBbox = parseBbox(bboxRaw);
  const fullSceneBbox = parseBbox(feat.bbox) || parseBbox(metadata.bbox) || storedBbox;
  const replayBbox = parseBbox(metadata.acquisitionBbox);
  let acquisitionBbox = replayBbox || storedBbox;
  const isSubsetBbox = (bbox) =>
    Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite) &&
    bbox[2] > bbox[0] && bbox[3] > bbox[1] &&
    bbox[2] - bbox[0] <= 0.2 && bbox[3] - bbox[1] <= 0.2;
  const isWithinScene = (bbox) => {
    if (!Array.isArray(fullSceneBbox) || fullSceneBbox.length !== 4 ||
        !fullSceneBbox.every(Number.isFinite)) return false;
    const [sceneMinLon, sceneMinLat, sceneMaxLon, sceneMaxLat] = fullSceneBbox;
    const [aoiMinLon, aoiMinLat, aoiMaxLon, aoiMaxLat] = bbox;
    const eps = 0.0001;
    return aoiMinLon >= sceneMinLon - eps && aoiMaxLon <= sceneMaxLon + eps &&
      aoiMinLat >= sceneMinLat - eps && aoiMaxLat <= sceneMaxLat + eps;
  };

  if (replayBbox && (!isSubsetBbox(replayBbox) || !isWithinScene(replayBbox))) {
    throw new Error(`Scene ${scene_id}: Stored replay acquisition bbox is invalid or outside the STAC scene footprint`);
  }

  if (!replayBbox && !isSubsetBbox(acquisitionBbox)) {
    acquisitionBbox = (poller.PRIORITY_AREAS || [])
      .map((area) => area.bbox)
      .find((bbox) => isSubsetBbox(bbox) && isWithinScene(bbox));
    if (!acquisitionBbox) {
      throw new Error(`Scene ${scene_id}: no configured <=0.2 degree acquisition bbox is within the STAC scene footprint`);
    }
  }

  // --- Verify AOI containment ---
  // Verify that the selected acquisitionBbox is actually within the fullSceneBbox
  if (!isSubsetBbox(acquisitionBbox) || !isWithinScene(acquisitionBbox)) {
    throw new Error(`Scene ${scene_id}: Acquisition bbox [${acquisitionBbox.join(',')}] is invalid or outside the scene footprint [${fullSceneBbox}]`);
  }

  // --- Resolve acquisition timestamp ---
  if (!acquired_at) {
    throw new Error(`Scene ${scene_id}: no acquired_at timestamp — cannot derive download window`);
  }
  const fromTime = new Date(acquired_at).toISOString();
  const toTime = new Date(new Date(acquired_at).getTime() + 30000).toISOString(); // 30-second window (same as onDemand)

  // --- Ensure output directory ---
  const sceneDir = await ensureSceneDir(scene_id);

  // --- Download VV then VH sequentially (bounded-fetch allows max 2 concurrent; be conservative) ---
  const paths = {};
  const tiffMeta = {};

  for (const pol of ['VV', 'VH']) {
    const destPath = path.join(sceneDir, `${pol.toLowerCase()}.tif`);

    // Skip if already downloaded (idempotent for partial retries)
    let alreadyExists = false;
    try {
      await fs.access(destPath);
      alreadyExists = true;
    } catch (_) { }

    let buffer;
    if (alreadyExists) {
      // Re-read to get file size for metadata
      const stat = await fs.stat(destPath);
      tiffMeta[pol] = { sizeBytes: stat.size, fromCache: true };
    } else {
      const result = await sentinel.getSentinel1GrdImage({
        bbox: acquisitionBbox,
        from: fromTime,
        to: toTime,
        width: 512,
        height: 512,
        polarization: pol,
      });
      buffer = result.buffer;
      await fs.writeFile(destPath, buffer, { flag: 'w' });
      tiffMeta[pol] = { sizeBytes: buffer.length, fromCache: false };
    }

    paths[pol.toLowerCase()] = destPath;
  }

  // --- Build artifact metadata ---
  return {
    sceneDir,
    paths,
    tiffMeta,
    bbox: fullSceneBbox, // Full CDSE scene footprint
    acquisitionBbox, // Sub-setting AOI used for raster download
    acquiredAt: fromTime,
    downloadedAt: new Date().toISOString(),
    workerId: WORKER_ID,
    polarizations: ['VV', 'VH'],
  };
}

// ---------------------------------------------------------------------------
// Worker lifecycle — public API
// ---------------------------------------------------------------------------

/**
 * Process the next available queued scene (one at a time).
 * Exported so the API endpoint can trigger a manual run.
 * @returns {Promise<{claimed: boolean, sceneId?: string, status: string, error?: string}>}
 */
async function processNextScene() {
  if (_inFlight) return { claimed: false, status: 'busy' };
  _inFlight = true;
  try {
    const scene = await claimNextScene();
    if (!scene) {
      return { claimed: false, status: 'empty_queue' };
    }
    return await processClaimedScene(scene);
  } catch (err) {
    return handleClaimFailure(err);
  } finally {
    _inFlight = false;
  }
}

/** Process one specific queued scene through the standard pipeline. */
async function processSceneById(id) {
  if (_inFlight) return { claimed: false, status: 'busy' };
  _inFlight = true;
  try {
    const scene = await claimSceneById(id);
    if (!scene) return { claimed: false, status: 'not_queued' };
    return await processClaimedScene(scene);
  } catch (err) {
    return handleClaimFailure(err);
  } finally {
    _inFlight = false;
  }
}

async function processClaimedScene(scene) {
  const safeId = String(scene.scene_id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  const sceneDir = path.join(SCENES_DIR, safeId);
  try {
    console.log(`[worker] Claimed scene: ${scene.scene_id} (id=${scene.id})`);
    _lastActivity = new Date();

    const artifact = await acquireScene(scene);
    await markCompleted(scene.id, artifact);

    try {
        const trusted = {
        _scene: {
          id: scene.scene_id,
          mode: 'REAL',
          source: 'cdse_sentinel1',
          acquiredAt: artifact.acquiredAt,
          bbox: artifact.acquisitionBbox || artifact.bbox,
          stacBbox: artifact.bbox,
          polarization: artifact.polarizations,
          rasterUnits: 'linear'
        },
        _paths: artifact.paths
      };

      // Apply environment override if configured for this scene
      const SCENE_ENVIRONMENT_OVERRIDES = {
        'S1D_IW_GRDH_1SDV_20261005T011017_20261005T011042_004873_0092A1_0488_COG.SAFE': {
          current: 'environment/arabian_sea/cmems_arabian_sea_20261005.nc'
        },
        'S1D_IW_GRDH_1SDV_20260702T142203_20260702T142232_003496_0062F7_DBD7_COG.SAFE': {
          current: 'environment/oman/cmems_oman_20260702.nc',
          wind: 'environment/oman/era5_oman_20260702.nc'
        }
      };
      const envOverride = SCENE_ENVIRONMENT_OVERRIDES[scene.scene_id];
      if (envOverride) {
        trusted._scene.environment = envOverride;
      }

      const report = await incidentService.analyze(
        {
          mode: 'REAL',
          sceneId: scene.scene_id,
          detector: 'hybrid',
          forecastHours: 24,
          hindcastHours: 6
        },
        trusted
      );

      if (report && report.id) {
        await pool.query(
          `UPDATE processed_scenes SET incident_id = $1 WHERE id = $2`,
          [report.id, scene.id]
        );
        console.log(`[worker] Detection completed for scene ${scene.scene_id} -> incident ${report.id}`);
      }
    } catch (detectionErr) {
      const safeMsg = String(detectionErr.message || 'Unknown detection error').slice(0, 1000);
      console.error(`[worker] Detection failed for scene ${scene.scene_id}:`, safeMsg);
      // Acquisition succeeded, so scene remains 'completed' and is not retried.
      // The incident_id remains NULL so it can be retried manually if needed.
      // Persist the detection error with [detection_failed] prefix.
      try {
        await pool.query(
          `UPDATE processed_scenes
              SET error_message = $1
            WHERE id = $2`,
          [`[detection_failed] ${safeMsg}`, scene.id]
        );
      } catch (dbErr) {
        console.error('[worker] Could not persist detection error to DB:', String(dbErr.message).slice(0, 200));
      }
    }

    _processedCount++;
    _lastError = null;
    console.log(`[worker] Completed scene: ${scene.scene_id}`);
    return { claimed: true, sceneId: scene.scene_id, status: 'completed' };

  } catch (err) {
    // Never log raw error objects that could contain tokens
    const safeMsg = String(err.message || 'Unknown error');
    _lastError = safeMsg;

    _failedCount++;
    console.error(`[worker] Failed scene ${scene.scene_id}:`, safeMsg);
    try {
      await markFailed(scene.id, safeMsg);
    } catch (dbErr) {
      console.error('[worker] Could not write failure to DB:', String(dbErr.message).slice(0, 200));
    }
    return { claimed: true, sceneId: scene.scene_id, status: 'failed', error: safeMsg };
  } finally {
    try {
      await fs.rm(sceneDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error(`[worker] Failed to cleanup scene directory ${sceneDir}:`, cleanupErr.message);
    }
  }
}

function handleClaimFailure(err) {
  const safeMsg = String(err.message || 'Unknown error');
  _lastError = safeMsg;
  console.error('[worker] Claim error:', safeMsg);
  return { claimed: false, status: 'claim_error', error: safeMsg };
}

/**
 * Start the acquisition worker loop.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
async function startWorker() {
  if (_running) {
    console.log('[worker] Already running');
    return;
  }
  _running = true;
  console.log(`[worker] Starting — id=${WORKER_ID} interval=${WORKER_INTERVAL_MS}ms stale=${STALE_MS}ms`);

  // Recovery: reset stale processing scenes before first poll
  try {
    const { recovered, failed } = await recoverStaleScenes();
    if (recovered > 0 || failed > 0) {
      console.log(`[worker] Boot stale recovery: ${recovered} re-queued, ${failed} failed`);
    }
  } catch (err) {
    console.warn('[worker] Stale recovery failed (non-fatal):', String(err.message).slice(0, 200));
  }

  // Run immediately, then repeat
  _tick();

  _timer = setInterval(_tick, WORKER_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}

/**
 * Stop the acquisition worker loop gracefully.
 */
function stopWorker() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _running = false;
  console.log('[worker] Stopped');
}

/**
 * Internal tick — runs processNextScene if not already in flight.
 * Runs stale recovery periodically while the worker is alive.
 * Prevents overlapping concurrent invocations from the interval.
 */
async function _tick() {
  if (_inFlight) {
    console.log('[worker] Previous cycle still running — skipping tick');
    return;
  }
  try {
    try {
      const { recovered, failed } = await recoverStaleScenes();
      if (recovered > 0 || failed > 0) {
        console.log(`[worker] Periodic stale recovery: ${recovered} re-queued, ${failed} failed`);
      }
    } catch (recErr) {
      console.warn('[worker] Periodic stale recovery failed (non-fatal):', String(recErr.message).slice(0, 200));
    }

    await processNextScene();
  } catch (err) {
    _lastError = String(err.message || 'tick error');
    console.error('[worker] Unhandled tick error:', _lastError);
  }
}

/**
 * Return current in-process worker status snapshot.
 */
function workerStatus() {
  return {
    running: _running,
    inFlight: _inFlight,
    workerId: WORKER_ID,
    processedCount: _processedCount,
    failedCount: _failedCount,
    lastActivity: _lastActivity,
    lastError: _lastError,
    config: {
      intervalMs: WORKER_INTERVAL_MS,
      staleMs: STALE_MS,
      scenesDir: SCENES_DIR,
    },
  };
}

module.exports = {
  startWorker,
  stopWorker,
  processNextScene,
  processSceneById,
  workerStatus,
  // Exported for testing only:
  claimNextScene,
  claimSceneById,
  markCompleted,
  markFailed,
  recoverStaleScenes,
  _getWorkerId: () => WORKER_ID,
};
