import fs from "fs";

export function readJson(path, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

export function num(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function cleanProductName(value) {
  let s = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value ?? "");
  s = s.trim();
  if ((s.startsWith("[") && s.endsWith("]")) || s.includes('","') || s.includes("','")) {
    try {
      const parsed = JSON.parse(s.replace(/'/g, '"'));
      if (Array.isArray(parsed)) s = parsed.filter(Boolean).join(" ");
    } catch {
      s = s.replace(/^\s*\[+/, "").replace(/\]+\s*$/, "").replace(/["']/g, "").replace(/,/g, " ");
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

export function makeKeyword(text) {
  const stop = new Set([
    "new","2026","2025","2024","for","with","and","the","hot","sale","fashion","style",
    "men","mens","women","womens","woman","male","female","wholesale","supplier",
    "cross","border","dropshipping","product","products","high","quality","good",
    "summer","winter","spring","autumn","portable","multifunctional"
  ]);
  let s = cleanProductName(text).toLowerCase();
  s = s.replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  const words = s.split(" ").filter(w => w.length > 2 && !stop.has(w));
  return words.slice(0, 4).join(" ").trim();
}

export function extractKeywords(products, limit = 120) {
  const counts = new Map();
  for (const p of products) {
    const rawName = p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "";
    const category = p.category || p.categoryName || p.raw?.categoryName || "";
    const candidates = [
      makeKeyword(rawName),
      makeKeyword(category),
      makeKeyword(`${category} ${rawName}`)
    ];
    for (const kw of candidates) {
      if (kw && kw.length >= 4) counts.set(kw, (counts.get(kw) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a,b) => b[1] - a[1])
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }));
}
