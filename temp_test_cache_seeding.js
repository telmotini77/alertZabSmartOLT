import { initCache, getCachedNaps } from './src/services/cache.js';

async function test() {
  console.log("🧪 Testing cache initialization and coordinates seeding...");
  await initCache();
  
  const naps = getCachedNaps();
  console.log(`Total NAPs in cache: ${naps.length}`);
  
  const withCoords = naps.filter(n => n.latitude !== null && n.longitude !== null);
  console.log(`Total NAPs with coordinates: ${withCoords.length}`);
  
  if (withCoords.length > 0) {
    console.log("✅ SUCCESS: Coordinates successfully seeded and loaded into memory!");
    console.log("Sample NAPs with coords (first 3):");
    withCoords.slice(0, 3).forEach(n => {
      console.log(`  - ${n.name}: [${n.latitude.toFixed(6)}, ${n.longitude.toFixed(6)}]`);
    });
  } else {
    console.log("❌ FAILURE: No NAPs have coordinates in the cache.");
  }
}

test();
