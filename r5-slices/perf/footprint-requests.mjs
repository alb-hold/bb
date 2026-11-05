import { readFileSync, appendFileSync, existsSync } from "node:fs";
const root = "r5-slices/perf";
const seen = new Set();
while (true) {
  if (existsSync(root + "/candidate-soak.json")) {
    try {
      const rows = JSON.parse(readFileSync(root + "/candidate-soak.json"));
      for (const row of rows) {
        if (!seen.has(row.navigation)) {
          appendFileSync(
            root + "/footprint-requests.txt",
            `candidate-${row.navigation} 67005\n`,
          );
          seen.add(row.navigation);
          console.log(row.navigation);
        }
      }
      if (seen.has(300)) break;
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 1000));
}
