const test = require('node:test');
const assert = require('node:assert/strict');
const incidentService = require('../src/services/incident.service');
const pool = require('../src/config/db');

test('Live AIS database query pads start time by 1 hour', async () => {
    // We want to test the query parameters inside incidentService.analyze
    // Let's mock pool.query
    const originalQuery = pool.query;
    let queryArgs = null;
    pool.query = async (text, params) => {
        if (typeof text === 'string' && text.includes('live_ais')) {
            queryArgs = params;
            return { rows: [] };
        }
        return { rows: [] };
    };
    
    // Mock child_process spawn
    const cp = require('node:child_process');
    const originalSpawn = cp.spawn;
    cp.spawn = () => {
        return {
            stdout: { on: () => {} },
            stderr: { on: () => {} },
            on: (event, cb) => {
                if (event === 'close') cb(0);
            }
        };
    };
    
    // Mock fs
    const fs = require('node:fs/promises');
    const originalReadFile = fs.readFile;
    fs.readFile = async (path) => {
        if (path.includes('incident-')) return JSON.stringify({status: 'completed'});
        return originalReadFile(path);
    };

    // Enable LIVE mode explicitly via env for testing
    process.env.AIS_AUTOSTART = 'true';
    const oldPersist = process.env.OSIS_PERSIST_POSTGRES;
    process.env.OSIS_PERSIST_POSTGRES = 'false'; // disable db persistence of the incident itself

    try {
        const payload = {
            mode: 'REAL',
            sceneId: 'live-test-scene',
            hindcastHours: 6
        };
        
        // Mock scenes array to return something for live-test-scene
        const originalScenes = incidentService.scenes;
        incidentService.scenes = async () => [{id: 'live-test-scene'}];
        
        // We also need to mock trusted _scene otherwise it won't have acquiredAt
        const trusted = {
            _scene: {
                id: 'live-test-scene',
                acquiredAt: '2026-10-07T12:00:00Z',
                bbox: [10, 20, 30, 40]
            }
        };
        
        await incidentService.analyze(payload, trusted);
        
        // Ensure query was called
        assert.ok(queryArgs, 'live_ais query was not executed');
        
        // $1 is start, $2 is end.
        const startStr = queryArgs[0];
        const endStr = queryArgs[1];
        
        const startTime = new Date(startStr);
        const endTime = new Date(endStr);
        
        // Calculation should be: start = end - ((hindcastHours + 1) * 3600000)
        const diffHours = (endTime.getTime() - startTime.getTime()) / 3600000;
        assert.equal(diffHours, 6 + 1, 'Query start time should be padded by exactly 1 hour');
        
    } catch (err) {
        if (!err.message.includes('Unexpected end of JSON input') && !err.message.includes('ENOENT')) {
             throw err;
        }
        // If it throws after the query due to mocked fs returning bad JSON, it's fine as long as query ran
        assert.ok(queryArgs, 'live_ais query was not executed');
        const startStr = queryArgs[0];
        const endStr = queryArgs[1];
        
        const startTime = new Date(startStr);
        const endTime = new Date(endStr);
        
        const diffHours = (endTime.getTime() - startTime.getTime()) / 3600000;
        assert.equal(diffHours, 7, 'Query start time should be padded by exactly 1 hour');
    } finally {
        pool.query = originalQuery;
        cp.spawn = originalSpawn;
        fs.readFile = originalReadFile;
        process.env.OSIS_PERSIST_POSTGRES = oldPersist;
    }
});
