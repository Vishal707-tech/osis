const pool = require('./src/config/db');

async function check() {
  const { rows } = await pool.query('SELECT scene_id, incident_id FROM processed_scenes WHERE scene_id = $1', ['test_s1a_karnataka_day3_ml_001']);
  console.log('Database row:', rows[0]);
  process.exit(0);
}
check();
