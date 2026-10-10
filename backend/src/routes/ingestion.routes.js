'use strict';
/**
 * ingestion.routes.js
 * ====================
 * DAY 1 — REST API for the autonomous scene-ingestion pipeline.
 *
 * Endpoints:
 *   POST   /api/ingestion/start          Start the polling loop
 *   POST   /api/ingestion/stop           Stop the polling loop
 *   GET    /api/ingestion/status         In-process poller status + DB checkpoint
 *   POST   /api/ingestion/poll           Trigger a single manual poll cycle
 *   GET    /api/ingestion/queue          List queued scenes (with pagination)
 *   GET    /api/ingestion/queue/:sceneId Scene detail
 */

const express  = require('express');
const router   = express.Router();
const pool     = require('../config/db');
const poller   = require('../services/scene-poller.service');

// ---------------------------------------------------------------------------
// POST /api/ingestion/start
// ---------------------------------------------------------------------------
router.post('/start', async (req, res, next) => {
  try {
    await poller.start();
    res.json({ ok: true, message: 'Poller started', status: poller.status() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ingestion/stop
// ---------------------------------------------------------------------------
router.post('/stop', (req, res) => {
  poller.stop();
  res.json({ ok: true, message: 'Poller stopped', status: poller.status() });
});

// ---------------------------------------------------------------------------
// GET /api/ingestion/status
// ---------------------------------------------------------------------------
router.get('/status', async (req, res, next) => {
  try {
    const inProcess = poller.status();

    // Augment with live DB counts per status
    let dbCounts = {};
    try {
      const { rows } = await pool.query(
        `SELECT status, COUNT(*)::int AS count
           FROM processed_scenes
          GROUP BY status`
      );
      rows.forEach(r => { dbCounts[r.status] = r.count; });
    } catch (_) {
      dbCounts = { error: 'DB unavailable' };
    }

    // DB checkpoint
    let checkpoint = null;
    try {
      const { rows } = await pool.query(
        'SELECT last_polled_at, last_scene_at, poll_count, scenes_queued FROM ingestion_state WHERE singleton = TRUE LIMIT 1'
      );
      checkpoint = rows[0] || null;
    } catch (_) {}

    res.json({
      ok: true,
      poller: inProcess,
      db: { sceneCounts: dbCounts, checkpoint },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ingestion/poll
// Manual trigger for a single poll cycle (useful in demos / testing)
// ---------------------------------------------------------------------------
router.post('/poll', async (req, res, next) => {
  try {
    await poller.pollOnce();
    res.json({ ok: true, message: 'Manual poll cycle completed', status: poller.status() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ingestion/queue
// List scenes in the queue (filterable by status, paginated)
// ---------------------------------------------------------------------------
router.get('/queue', async (req, res, next) => {
  try {
    const status = req.query.status || 'queued';
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const validStatuses = ['queued', 'processing', 'completed', 'failed', 'all'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const whereClause = status === 'all' ? '' : 'WHERE status = $1';
    const params = status === 'all' ? [limit, offset] : [status, limit, offset];
    const limitPos  = status === 'all' ? 1 : 2;
    const offsetPos = status === 'all' ? 2 : 3;

    const { rows } = await pool.query(
      `SELECT id, scene_id, collection, bbox, acquired_at, platform,
              orbit_direction, polarization, status,
              queued_at, processing_at, completed_at,
              error_message, retry_count, incident_id
         FROM processed_scenes
         ${whereClause}
         ORDER BY queued_at DESC
         LIMIT $${limitPos} OFFSET $${offsetPos}`,
      params
    );

    const countQ = status === 'all'
      ? await pool.query('SELECT COUNT(*)::int AS total FROM processed_scenes')
      : await pool.query('SELECT COUNT(*)::int AS total FROM processed_scenes WHERE status = $1', [status]);

    res.json({
      ok: true,
      total: countQ.rows[0].total,
      limit,
      offset,
      scenes: rows,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ingestion/queue/:sceneId
// ---------------------------------------------------------------------------
router.get('/queue/:sceneId', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, scene_id, collection, bbox, acquired_at, platform,
              orbit_direction, polarization, status,
              queued_at, processing_at, completed_at,
              error_message, retry_count, incident_id, stac_feature
         FROM processed_scenes
        WHERE scene_id = $1
        LIMIT 1`,
      [req.params.sceneId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Scene not found' });
    }
    res.json({ ok: true, scene: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ingestion/replay
// Re-queue an existing processed_scenes row for replay through the normal
// worker → cached VV/VH → incidentService.analyze() → osis_incidents pipeline.
//
// Body (JSON):  { "sceneId": "..." }
// Default:      test_s1a_karnataka_day3_ml_001
//
// Returns 200 with the reset row, or 404 if scene_id is not in the table.
// Does NOT insert a new row — the row must already exist.
// ---------------------------------------------------------------------------
router.post('/replay', async (req, res, next) => {
  try {
    const DEFAULT_SCENE = 'test_s1a_karnataka_day3_ml_001';
    const raw = req.body && typeof req.body.sceneId === 'string'
      ? req.body.sceneId.trim()
      : '';
    const sceneId = raw || DEFAULT_SCENE;

    // Sanitise: must be a non-empty string with no shell-injection characters
    if (!/^[A-Za-z0-9._-]+$/.test(sceneId)) {
      return res.status(400).json({ ok: false, error: 'Invalid sceneId format' });
    }

    const { rows } = await pool.query(
      `UPDATE processed_scenes
          SET status        = 'queued',
              incident_id   = NULL,
              completed_at  = NULL,
              processing_at = NULL,
              error_message = NULL,
              retry_count   = 0,
              queued_at     = NOW()
        WHERE scene_id = $1
        RETURNING id, scene_id, collection, bbox, acquired_at, platform,
                  orbit_direction, polarization, status,
                  queued_at, processing_at, completed_at,
                  error_message, retry_count, incident_id`,
      [sceneId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: `Scene '${sceneId}' not found in processed_scenes. Only scenes that have already been ingested at least once can be replayed.`,
      });
    }

    console.log(`[ingestion] Replay requested for scene ${sceneId} — reset to queued`);
    res.json({
      ok: true,
      message: `Scene '${sceneId}' re-queued for replay. The worker will process it through the normal pipeline.`,
      scene: rows[0],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

