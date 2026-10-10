const pool = require('../config/db');

// Helper to parse spill ID parameter (e.g. "SP-001", "1", "sp-002")
function parseSpillDbId(param) {
  if (!param) return null;
  const str = String(param).trim();
  const num = parseInt(str.replace(/^SP-0*/i, ''), 10);
  return isNaN(num) ? null : num;
}

function formatSpillId(num) {
  return `SP-${String(num).padStart(3, '0')}`;
}

function getAgeRange(hours) {
  if (!hours) return { min: 2, max: 4, unit: 'hours' };
  const min = Math.max(1, Math.floor(hours * 0.8));
  const max = Math.ceil(hours * 1.2);
  return { min, max, unit: 'hours' };
}

const getAllSpills = async (req, res) => {
  try {
    const query = `
      SELECT 
        id,
        ST_X(centroid) as lon,
        ST_Y(centroid) as lat,
        ST_AsGeoJSON(geom) as geojson,
        area_sqm,
        confidence,
        estimated_age_hours,
        detected_at,
        satellite_source,
        status
      FROM spills
      ORDER BY id ASC;
    `;
    const result = await pool.query(query);

    const spills = result.rows.map(row => {
      let polygon = [];
      try {
        if (row.geojson) {
          const parsed = JSON.parse(row.geojson);
          if (parsed.coordinates && parsed.coordinates[0]) {
            polygon = parsed.coordinates[0];
          }
        }
      } catch (e) {
        // ignore polygon parse error
      }

      const formattedId = formatSpillId(row.id);
      return {
        id: formattedId,
        location: {
          latitude: Number(row.lat),
          longitude: Number(row.lon)
        },
        areaKm2: Number((row.area_sqm / 1000000).toFixed(1)),
        confidence: Math.round(row.confidence),
        estimatedAge: getAgeRange(row.estimated_age_hours),
        detectedAt: row.detected_at instanceof Date ? row.detected_at.toISOString() : String(row.detected_at),
        status: row.status || 'active',
        satelliteSource: row.satellite_source || 'Sentinel-1',
        polygon: polygon.length > 0 ? polygon : undefined
      };
    });

    res.status(200).json(spills);
  } catch (error) {
    console.error('Error fetching spills from database:', error);
    res.status(500).json({ error: 'Failed to fetch spills' });
  }
};

const getSpillById = async (req, res) => {
  try {
    const dbId = parseSpillDbId(req.params.id);
    if (!dbId) {
      return res.status(404).json({ error: 'Spill not found' });
    }

    // 1. Fetch Spill Record
    const spillRes = await pool.query(`
      SELECT 
        id,
        ST_X(centroid) as lon,
        ST_Y(centroid) as lat,
        ST_AsGeoJSON(geom) as geojson,
        area_sqm,
        confidence,
        estimated_age_hours,
        detected_at,
        satellite_source,
        status
      FROM spills
      WHERE id = $1;
    `, [dbId]);

    if (spillRes.rows.length === 0) {
      return res.status(404).json({ error: 'Spill not found' });
    }

    const spillRow = spillRes.rows[0];
    let polygon = [];
    try {
      if (spillRow.geojson) {
        const parsed = JSON.parse(spillRow.geojson);
        if (parsed.coordinates && parsed.coordinates[0]) {
          polygon = parsed.coordinates[0];
        }
      }
    } catch (e) {
      // ignore
    }

    const formattedId = formatSpillId(spillRow.id);
    const spillData = {
      id: formattedId,
      location: {
        latitude: Number(spillRow.lat),
        longitude: Number(spillRow.lon)
      },
      polygon: polygon.length > 0 ? polygon : undefined,
      areaKm2: Number((spillRow.area_sqm / 1000000).toFixed(1)),
      confidence: Math.round(spillRow.confidence),
      estimatedAge: getAgeRange(spillRow.estimated_age_hours),
      detectedAt: spillRow.detected_at instanceof Date ? spillRow.detected_at.toISOString() : String(spillRow.detected_at),
      status: spillRow.status || 'active',
      satelliteSource: spillRow.satellite_source || 'Sentinel-1'
    };

    // 2. Fetch Drift Predictions (trajectory & probable origin)
    const driftRes = await pool.query(`
      SELECT 
        id,
        timestamp,
        direction,
        ST_X(geom) as lon,
        ST_Y(geom) as lat
      FROM drift_predictions
      WHERE spill_id = $1
      ORDER BY timestamp DESC;
    `, [dbId]);

    let origin = null;
    let driftPath = [];

    if (driftRes.rows.length > 0) {
      // The drift points are ordered from most recent (slick centroid) to oldest (origin)
      const detectedTime = new Date(spillRow.detected_at).getTime();

      driftPath = driftRes.rows.map((pt, idx) => {
        const ptTime = new Date(pt.timestamp).getTime();
        const diffHours = Math.max(0, Math.round((detectedTime - ptTime) / (1000 * 60 * 60)));
        const isOrigin = idx === driftRes.rows.length - 1;
        const isSlick = idx === 0;

        return {
          hoursAgo: diffHours,
          lat: Number(pt.lat),
          lon: Number(pt.lon),
          label: isOrigin ? 'Probable origin' : isSlick ? 'Detected slick centroid' : `Drift −${diffHours}h`
        };
      });

      // Oldest point is origin
      const originPoint = driftRes.rows[driftRes.rows.length - 1];
      const originTime = new Date(originPoint.timestamp);
      
      const windowStart = new Date(originTime.getTime() - 90 * 60 * 1000).toISOString();
      const windowEnd = new Date(originTime.getTime() + 90 * 60 * 1000).toISOString();

      origin = {
        latitude: Number(originPoint.lat),
        longitude: Number(originPoint.lon),
        uncertaintyKm: 3.2,
        releaseWindow: {
          start: windowStart,
          end: windowEnd
        }
      };
    }

    // 3. Fetch Spill-Vessel Attributions + Vessel Details
    const attrRes = await pool.query(`
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

    const vesselsList = [];
    const attributionList = [];

    if (attrRes.rows.length > 0) {
      for (let i = 0; i < attrRes.rows.length; i++) {
        const row = attrRes.rows[i];
        const mmsiStr = String(row.mmsi);
        const vesselId = `V-${i + 1}`;

        // Fetch vessel tracks for this vessel
        const tracksRes = await pool.query(`
          SELECT 
            ST_X(geom) as lon,
            ST_Y(geom) as lat,
            speed,
            heading,
            timestamp
          FROM vessel_tracks
          WHERE mmsi = $1
          ORDER BY timestamp ASC;
        `, [row.mmsi]);

        const trackPoints = tracksRes.rows.map(t => [Number(t.lon), Number(t.lat)]);
        const lastTrack = tracksRes.rows[tracksRes.rows.length - 1] || {};

        vesselsList.push({
          id: vesselId,
          name: row.name,
          mmsi: mmsiStr,
          type: row.vessel_type,
          flag: row.flag,
          speedKn: lastTrack.speed || 10.0,
          headingDeg: lastTrack.heading || 0,
          lastSeen: lastTrack.timestamp instanceof Date ? lastTrack.timestamp.toISOString() : (lastTrack.timestamp || spillRow.detected_at),
          aisGapMin: Math.round(row.behavior_score > 70 ? (row.behavior_score - 50) * 2.5 : 0),
          track: trackPoints
        });

        // Summary generation based on real attribution scores
        let summary = '';
        if (row.responsibility_score >= 80) {
          summary = `Transited the backtracked origin cell inside the estimated release window, reporting significant AIS gaps before resuming course.`;
        } else if (row.responsibility_score >= 60) {
          summary = `${row.vessel_type} passing within ${(row.distance_from_origin_m / 1000).toFixed(1)} km of the origin cell with reporting gaps partially overlapping the release window.`;
        } else if (row.responsibility_score >= 40) {
          summary = `Continuous AIS coverage; transit trajectory only clips the outer drift envelope late in the window.`;
        } else if (row.responsibility_score >= 20) {
          summary = `High-speed transit well outside the origin cell, minimal reporting gaps detected.`;
        } else {
          summary = `Small craft operating inshore, uninterrupted AIS and no discharge-capable cargo.`;
        }

        const typeScore = row.vessel_type === 'Crude oil tanker' ? 90
          : row.vessel_type === 'Product tanker' ? 84
          : row.vessel_type === 'Bulk carrier' ? 44
          : row.vessel_type === 'Container ship' ? 36 : 6;

        attributionList.push({
          vesselId,
          mmsi: mmsiStr,
          rank: i + 1,
          suspicion: Math.round(row.responsibility_score),
          proximity: Math.round(Math.max(10, 100 - (row.distance_from_origin_m / 350))),
          temporal: Math.round(row.trajectory_score),
          aisGap: Math.round(row.behavior_score),
          vesselType: typeScore,
          summary
        });
      }
    }

    const responseData = {
      id: formattedId,
      spill: spillData,
      origin,
      driftPath,
      vessels: vesselsList,
      attribution: attributionList
    };

    res.status(200).json(responseData);
  } catch (error) {
    console.error('Error fetching spill details from database:', error);
    res.status(500).json({ error: 'Failed to fetch spill details' });
  }
};

const characterizationService = require('../services/characterization.service');

const getSpillCharacterization = async (req, res) => {
  try {
    const rawId = req.params.spillId || req.params.id;
    const dbId = parseSpillDbId(rawId);
    if (!dbId) {
      return res.status(404).json({ error: 'Invalid spill ID' });
    }

    const data = await characterizationService.getSpillCharacterization(dbId);
    return res.status(200).json(data);
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return res.status(404).json({ error: error.message });
    }
    if (error.code === 'VALIDATION') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error in getSpillCharacterization:', error);
    return res.status(500).json({ error: 'Internal Server Error', detail: error.message });
  }
};

module.exports = {
  getAllSpills,
  getSpillById,
  getSpillCharacterization,
  parseSpillDbId,
  formatSpillId
};

