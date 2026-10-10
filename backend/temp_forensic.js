const fs = require('fs');

async function processForensic() {
  const pool = require('./src/config/db');
  try {
    const query = `
      WITH dups AS (
        SELECT report->'scene'->>'id' as scene_id
        FROM osis_incidents
        GROUP BY 1
        HAVING count(*) > 1
      )
      SELECT 
        i.id as incident_id,
        i.report->'scene'->>'id' as scene_id,
        i.detected_at,
        i.image_at,
        i.report->>'status' as report_status,
        i.report->'detector'->>'outcome' as detector_outcome,
        i.report->'scene'->>'source' as report_source,
        i.report->'provenance'->>'algorithmVersion' as algorithm_version,
        i.report->'provenance'->>'imagery' as imagery_provenance,
        CASE WHEN i.report->'detections' IS NOT NULL THEN true ELSE false END as has_detection,
        CASE WHEN i.report->'spill' IS NOT NULL THEN true ELSE false END as has_characterization,
        CASE WHEN i.report->'environment' IS NOT NULL THEN true ELSE false END as has_environment,
        CASE WHEN i.report->'backward' IS NOT NULL THEN true ELSE false END as has_backward,
        CASE WHEN i.report->'origin' IS NOT NULL THEN true ELSE false END as has_origin,
        CASE WHEN i.report->'forward' IS NOT NULL THEN true ELSE false END as has_forward,
        CASE WHEN i.report->'ais' IS NOT NULL THEN true ELSE false END as has_ais,
        CASE WHEN i.report->'candidates' IS NOT NULL THEN true ELSE false END as has_attribution,
        ps.incident_id as ps_incident_id,
        ps.status as ps_status
      FROM osis_incidents i
      LEFT JOIN processed_scenes ps ON ps.scene_id = i.report->'scene'->>'id'
      WHERE i.report->'scene'->>'id' IN (SELECT scene_id FROM dups)
      ORDER BY i.report->'scene'->>'id', i.detected_at;
    `;
    const res = await pool.query(query);
    const groups = {};
    for (const r of res.rows) {
      if (!groups[r.scene_id]) {
        groups[r.scene_id] = [];
      }
      groups[r.scene_id].push(r);
    }
    
    let report = "";
    for (const sceneId in groups) {
      const rows = groups[sceneId];
      const isTest = sceneId.startsWith('test_') || sceneId.startsWith('test-');
      report += `GROUP: ${sceneId}\n`;
      report += `Classification: ${isTest ? "A. TEST FIXTURES" : "B. REAL/REPLAY INCIDENTS"}\n`;
      report += `Number of incident rows: ${rows.length}\n`;
      let i = 1;
      let canonical = null;
      for (const r of rows) {
        report += `  Row ${i++}:\n`;
        report += `    UUID: ${r.incident_id}\n`;
        report += `    Detected At: ${r.detected_at}\n`;
        report += `    Image At: ${r.image_at}\n`;
        report += `    Report Status: ${r.report_status}\n`;
        report += `    Detector Outcome: ${r.detector_outcome}\n`;
        report += `    Report Source: ${r.report_source}\n`;
        report += `    Has: Detect=${r.has_detection} Char=${r.has_characterization} Env=${r.has_environment} Hindcast=${r.has_backward} Origin=${r.has_origin} Forecast=${r.has_forward} AIS=${r.has_ais} Attr=${r.has_attribution}\n`;
        report += `    PS Incident ID Match: ${r.ps_incident_id === r.incident_id}\n`;
        report += `    PS Status: ${r.ps_status}\n`;
        if (r.ps_incident_id === r.incident_id) {
            canonical = r.incident_id;
        }
      }
      report += `  -> Canonical recommendation: ${canonical || 'None (Orphaned)'}\n\n`;
    }
    fs.writeFileSync('temp_forensic_report.txt', report);
    console.log("Wrote temp_forensic_report.txt");
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
processForensic();
