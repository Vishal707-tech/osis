process.env.POLLER_AOI_BBOX = "56.24,17.40,56.43,17.59";
const pool = require('./src/config/db');
const worker = require('./src/services/scene-worker.service');

async function run() {
    console.log("Triggering worker for 117...");
    await pool.query("UPDATE processed_scenes SET status='queued' WHERE id=117");
    const out = await worker.processSceneById(117);
    console.log(out);
    
    // Check resulting incident
    const row = await pool.query("SELECT * FROM incident_reports ORDER BY created_at DESC LIMIT 1");
    if (row.rows.length > 0) {
        console.log("Latest incident:");
        console.log(JSON.stringify(row.rows[0], null, 2));
    }
    process.exit(0);
}
run().catch(console.error);
