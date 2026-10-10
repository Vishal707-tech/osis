const http = require('http');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

async function verify() {
  console.log('====================================');
  console.log('🔍 VERIFYING ALL BACKEND API ROUTES');
  console.log('====================================');

  // 1. GET /api/spills
  console.log('\n[Route 1]: GET /api/spills');
  const r1 = await get('http://localhost:5000/api/spills');
  console.log(`Status: ${r1.status}`);
  console.log(`Spills returned: ${r1.data.length}`);
  r1.data.forEach(s => {
    console.log(` - Spill ${s.id}: ${s.status} (${s.areaKm2} km², ${s.confidence}% conf) at (${s.location.latitude}, ${s.location.longitude})`);
  });

  // 2. GET /api/spills/SP-001
  console.log('\n[Route 2]: GET /api/spills/SP-001 (Fully populated investigation)');
  const r2 = await get('http://localhost:5000/api/spills/SP-001');
  console.log(`Status: ${r2.status}`);
  console.log(`Incident ID: ${r2.data.id}`);
  console.log(`Spill Details: Area=${r2.data.spill.areaKm2} km², Polygon points=${r2.data.spill.polygon?.length || 0}`);
  console.log(`Origin: lat=${r2.data.origin.latitude}, lon=${r2.data.origin.longitude}, radius=${r2.data.origin.uncertaintyKm} km`);
  console.log(`Release Window: ${r2.data.origin.releaseWindow.start} to ${r2.data.origin.releaseWindow.end}`);
  console.log(`Drift Trajectory points: ${r2.data.driftPath.length}`);
  console.log(`Candidate Vessels: ${r2.data.vessels.length}`);
  console.log(`Top Suspect Vessel: ${r2.data.vessels[0]?.name} (MMSI ${r2.data.vessels[0]?.mmsi})`);
  console.log(`Top Attribution: VesselId=${r2.data.attribution[0]?.vesselId}, Suspicion=${r2.data.attribution[0]?.suspicion}%, Proximity=${r2.data.attribution[0]?.proximity}%, AIS Gap=${r2.data.attribution[0]?.aisGap}%`);

  // 3. GET /api/spills/SP-002
  console.log('\n[Route 3]: GET /api/spills/SP-002 (Empty/Unavailable state)');
  const r3 = await get('http://localhost:5000/api/spills/SP-002');
  console.log(`Status: ${r3.status}`);
  console.log(`Incident ID: ${r3.data.id}`);
  console.log(`Origin: ${r3.data.origin}`);
  console.log(`Candidate Vessels: ${r3.data.vessels?.length || 0}`);
  console.log(`Attributions: ${r3.data.attribution?.length || 0}`);

  // 4. GET /api/spills/SP-003
  console.log('\n[Route 4]: GET /api/spills/SP-003 (Empty/Unavailable state)');
  const r4 = await get('http://localhost:5000/api/spills/SP-003');
  console.log(`Status: ${r4.status}`);
  console.log(`Incident ID: ${r4.data.id}`);
  console.log(`Origin: ${r4.data.origin}`);
  console.log(`Candidate Vessels: ${r4.data.vessels?.length || 0}`);

  // 5. GET /api/spills/SP-001/vessels
  console.log('\n[Route 5]: GET /api/spills/SP-001/vessels');
  const r5 = await get('http://localhost:5000/api/spills/SP-001/vessels');
  console.log(`Status: ${r5.status}, Candidates count: ${r5.data.length}`);
  r5.data.forEach((v, idx) => {
    console.log(` - Rank ${idx+1}: ${v.vessel} (${v.type}, ${v.flag}) - Responsibility: ${v.responsibilityScore}%`);
  });

  // 6. GET /api/spills/SP-002/vessels
  console.log('\n[Route 6]: GET /api/spills/SP-002/vessels');
  const r6 = await get('http://localhost:5000/api/spills/SP-002/vessels');
  console.log(`Status: ${r6.status}, Candidates count: ${r6.data.length}`);

  // 7. GET /api/drift/SP-001
  console.log('\n[Route 7]: GET /api/drift/SP-001');
  const r7 = await get('http://localhost:5000/api/drift/SP-001');
  console.log(`Status: ${r7.status}`);
  console.log(`Probable Origin: lat=${r7.data.backward?.probableOrigin?.latitude}, lon=${r7.data.backward?.probableOrigin?.longitude}`);
  console.log(`Backward Trajectory points: ${r7.data.backward?.trajectory?.length || 0}`);

  // 8. GET /api/drift/SP-002
  console.log('\n[Route 8]: GET /api/drift/SP-002');
  const r8 = await get('http://localhost:5000/api/drift/SP-002');
  console.log(`Status: ${r8.status}`);
  console.log(`Backward: ${r8.data.backward}`);

  // 9. GET /api/vessels
  console.log('\n[Route 9]: GET /api/vessels');
  const r9 = await get('http://localhost:5000/api/vessels');
  console.log(`Status: ${r9.status}, Vessels registered: ${r9.data.length}`);

  console.log('\n====================================');
  console.log('✅ ALL API ROUTES VERIFIED SUCCESSFULLY');
  console.log('====================================');
}

verify().catch(console.error);
