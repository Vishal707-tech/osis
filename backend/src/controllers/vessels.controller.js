const pool = require('../config/db');
const { parseSpillDbId } = require('./spills.controller');

const getVessels = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT mmsi, imo, name, vessel_type as "vesselType", flag, created_at as "createdAt"
      FROM vessels
      ORDER BY name ASC;
    `);
    const vessels = result.rows.map((row, idx) => ({
      id: `V-${idx + 1}`,
      name: row.name,
      mmsi: String(row.mmsi),
      imo: row.imo ? String(row.imo) : undefined,
      type: row.vesselType,
      flag: row.flag
    }));
    res.status(200).json(vessels);
  } catch (error) {
    console.error('Error fetching vessels:', error);
    res.status(500).json({ error: 'Failed to fetch vessels' });
  }
};

const getVesselById = async (req, res) => {
  try {
    const param = req.params.id;
    const isNum = /^\d+$/.test(param);

    const result = await pool.query(`
      SELECT mmsi, imo, name, vessel_type as "vesselType", flag
      FROM vessels
      WHERE ${isNum ? 'mmsi = $1' : 'name ILIKE $1'}
      LIMIT 1;
    `, [isNum ? BigInt(param) : `%${param}%`]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vessel not found' });
    }

    const row = result.rows[0];
    res.status(200).json({
      mmsi: String(row.mmsi),
      imo: row.imo ? String(row.imo) : undefined,
      name: row.name,
      type: row.vesselType,
      flag: row.flag
    });
  } catch (error) {
    console.error('Error fetching vessel details:', error);
    res.status(500).json({ error: 'Failed to fetch vessel details' });
  }
};

const getVesselsBySpill = async (req, res) => {
  try {
    const { spillId } = req.params;
    const dbId = parseSpillDbId(spillId);
    if (!dbId) {
      return res.status(404).json({ error: 'Invalid spill ID' });
    }

    const result = await pool.query(`
      SELECT 
        a.id as attribution_id,
        a.spill_id,
        a.mmsi,
        a.distance_from_origin_m,
        a.time_difference_minutes,
        a.trajectory_score,
        a.behavior_score,
        a.responsibility_score,
        v.name,
        v.vessel_type,
        v.flag,
        v.imo
      FROM spill_vessel_attribution a
      JOIN vessels v ON a.mmsi = v.mmsi
      WHERE a.spill_id = $1
      ORDER BY a.responsibility_score DESC;
    `, [dbId]);

    const candidates = result.rows.map((row, idx) => ({
      vesselId: `V-${idx + 1}`,
      vessel: row.name,
      mmsi: String(row.mmsi),
      imo: row.imo ? String(row.imo) : undefined,
      type: row.vessel_type,
      flag: row.flag,
      distanceKm: Number((row.distance_from_origin_m / 1000).toFixed(1)),
      trajectoryScore: Math.round(row.trajectory_score),
      timeScore: Math.round(Math.max(10, 100 - row.time_difference_minutes / 2)),
      behaviorScore: Math.round(row.behavior_score),
      responsibilityScore: Math.round(row.responsibility_score)
    }));

    res.status(200).json(candidates);
  } catch (error) {
    console.error('Error fetching candidate vessels:', error);
    res.status(500).json({ error: 'Failed to fetch candidate vessels' });
  }
};

module.exports = {
  getVessels,
  getVesselById,
  getVesselsBySpill
};
