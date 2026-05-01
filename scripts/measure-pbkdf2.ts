// Saturday spike: pin PBKDF2 iters BEFORE shipping auth.
//
// Run: bun run scripts/measure-pbkdf2.ts
//
// Local Bun timing is FASTER than Workers free-tier 10ms CPU. Treat numbers
// here as a lower bound. Real validation = deploy auth, hit /admin/login on
// stage Worker, watch Workers Insights CPU graph.

const SALT_LEN = 16;
const HASH_LEN = 32;
const PASSWORD = "test-password-of-reasonable-length-1234";

async function pbkdf2Once(iters: number): Promise<number> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PASSWORD),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const start = performance.now();
  await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iters },
    key,
    HASH_LEN * 8,
  );
  return performance.now() - start;
}

async function measure(iters: number, runs = 5): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) samples.push(await pbkdf2Once(iters));
  samples.sort((a, b) => a - b);
  // Drop best/worst, average the middle. Smooths cold-isolate spikes.
  const trimmed = samples.slice(1, -1);
  const avg = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
  return avg;
}

console.log("PBKDF2-SHA256 timing on local Bun (lower bound vs Workers):\n");
for (const iters of [10_000, 30_000, 100_000, 300_000, 600_000]) {
  const ms = await measure(iters);
  console.log(`  ${iters.toString().padStart(7)} iters: ${ms.toFixed(2)}ms`);
}
console.log(
  "\nWorkers free tier CPU budget: 10ms/req. Pick the highest iters that\n" +
    "comfortably stays under ~8ms in real Workers measurement (Workers Insights).\n",
);
