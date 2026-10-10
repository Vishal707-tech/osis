'use strict';

/**
 * hindcast.controller.js — Phase 3 HTTP layer
 *
 * POST /api/drift/:spillId/hindcast
 *
 * Validates the spillId parameter, delegates to hindcast.service.runHindcast(),
 * and maps service errors to appropriate HTTP status codes.
 *
 * Error mapping
 * ─────────────
 *   NOT_FOUND   → 404
 *   VALIDATION  → 400
 *   PYTHON      → 500
 *   DB          → 500
 *   spillId NaN → 400
 */

const { runHindcast } = require('../services/hindcast.service');
const { formatSpillId } = require('./spills.controller');

const runHindcastHandler = async (req, res) => {
  // ── Validate spillId ────────────────────────────────────────────────────
  const rawId = req.params.spillId;
  const spillId = parseInt(String(rawId).replace(/^SP-0*/i, ''), 10);

  if (isNaN(spillId) || spillId <= 0) {
    return res.status(400).json({
      error: 'Invalid spill ID',
      detail: `"${rawId}" is not a valid spill identifier`
    });
  }

  console.log(`[hindcast] POST /api/drift/${spillId}/hindcast`);

  try {
    const { runId, pythonResult } = await runHindcast(spillId);

    // ── Success ─────────────────────────────────────────────────────────
    return res.status(201).json({
      status:         'completed',
      runId,
      spillId,
      formattedSpillId: formatSpillId(spillId),
      physics_model:  pythonResult.physics_model,
      data_source:    pythonResult.data_source,
      ensemble_size:  pythonResult.ensemble_size,
      hmax_hours:     pythonResult.hmax_hours,
      leeway:         pythonResult.leeway,
      origin:         pythonResult.origin,
      release_window: pythonResult.release_window,
      trajectory:     pythonResult.trajectory,
      metadata:       pythonResult.metadata,
    });

  } catch (err) {
    // ── Mapped errors ────────────────────────────────────────────────────
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message });
    }
    if (err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 'PYTHON') {
      console.error('[hindcast] Python execution error:', err.message);
      return res.status(500).json({
        error:  'Hindcast engine failed',
        detail: err.message
      });
    }
    if (err.code === 'DB') {
      console.error('[hindcast] Database error:', err.message);
      return res.status(500).json({
        error:  'Database persistence failed',
        detail: err.message
      });
    }

    // ── Unexpected ───────────────────────────────────────────────────────
    console.error('[hindcast] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { runHindcastHandler };
