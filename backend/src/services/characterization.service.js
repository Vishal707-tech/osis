'use strict';

/**
 * ==============================================================================
 * O.S.I.S. - Oil Spill Identification System
 * Phase 4B: Spill Characterization Service (Node.js ↔ Python)
 * ==============================================================================
 * File    : backend/src/services/characterization.service.js
 * Purpose : Fetches spill polygon & metadata from PostgreSQL/PostGIS, verifies
 *           geometry validity, delegates numerical/shape calculations to Python
 *           engine, and returns structured characterization response.
 * ==============================================================================
 */

const { spawn } = require('child_process');
const path = require('path');
const pool = require('../config/db');

const PYTHON_EXE = process.env.PYTHON_PATH || 'python';
const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/characterize_spill.py');
const TIMEOUT_MS = 30000; // 30 seconds

/**
 * Parse polygon ring from PostGIS GeoJSON output.
 * GeoJSON is [lon, lat].
 */
function parseGeoJsonPolygon(geojsonStr) {
  if (!geojsonStr) return null;
  try {
    const parsed = typeof geojsonStr === 'string' ? JSON.parse(geojsonStr) : geojsonStr;
    if (parsed.type === 'Polygon' && parsed.coordinates && parsed.coordinates[0]) {
      return parsed.coordinates[0];
    }
    if (parsed.type === 'MultiPolygon' && parsed.coordinates && parsed.coordinates[0] && parsed.coordinates[0][0]) {
      // Return exterior ring of the primary polygon
      return parsed.coordinates[0][0];
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Execute Python characterization engine via stdin/stdout pipe.
 */
function runPythonCharacterization(payload) {
  return new Promise((resolve, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    let proc;

    try {
      proc = spawn(PYTHON_EXE, [SCRIPT_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (spawnErr) {
      return reject({
        code: 'PYTHON',
        message: `Failed to spawn Python process: ${spawnErr.message}`,
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 2000);
      reject({ code: 'TIMEOUT', message: 'Characterization engine timed out after 30s' });
    }, TIMEOUT_MS);

    proc.stdout.on('data', chunk => { stdoutBuf += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });

    proc.on('error', err => {
      clearTimeout(timer);
      if (!timedOut) {
        reject({ code: 'PYTHON', message: `Python execution error: ${err.message}` });
      }
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return;

      if (code !== 0) {
        return reject({
          code: 'PYTHON_ERROR',
          message: stderrBuf.trim() || `Python process exited with code ${code}`,
        });
      }

      try {
        const result = JSON.parse(stdoutBuf);
        resolve(result);
      } catch (parseErr) {
        reject({
          code: 'PARSE_ERROR',
          message: `Failed to parse Python JSON output: ${parseErr.message}`,
          raw: stdoutBuf,
        });
      }
    });

    // Send payload via stdin and close stream
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

/**
 * Main characterization function for a given spill ID.
 *
 * @param {number} spillId - integer primary key of the spill
 * @returns {Promise<Object>} structured characterization response
 */
async function getSpillCharacterization(spillId) {
  if (!spillId || isNaN(spillId) || spillId <= 0) {
    throw { code: 'VALIDATION', message: 'Invalid spill ID' };
  }

  // 1. Fetch spill record with PostGIS validation and repair
  const query = `
    SELECT 
      id,
      ST_AsGeoJSON(geom) AS geojson,
      ST_IsValid(geom) AS is_valid,
      CASE 
        WHEN NOT ST_IsValid(geom) THEN ST_AsGeoJSON(ST_MakeValid(geom))
        ELSE NULL 
      END AS repaired_geojson,
      area_sqm,
      confidence,
      estimated_age_hours,
      detected_at,
      satellite_source,
      status
    FROM spills
    WHERE id = $1;
  `;

  const result = await pool.query(query, [spillId]);

  if (result.rows.length === 0) {
    throw { code: 'NOT_FOUND', message: `Spill with ID ${spillId} not found` };
  }

  const row = result.rows[0];

  // 2. Validate polygon geometry
  let polygon = parseGeoJsonPolygon(row.geojson);
  let wasRepaired = false;

  if (!row.is_valid && row.repaired_geojson) {
    const repairedPoly = parseGeoJsonPolygon(row.repaired_geojson);
    if (repairedPoly) {
      polygon = repairedPoly;
      wasRepaired = true;
    }
  }

  if (!polygon || polygon.length < 3) {
    throw { code: 'VALIDATION', message: 'Spill does not contain a valid polygon geometry' };
  }

  // 3. Format detection timestamp
  const detectedAtStr = row.detected_at instanceof Date
    ? row.detected_at.toISOString()
    : (row.detected_at ? String(row.detected_at) : null);

  // 4. Build input payload for Python
  const payload = {
    spill_id: row.id,
    geojson: polygon,
    detected_at: detectedAtStr,
    satellite_source: row.satellite_source || 'Sentinel-1',
    confidence: row.confidence != null ? Number(row.confidence) : null,
    status: row.status || 'active',
    estimated_age_hours: row.estimated_age_hours != null ? Number(row.estimated_age_hours) : null,
  };

  // 5. Run Python calculation
  const charResult = await runPythonCharacterization(payload);

  if (wasRepaired) {
    charResult.metadata.geometryRepaired = true;
    charResult.metadata.repairNote = 'Geometry was repaired via PostGIS ST_MakeValid';
  }

  return charResult;
}

module.exports = {
  getSpillCharacterization,
  parseGeoJsonPolygon,
};
