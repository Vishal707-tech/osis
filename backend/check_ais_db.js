const pool = require('./src/config/db');

async function verify() {
  try {
    const res = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'live_ais'");
    console.log(res.rows);
    
    const indexes = await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'live_ais'");
    console.log("INDEXES:", indexes.rows);
    process.exit(0);
  } catch(err) {
    console.error(err);
    process.exit(1);
  }
}

verify();
