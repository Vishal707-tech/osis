process.env.POLLER_AOI_BBOX = "56.24,17.40,56.43,17.59";
const pool = require('./src/config/db');
const { searchCatalog } = require('./src/services/sentinel.service');
const worker = require('./src/services/scene-worker.service');

async function main() {
    console.log("--- OFFLINE REPLAY DATA ACQUISITION ---");
    const aoi = [56.24, 17.40, 56.43, 17.59];
    const start = new Date('2026-07-02T14:20:00Z');
    const end = new Date('2026-07-02T14:25:00Z');

    const startStr = start.toISOString();
    const endStr = end.toISOString();
    console.log(`1. Searching CDSE Catalog for Oman AOI [${aoi}] at ${startStr}...`);
    const scenes = await searchCatalog({
        bbox: aoi,
        datetime: `${startStr}/${endStr}`
    });
    console.log(`   Found ${scenes.features.length} scenes. First scene ID: ${scenes.features[0] ? scenes.features[0].id : 'none'}`);
    
    const target = scenes.features[0]; // let's just use the scene found
    if (!target) {
        console.error("   Target scene not found in CDSE!");
        process.exit(1);
    }
    
    console.log(`   Target scene found! CDSE bbox: ${target.bbox}`);
    
    const sceneId = target.id;
    const collection = target.collection;
    const bboxJson = JSON.stringify(target.bbox); // Use the REAL full footprint from CDSE for DB
    const acquiredAt = target.properties.datetime;
    const platform = target.properties.platform;
    const orbitDir = target.properties['sat:orbit_state'];
    const polarStr = target.properties.polarization || JSON.stringify(target.properties.polarizations || ['VV', 'VH']);
    
    console.log(`2. Enqueuing scene into processed_scenes with full footprint...`);
    const res = await pool.query(
      `INSERT INTO processed_scenes
         (scene_id, collection, bbox, acquired_at, platform, orbit_direction, polarization, stac_feature, status)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, 'queued')
       ON CONFLICT (scene_id, collection) DO UPDATE SET status = 'queued', error_message = NULL, bbox = $3::jsonb
       RETURNING id`,
      [sceneId, collection, bboxJson, acquiredAt, platform, orbitDir, polarStr, JSON.stringify(target)]
    );
    
    const dbId = res.rows[0].id;
    console.log(`   Scene queued with DB ID: ${dbId}`);
    
    console.log(`3. Triggering Day 2 scene-worker to acquire VV and VH TIFFs...`);
    const workerResult = await worker.processSceneById(dbId);
    console.log(`   Worker returned:`, workerResult);
    
    console.log(`4. Validating raster artifacts...`);
    const row = await pool.query('SELECT * FROM processed_scenes WHERE id = $1', [dbId]);
    const finalScene = row.rows[0];
    
    console.log(`   Final Status: ${finalScene.status}`);
    if (finalScene.error_message) {
        console.error(`   Error Message: ${finalScene.error_message}`);
    }
    
    if (finalScene.artifact_metadata) {
        console.log(`   Artifact Metadata:`);
        console.log(JSON.stringify(finalScene.artifact_metadata, null, 2));
    }
    
    await pool.end();
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
