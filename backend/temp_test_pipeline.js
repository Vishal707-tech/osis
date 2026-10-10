const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runPipeline(input) {
  const result = spawnSync('python', [path.resolve(__dirname, 'scripts/real_incident_pipeline.py')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });
  if (result.status !== 0) {
    console.error("Pipeline failed:", result.stderr);
    process.exit(1);
  }
  return JSON.parse(result.stdout);
}

console.log("=== Testing Pipeline Outcomes ===");
// Need a valid scene ID that will pass the SAR detector stub or I can use uploaded scene
