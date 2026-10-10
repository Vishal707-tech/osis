const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.zsgndatdfaspvhsorqav:thiscantbeapassword@aws-0-ap-south-1.pooler.supabase.com:5432/postgres' });
client.connect()
  .then(() => client.query(`UPDATE processed_scenes SET status = 'queued', incident_id = NULL WHERE scene_id = 'test_s1a_karnataka_day3_ml_001' RETURNING *`))
  .then(res => { console.log("Updated:", res.rows); client.end(); })
  .catch(err => { console.error(err); client.end(); });
