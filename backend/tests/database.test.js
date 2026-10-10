'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

test('PostGIS migration is repeatable and incident evidence round-trips', {
    skip: process.env.OSIS_TEST_DATABASE !== 'true'
}, async () => {
    const pool = require('../src/config/db');
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const migration = await fs.readFile(path.resolve(__dirname, '../migrations/002_incidents.sql'), 'utf8');
        await client.query(migration);
        await client.query(migration);
        const outcomes = await fs.readFile(path.resolve(__dirname, '../migrations/003_analysis_outcomes.sql'), 'utf8');
        await client.query(outcomes);
        await client.query(outcomes);
        const report = JSON.parse(execFileSync(process.env.PYTHON_PATH || 'python',
            [path.resolve(__dirname, '../scripts/incident_pipeline.py')],
            { input: '{"forecastHours":48}', encoding: 'utf8', timeout: 60000 }));
        const id = randomUUID();
        await client.query(
            `INSERT INTO osis_incidents(id, detected_at, image_at, spill_geom, origin_geom, report)
             VALUES ($1,now(),$2,ST_SetSRID(ST_GeomFromGeoJSON($3),4326),
                     ST_SetSRID(ST_GeomFromGeoJSON($4),4326),$5::jsonb)`,
            [id, report.scene.acquiredAt, JSON.stringify(report.spill.geometry),
                JSON.stringify(report.origin.geometry), JSON.stringify(report)]);
        const result = await client.query(
            'SELECT ST_IsValid(spill_geom) AS valid, ST_SRID(spill_geom) AS srid, report FROM osis_incidents WHERE id=$1', [id]);
        assert.equal(result.rows[0].valid, true);
        assert.equal(result.rows[0].srid, 4326);
        assert.deepEqual(result.rows[0].report, report);
        for (const [view, count] of [['osis_candidates', 3], ['osis_drift', 49], ['osis_ais_anomalies', 1]]) {
            const rows = await client.query(`SELECT * FROM ${view} WHERE incident_id=$1`, [id]);
            assert.equal(rows.rowCount, count);
        }
        const fixes = await client.query('SELECT * FROM osis_ais_positions WHERE incident_id=$1', [id]);
        assert.ok(fixes.rowCount > 50);
        for (const sceneId of ['demo-no-spill', 'demo-inconclusive']) {
            const empty = JSON.parse(execFileSync(process.env.PYTHON_PATH || 'python',
                [path.resolve(__dirname, '../scripts/incident_pipeline.py')],
                { input: JSON.stringify({ sceneId }), encoding: 'utf8', timeout: 60000 }));
            const emptyId = randomUUID();
            await client.query('INSERT INTO osis_incidents(id,detected_at,image_at,spill_geom,origin_geom,report) VALUES ($1,now(),NULL,NULL,NULL,$2::jsonb)', [emptyId, JSON.stringify(empty)]);
            const saved = await client.query('SELECT report,spill_geom,origin_geom FROM osis_incidents WHERE id=$1', [emptyId]);
            assert.deepEqual(saved.rows[0].report, empty);
            assert.equal(saved.rows[0].spill_geom, null);
            assert.equal(saved.rows[0].origin_geom, null);
        }
        console.log('PostGIS geometry, JSONB evidence, relational views and repeatable migration verified');
    } finally {
        if (client) {
            await client.query('ROLLBACK');
            client.release();
        }
        await pool.end();
    }
});