const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const client = new Client({ connectionString: 'postgresql://postgres.zsgndatdfaspvhsorqav:thiscantbeapassword@aws-0-ap-south-1.pooler.supabase.com:5432/postgres' });
client.connect().then(async () => {
  const data = require('./data/incidents/bc18ff51-f6e7-4b76-8df5-96fc24cd6211.json');
  data.id = randomUUID();
  try {
    await client.query(`
      INSERT INTO osis_incidents(id, detected_at, image_at, spill_geom, origin_geom, report)
      VALUES ($1,$2,$3,ST_SetSRID(ST_GeomFromGeoJSON($4),4326),
              ST_SetSRID(ST_GeomFromGeoJSON($5),4326),$6::jsonb)
    `, [
      data.id,
      data.detectedAt,
      data.scene.acquiredAt || null,
      data.spill ? JSON.stringify(data.spill.geometry) : null,
      data.origin ? JSON.stringify(data.origin.geometry) : null,
      JSON.stringify(data)
    ]);
    console.log('Exact insert succeeded');
  } catch (err) {
    console.error('Exact insert failed:', err.message);
  }
  client.end();
});
