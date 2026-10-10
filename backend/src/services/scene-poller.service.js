'use strict';
/**
 * scene-poller.service.js
 * ========================
 * DAY 1 — Autonomous Sentinel-1 scene discovery & persistent deduplication.
 *
 * Responsibilities:
 *   1. Poll CDSE STAC catalog on a configurable interval for Sentinel-1 GRD scenes
 *      over a configured Area of Interest (AOI).
 *   2. Deduplicate against the `processed_scenes` table (by scene_id + collection).
 *   3. Insert new scenes with status = 'queued' — ready for the Day 2 worker.
 *   4. Persist poller checkpoint in `ingestion_state` so restarts resume from
 *      the last seen acquisition time instead of re-scanning from scratch.
 *
 * Does NOT:
 *   - Run SAR detection, drift, AIS, or incident analysis (those are Day 2–4).
 *   - Download scene rasters (that happens in the Day 2 worker).
 *   - Modify any existing service or route.
 */

const pool = require('../config/db');
const { searchCatalog } = require('./sentinel.service');

// ---------------------------------------------------------------------------
// Configuration — all values read from environment at module load time
// ---------------------------------------------------------------------------

/** 
 * Configurable list of priority areas for Sentinel-1 monitoring.
 */
const PRIORITY_AREAS = (() => {
  const raw = process.env.POLLER_PRIORITY_AREAS_JSON;
  let areas = [];
  if (raw) {
    try {
      areas = JSON.parse(raw);
    } catch (e) {
      console.warn('[poller] Invalid JSON in POLLER_PRIORITY_AREAS_JSON, falling back to default.');
    }
  }
  
  if (!areas || areas.length === 0) {
    // Default to Karnataka operational AOI
    areas = [
      {
        id: 'karnataka_coast',
        bbox: [74.70, 13.20, 74.78, 13.28],
        priority: 100
      }
    ];
  }

  const validAreas = [];
  for (const area of areas) {
    const { id, bbox, priority } = area;
    if (
      id && 
      Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite) &&
      bbox[2] > bbox[0] && bbox[3] > bbox[1] &&
      (bbox[2] - bbox[0]) <= 0.2 && (bbox[3] - bbox[1]) <= 0.2
    ) {
      validAreas.push({ id, bbox, priority: Number.isFinite(priority) ? priority : 0 });
    } else {
      console.warn(`[poller] Rejecting invalid priority area: ${id}`);
    }
  }

  if (validAreas.length === 0) {
    throw new Error('No valid priority areas configured. Must be <=0.2 degrees per side.');
  }

  // Sort descending by priority, then deterministically by id
  validAreas.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return String(a.id).localeCompare(String(b.id));
  });

  return validAreas;
})();

/** How often to poll CDSE, in milliseconds (default: 15 minutes) */
const POLL_INTERVAL_MS = (() => {
  const v = parseInt(process.env.POLLER_INTERVAL_MS, 10);
  return Number.isFinite(v) && v >= 60000 ? v : 15 * 60 * 1000;
})();

/** Look-back window for the very first poll (hours). Default: 24 h */
const INITIAL_LOOKBACK_HOURS = (() => {
  const v = parseInt(process.env.POLLER_INITIAL_LOOKBACK_HOURS, 10);
  return Number.isFinite(v) && v > 0 && v <= 72 ? v : 24;
})();

/** Max scenes to enqueue per CDSE polling cycle (protects DB from massive spikes) */
const POLL_QUEUE_BATCH_SIZE = parseInt(process.env.POLL_QUEUE_BATCH_SIZE, 10) || 500;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _timer = null;
let _running = false;
let _inFlight = false;
let _pollCount = 0;
let _queuedTotal = 0;
let _lastPollAt = null;
let _lastError = null;

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

async function loadState() {
  try {
    const { rows } = await pool.query(
      'SELECT last_polled_at, last_scene_at, poll_count, scenes_queued FROM ingestion_state WHERE singleton = TRUE LIMIT 1'
    );
    return rows[0] || null;
  } catch (err) {
    console.warn('[poller] Could not load ingestion_state:', err.message);
    return null;
  }
}

async function saveState({ lastPollAt, lastSceneAt, pollCount, scenesQueued }) {
  try {
    await pool.query(
      `INSERT INTO ingestion_state (singleton, last_polled_at, last_scene_at, poll_count, scenes_queued)
       VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (singleton) DO UPDATE
         SET last_polled_at = EXCLUDED.last_polled_at,
             last_scene_at  = GREATEST(ingestion_state.last_scene_at, EXCLUDED.last_scene_at),
             poll_count     = EXCLUDED.poll_count,
             scenes_queued  = EXCLUDED.scenes_queued`,
      [lastPollAt, lastSceneAt, pollCount, scenesQueued]
    );
  } catch (err) {
    console.warn('[poller] Could not save ingestion_state:', err.message);
  }
}

async function isDuplicate(sceneId, collection) {
  const { rows } = await pool.query(
    'SELECT 1 FROM processed_scenes WHERE scene_id = $1 AND collection = $2 LIMIT 1',
    [sceneId, collection]
  );
  return rows.length > 0;
}

async function enqueueScene(feature, acquisitionBbox) {
  const sceneId     = feature.id;
  const collection  = feature.collection || 'sentinel-1-grd';
  const props       = feature.properties || {};
  const acquiredAt  = props.datetime || props.start_datetime || null;
  const platform    = props.platform || props['eo:platform'] || null;
  const orbitDir    = props.sat_orbit_state || props['sat:orbit_state'] || null;
  const polar       = props['sar:polarizations']
    ? props['sar:polarizations'].join(' ')
    : null;

  const bboxJson = acquisitionBbox ? JSON.stringify(acquisitionBbox) : null;

  try {
    const result = await pool.query(
      `INSERT INTO processed_scenes
         (scene_id, collection, bbox, acquired_at, platform, orbit_direction, polarization, stac_feature, status)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, 'queued')
       ON CONFLICT ON CONSTRAINT processed_scenes_unique_scene DO NOTHING
       RETURNING id`,
      [sceneId, collection, bboxJson, acquiredAt, platform, orbitDir, polar, JSON.stringify(feature)]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error(`[poller] Failed to enqueue scene ${sceneId}:`, err.message);
    throw err; // Throw to abort poll cycle and prevent checkpoint advancement
  }
}

// ---------------------------------------------------------------------------
// Core poll cycle
// ---------------------------------------------------------------------------

function intersects(b1, b2) {
  return !(b1[2] < b2[0] || b1[0] > b2[2] || b1[3] < b2[1] || b1[1] > b2[3]);
}

async function pollOnce() {
  if (_inFlight) {
    console.log('[poller] Previous poll cycle still running — skipping poll');
    return;
  }
  _inFlight = true;
  try {
    // Check queue capacity
    try {
      const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM processed_scenes WHERE status = 'queued'");
      if (rows[0].count >= POLL_QUEUE_BATCH_SIZE) {
        console.log(`[poller] Queue at capacity (${rows[0].count} >= ${POLL_QUEUE_BATCH_SIZE}). Skipping global STAC discovery.`);
        return;
      }
    } catch (err) {
      console.warn('[poller] Failed to check queue capacity:', err.message);
    }

    _lastPollAt = new Date();
    const now = _lastPollAt;

    let state = null;
    try {
      state = await loadState();
    } catch (_) {}

  let fromTime;
  if (state && state.last_scene_at) {
    fromTime = new Date(new Date(state.last_scene_at).getTime() + 1000);
  } else {
    fromTime = new Date(now.getTime() - INITIAL_LOOKBACK_HOURS * 3600 * 1000);
  }

  const windowMs = Math.min(now - fromTime, 23 * 3600 * 1000);
  const toTime   = new Date(fromTime.getTime() + windowMs);
  const datetime = `${fromTime.toISOString()}/${toTime.toISOString()}`;

  console.log(`[poller] Poll #${_pollCount + 1} | window: ${fromTime.toISOString()} → ${toTime.toISOString()}`);

  let features = [];
  try {
    const catalog = await searchCatalog({
      bbox: [-180, -90, 180, 90], // Satisfy CDSE STAC spatial requirement for global discovery
      datetime,
      collections: ['sentinel-1-grd'],
    });
    features = catalog.features || [];
    console.log(`[poller] STAC discovered ${features.length} features globally`);
  } catch (err) {
    _lastError = err.message;
    console.error('[poller] CDSE catalog error:', err.message);
    return;
  }

  let newScenes = 0;
  let latestAcquiredAt = null;
  let validFeaturesCount = 0;
  let invalidFeaturesCount = 0;
  let discardedCount = 0;
  let matchesCount = 0;

  for (const feature of features) {
    // 1. Read and validate original STAC bbox
    const sceneBbox = feature.bbox;
    if (!Array.isArray(sceneBbox) || sceneBbox.length !== 4 || !sceneBbox.every(Number.isFinite)) {
      invalidFeaturesCount++;
      continue;
    }
    validFeaturesCount++;

    // 2. Track the latest acquisition time for ALL valid discovered scenes, 
    // even if discarded, so the checkpoint advances over irrelevant scenes too.
    const acq = feature.properties?.datetime || feature.properties?.start_datetime;
    if (acq) {
      const d = new Date(acq);
      if (!latestAcquiredAt || d > latestAcquiredAt) latestAcquiredAt = d;
    }

    // 3. Find intersecting priority areas
    const intersecting = PRIORITY_AREAS.filter(area => intersects(sceneBbox, area.bbox));
    if (intersecting.length === 0) {
      discardedCount++;
      continue;
    }
    matchesCount++;

    // 4. Select the highest priority area (first in the sorted list)
    const selectedArea = intersecting[0];
    if (intersecting.length > 1) {
      console.log(`[poller] Scene ${feature.id} intersects ${intersecting.length} areas. Selected ${selectedArea.id}.`);
    }

    // 5. Enqueue with the selected acquisition bbox
    const inserted = await enqueueScene(feature, selectedArea.bbox);
    if (inserted) {
      newScenes++;
      console.log(`[poller] Queued scene: ${feature.id} for area: ${selectedArea.id}`);
    }
  }

  console.log(`[poller] Poll summary: ${validFeaturesCount} valid, ${invalidFeaturesCount} invalid, ${matchesCount} matched, ${discardedCount} discarded, ${newScenes} queued`);

  _queuedTotal += newScenes;
  _pollCount++;
  _lastError = null;

  await saveState({
    lastPollAt: now,
    lastSceneAt: latestAcquiredAt || toTime,
    pollCount: (state?.poll_count || 0) + 1,
    scenesQueued: (state?.scenes_queued || 0) + newScenes,
  });
  } finally {
    _inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Poller lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the autonomous polling loop.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
async function start() {
  if (_running) {
    console.log('[poller] Already running');
    return;
  }
  _running = true;
  console.log(`[poller] Starting — PRIORITY_AREAS=${PRIORITY_AREAS.length} (Global Discovery Mode) interval=${POLL_INTERVAL_MS}ms`);

  // Run immediately, then schedule repeating interval
  try {
    await pollOnce();
  } catch (err) {
    console.error('[poller] First poll failed:', err.message);
  }

  _timer = setInterval(async () => {
    try {
      await pollOnce();
    } catch (err) {
      _lastError = err.message;
      console.error('[poller] Poll cycle error:', err.message);
    }
  }, POLL_INTERVAL_MS);

  // Prevent the interval from keeping the process alive if main server exits
  if (_timer.unref) _timer.unref();
}

/**
 * Stop the polling loop gracefully.
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _running = false;
  console.log('[poller] Stopped');
}

/**
 * Return current in-process status snapshot (used by the ingestion API).
 */
function status() {
  return {
    running: _running,
    pollCount: _pollCount,
    queuedTotal: _queuedTotal,
    lastPollAt: _lastPollAt,
    lastError: _lastError,
    inFlight: _inFlight,
    config: {
      priorityAreas: PRIORITY_AREAS.map(a => a.id),
      intervalMs: POLL_INTERVAL_MS,
      initialLookbackHours: INITIAL_LOOKBACK_HOURS,
      queueLimit: POLL_QUEUE_BATCH_SIZE,
    },
  };
}

module.exports = { start, stop, status, pollOnce, PRIORITY_AREAS };
