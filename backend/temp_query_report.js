const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.zsgndatdfaspvhsorqav:thiscantbeapassword@aws-0-ap-south-1.pooler.supabase.com:5432/postgres' });
client.connect().then(async () => {
  try {
    const res = await client.query("SELECT report FROM osis_incidents WHERE id = '771319cf-6885-4e3c-b337-10ad27330618'");
    console.log(JSON.stringify(res.rows[0], null, 2));
  } catch (err) { console.error('Error:', err.message); }
  client.end();
});
