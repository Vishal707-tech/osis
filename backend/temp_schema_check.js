const pool = require('./src/config/db');
pool.query(`
SELECT id, detected_at, report->'scene'->>'id' as scene_id
FROM osis_incidents
WHERE report->'scene'->>'id' IN (
  SELECT report->'scene'->>'id'
  FROM osis_incidents
  GROUP BY 1
  HAVING count(*) > 1
)
ORDER BY scene_id, detected_at;
`).then(r => console.log(JSON.stringify(r.rows, null, 2))).catch(console.error).finally(()=>process.exit());
