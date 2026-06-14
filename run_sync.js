import { syncHistory } from "./dist/index.js";

async function run() {
  console.log("Starting full sync...");
  const start = Date.now();
  await syncHistory();
  console.log(`Sync completed in ${(Date.now() - start) / 1000}s!`);
}

run();
