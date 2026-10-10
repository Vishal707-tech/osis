const pool = require('../config/db');
const { parseSpillDbId, formatSpillId } = require('./spills.controller');

const getDriftData = async (req, res) => {
  try {
    const { spillId } = req.params;
    const dbId = parseSpillDbId(spillId);
    if (!dbId) {
      return res.status(404).json({ error: 'Invalid spill ID' });
    }

    const formattedId = formatSpillId(dbId);

    // ── 1. Find the latest completed hindcast run for this spill ──────────
    const runRes = await pool.query(
      `SELECT id
       FROM hindcast_runs
       WHERE spill_id = $1 AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 1`,
      [dbId]
    );

    let rows;

    if (runRes.rows.length > 0) {
      // ── 2a. Hindcast run exists — return only its trajectory rows ────────
      //        Order by step_index ASC so the oldest/furthest-back point
      //        (highest step_index) sits at the end of the array, matching
      //        the existing "originRow = backwardRows[last]" convention.
      const runId = runRes.rows[0].id;
      const dpRes = await pool.query(
        `SELECT
           id,
           timestamp,
           direction,
           ST_X(geom) AS lon,
           ST_Y(geom) AS lat
         FROM drift_predictions
         WHERE run_id = $1
         ORDER BY step_index ASC`,
        [runId]
      );
      rows = dpRes.rows;
    } else {
      // ── 2b. No hindcast run yet — fall back to legacy seed rows ──────────
      const dpRes = await pool.query(
        `SELECT
           id,
           timestamp,
           direction,
           ST_X(geom) AS lon,
           ST_Y(geom) AS lat
         FROM drift_predictions
         WHERE spill_id = $1 AND run_id IS NULL
         ORDER BY timestamp DESC`,
        [dbId]
      );
      rows = dpRes.rows;
    }

    // ── 3. Shape the response (identical contract as before) ─────────────
    if (rows.length === 0) {
      return res.status(200).json({
        spillId: formattedId,
        backward: null,
        forward: null
      });
    }

    const backwardRows = rows.filter(r => (r.direction || 'backward') === 'backward');
    // The last element in backwardRows is the oldest / furthest-back point → probable origin
    const originRow = backwardRows[backwardRows.length - 1];

    const backwardTrajectory = backwardRows.map(r => ({
      latitude:  Number(r.lat),
      longitude: Number(r.lon),
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp)
    }));

    res.status(200).json({
      spillId: formattedId,
      backward: {
        probableOrigin: originRow ? {
          latitude:  Number(originRow.lat),
          longitude: Number(originRow.lon)
        } : null,
        trajectory: backwardTrajectory
      },
      forward: {
        trajectory: []
      }
    });

  } catch (error) {
    console.error('Error fetching drift data from database:', error);
    res.status(500).json({ error: 'Failed to fetch drift data' });
  }
};

module.exports = {
  getDriftData
};
