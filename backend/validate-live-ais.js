const incidentService = require('./src/services/incident.service');
const pool = require('./src/config/db');

async function validate() {
    console.log('--- VALIDATING LIVE AIS RETRIEVAL ---');
    
    // We will intercept the pipeline execution right before Python is called
    // to inspect the live_ais_records fetched by incident.service.js
    const child_process = require('child_process');
    const originalSpawn = child_process.spawn;
    
    let capturedPayload = null;
    child_process.spawn = (cmd, args, opts) => {
        // Find the base64 payload argument
        const b64 = args[args.indexOf('--payload') + 1];
        capturedPayload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        
        // Return a dummy process to safely exit
        return {
            stdout: { on: () => {} },
            stderr: { on: () => {} },
            on: (evt, cb) => {
                if (evt === 'close') cb(0);
            }
        };
    };

    const payload = {
        mode: 'REAL',
        sceneId: 'test-amsterdam',
        hindcastHours: 6
    };
    
    const trusted = {
        _scene: {
            id: 'test-amsterdam',
            acquiredAt: new Date().toISOString(),
            bbox: [4.4, 51.9, 5.4, 52.9] // Bounding box encompassing 4.9, 52.4
        }
    };
    
    try {
        console.log(`Triggering incident.service.js with origin ~ [4.9, 52.4] and hindcastHours=6...`);
        // Bypass scene validation temporarily just for this request
        const originalScenes = incidentService.scenes;
        incidentService.scenes = async () => [{id: 'test-amsterdam'}];
        
        await incidentService.analyze(payload, trusted);
        
        console.log('\n--- LIVE AIS PAYLOAD CAPTURED ---');
        console.log(`ais_mode: ${capturedPayload.ais_mode}`);
        console.log(`Records fetched: ${capturedPayload.live_ais_records.length}`);
        if (capturedPayload.live_ais_records.length > 0) {
            console.log('Sample records:');
            console.table(capturedPayload.live_ais_records.slice(0, 5));
        }
        
    } catch (e) {
        console.error("Error during validation:", e);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

validate();
