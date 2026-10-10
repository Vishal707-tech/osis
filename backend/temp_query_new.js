const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.zsgndatdfaspvhsorqav:thiscantbeapassword@aws-0-ap-south-1.pooler.supabase.com:5432/postgres' });
client.connect().then(async () => {
  try {
    const res = await client.query("SELECT id FROM osis_incidents WHERE id = 'bc18ff51-f6e7-4b76-8df5-96fc24cd6211'");
    console.log(res.rows);
  } catch (err) { console.error('Error:', err.message); }
  client.end();
});
