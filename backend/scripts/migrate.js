'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/db');

async function migrate() {
    const name = process.argv[2] || 'all';
    if (!['all', '001_hindcast_schema.sql', '002_incidents.sql', '003_analysis_outcomes.sql', '004_processed_scenes.sql', '005_worker_artifact.sql', '005_live_ais.sql', '006_incident_idempotency.sql'].includes(name)) {
        throw new Error('Unsupported migration name');
    }
    const names = name === 'all' ? ['002_incidents.sql', '003_analysis_outcomes.sql', '004_processed_scenes.sql', '005_worker_artifact.sql', '005_live_ais.sql', '006_incident_idempotency.sql'] : [name];
    const sql = (await Promise.all(names.map(n => fs.readFile(path.resolve(__dirname, '../migrations', n), 'utf8')))).join('\n');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`Applied ${name}`);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
migrate().catch(error => {
    console.error(`Migration failed (${error.code || 'configuration'}). Check database availability and prerequisites.`);
    process.exitCode = 1;
}).finally(() => pool.end());