import si from "systeminformation";

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function measureOverhead() {
  console.log("Measuring Baseline CPU (10s)...");
  await si.currentLoad(); // prime
  await sleep(10000);
  const baseline = await si.currentLoad();
  console.log(`Baseline CPU: ${baseline.currentLoad.toFixed(2)}%`);

  console.log("Measuring CPU during heavy polling (10s)...");
  const end = Date.now() + 10000;
  let iters = 0;
  while(Date.now() < end) {
      await Promise.all([
        si.mem(),
        si.graphics(),
        si.networkStats(),
        si.cpuTemperature()
      ]);
      iters++;
  }
  const heavy = await si.currentLoad();
  console.log(`Heavy Polling CPU: ${heavy.currentLoad.toFixed(2)}%, Iterations: ${iters}`);
}

measureOverhead().catch(console.error);
