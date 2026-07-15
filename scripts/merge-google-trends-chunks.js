import fs from "fs";

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; }
}
function writeJson(path, data) { fs.writeFileSync(path, JSON.stringify(data, null, 2)); }
function score(signal) { const n = Number(signal?.score || 0); return Number.isFinite(n) ? n : 0; }
function signalKey(signal) {
  const productIds = Array.isArray(signal?.productIds) ? signal.productIds.map(String).sort().join("|") : "";
  return [productIds, String(signal?.keyword || ""), String(signal?.usedKeyword || "")].join("::");
}
const expectedChunks = Number(process.env.GOOGLE_TRENDS_CHUNK_TOTAL || 0);
const chunkFiles = fs.readdirSync(".").filter(name => /^google-trends-chunk-\d+\.json$/.test(name)).sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0));
const metaFiles = fs.readdirSync(".").filter(name => /^google-trends-meta-chunk-\d+\.json$/.test(name)).sort();
const checkpointFiles = fs.readdirSync(".").filter(name => /^google-trends-checkpoint-chunk-\d+\.json$/.test(name)).sort();
const failedFiles = fs.readdirSync(".").filter(name => /^google-trends-failed-chunk-\d+\.json$/.test(name)).sort();
const byKey = new Map();
for (const file of chunkFiles) {
  const signals = readJson(file, []);
  if (!Array.isArray(signals)) continue;
  for (const signal of signals) {
    const key = signalKey(signal);
    const previous = byKey.get(key);
    if (!previous || score(signal) > score(previous)) byKey.set(key, signal);
  }
}
const signals = [...byKey.values()];
const rankedSignals = [...signals].sort((a, b) => score(b) - score(a));
const signalsByProduct = {};
for (const signal of signals) {
  const productIds = Array.isArray(signal.productIds) ? signal.productIds.map(String).filter(Boolean) : [];
  for (const id of productIds) {
    if (!signalsByProduct[id] || score(signal) > score(signalsByProduct[id])) signalsByProduct[id] = signal;
  }
}
const chunkIndexes = chunkFiles.map(file => Number(file.match(/\d+/)?.[0])).filter(Number.isFinite);
const missingChunks = [];
if (expectedChunks > 0) for (let i = 0; i < expectedChunks; i += 1) if (!chunkIndexes.includes(i)) missingChunks.push(i);
const metas = metaFiles.map(file => ({ file, meta: readJson(file, {}) }));
const checkpoints = checkpointFiles.map(file => ({ file, checkpoint: readJson(file, {}) }));
const failed = failedFiles.flatMap(file => { const list = readJson(file, []); return Array.isArray(list) ? list : []; });
writeJson("google-trends.json", signals);
writeJson("google-trends-ranked.json", rankedSignals);
writeJson("google-trends-by-product.json", signalsByProduct);
writeJson("google-trends-meta.json", {
  updatedAt: new Date().toISOString(), source: "google-trends-chunk-merge", expectedChunks,
  foundChunkCount: chunkFiles.length, foundChunks: chunkIndexes, missingChunks,
  savedSignalCount: signals.length, rankedSignalCount: rankedSignals.length,
  productMappedSignalCount: Object.keys(signalsByProduct).length, failedCount: failed.length,
  chunkFiles, metaFiles, checkpointFiles, failedFiles, metas, checkpoints, failed: failed.slice(0, 300)
});
console.log(`Merged ${signals.length} Google Trends signals from ${chunkFiles.length} chunk files. Missing chunks: ${missingChunks.join(", ") || "none"}`);
if (missingChunks.length) console.warn(`Warning: Missing Google Trends chunks: ${missingChunks.join(", ")}`);
