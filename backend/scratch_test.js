require('dotenv').config({path: '../.env'});
const sentinel = require('../src/services/sentinel.service');

async function test() {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 24 * 3600 * 1000); // last 10 days
    const datetime = `${from.toISOString()}/${to.toISOString()}`;
    const bbox = [74.5, 12.5, 74.69, 12.69];
    
    // We cannot use searchCatalog directly because it validates the datetime is <= 24 hours.
    // Instead we will loop day by day.
    let currentFrom = new Date(from);
    let totalScenes = 0;
    
    while(currentFrom < to) {
      const currentTo = new Date(Math.min(currentFrom.getTime() + 23 * 3600 * 1000, to.getTime()));
      const dt = `${currentFrom.toISOString()}/${currentTo.toISOString()}`;
      const res = await sentinel.searchCatalog({
        bbox,
        datetime: dt,
        limit: 5,
        collections: ['sentinel-1-grd']
      });
      if (res.features && res.features.length > 0) {
        console.log(`Found ${res.features.length} scenes in ${dt}`);
        res.features.forEach(f => console.log(` - ${f.id} (Platform: ${f.properties.platform})`));
        totalScenes += res.features.length;
      }
      currentFrom = new Date(currentTo.getTime() + 1000);
    }
    console.log(`Total scenes in last 10 days for [74.5, 12.5, 74.69, 12.69]: ${totalScenes}`);
  } catch (err) {
    console.error(err);
  }
}
test();
