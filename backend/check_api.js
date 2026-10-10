const http = require('http');

http.get('http://localhost:5000/api/ingestion/queue', (resp) => {
  let data = '';
  resp.on('data', (chunk) => { data += chunk; });
  resp.on('end', () => {
    const queue = JSON.parse(data);
    const karnataka = queue.scenes.find(s => s.scene_id === 'test_s1a_karnataka_day3_ml_001');
    console.log(karnataka);
  });
}).on("error", (err) => {
  console.log("Error: " + err.message);
});
