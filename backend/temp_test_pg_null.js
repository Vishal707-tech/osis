const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.zsgndatdfaspvhsorqav:thiscantbeapassword@aws-0-ap-south-1.pooler.supabase.com:5432/postgres' });
client.connect().then(async () => {
  try {
    const res = await client.query('SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326)', [null]);
    console.log(res.rows);
  } catch (err) { console.error('Error:', err.message); }
  client.end();
});
