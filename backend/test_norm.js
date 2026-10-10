function normalize(timeStr) { 
  if (!timeStr) return null; 
  let clean = timeStr; 
  if (clean.includes(' +0000 UTC')) { 
    clean = clean.replace(' +0000 UTC', 'Z'); 
    clean = clean.replace(' ', 'T'); 
    clean = clean.replace(/(\.\d{3})\d+Z$/, '$1Z'); 
  } 
  const d = new Date(clean); 
  if (isNaN(d.getTime())) return null; 
  return d.toISOString(); 
} 
console.log(normalize('2026-10-07 17:37:09.016653628 +0000 UTC')); 
console.log(normalize('2026-10-07T17:37:09.016Z'));
console.log(normalize('2026-10-07 17:37:09 +0000 UTC'));
