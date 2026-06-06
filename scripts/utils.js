import fs from "fs";

export function readJson(path, fallback = []) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; }
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

const STOP_WORDS = new Set([
  "new","2026","2025","2024","for","with","and","the","hot","sale","style",
  "wholesale","supplier","cross","border","dropshipping","product","products",
  "high","quality","good","latest","best","top","trending","viral","free",
  "piece","pieces","set","sets","pack","pcs","lot","bulk","use","using",
  "creative","luxury","modern","simple","popular","cheap","premium"
]);

const AUDIENCE = new Set([
  "men","mens","male","man","women","womens","woman","female","ladies",
  "girl","girls","boy","boys","kids","children","baby","toddler",
  "dog","cat","pet","puppy","kitten"
]);

const SEASON_USE = new Set([
  "summer","winter","spring","autumn","fall","outdoor","indoor","travel",
  "camping","office","home","kitchen","bathroom","garden","car","gym",
  "school","beach","party","wedding","sports","fitness"
]);

const FEATURES = new Set([
  "portable","foldable","waterproof","wireless","rechargeable","electric",
  "smart","led","usb","mini","large","small","adjustable","automatic",
  "multifunctional","nonstick","anti","slip","magnetic","rotating",
  "thermal","insulated","reusable","disposable","inflatable"
]);

const MATERIALS = new Set([
  "silicone","leather","cotton","metal","wood","wooden","iron","steel",
  "plastic","glass","ceramic","bamboo","linen","wool","denim","mesh",
  "rubber","acrylic","stainless","aluminum","velvet","canvas"
]);

const CORE_PRODUCT_TERMS = new Set([
  "shirt","shirts","tshirt","tshirts","dress","dresses","pants","jeans","shorts","jacket","hoodie","coat","suit","suits","blazer","top","tops","skirt","leggings",
  "sandals","slippers","shoes","sneakers","boots","bag","bags","backpack","wallet","watch","watches",
  "ring","rings","bracelet","bracelets","necklace","earrings","jewelry",
  "sofa","chair","table","desk","lamp","light","lights","shelf","rack","storage","organizer","cabinet","drawer","mat","rug","blanket","pillow","cover","curtain","stool","bench",
  "bottle","cup","mug","cooker","pan","knife","tool","tools","brush","roller","massager","mirror","comb","scissors",
  "toy","toys","bed","beds","case","holder","stand","charger","cable","camera","speaker","headphones","earbuds",
  "makeup","skincare","cream","serum","mask","shower","faucet","filter","pump","sprayer",
  "collar","leash","harness","bowl","feeder","litter","cage","scratcher",
  "phone","tablet","laptop","keyboard","mouse","tripod","humidifier","fan","heater"
]);

const PHRASE_SYNONYMS = [
  { re: /\bt\s*shirt\b/g, value: "tshirt" },
  { re: /\btee shirt\b/g, value: "tshirt" },
  { re: /\bcell phone\b/g, value: "phone" },
  { re: /\bmobile phone\b/g, value: "phone" },
  { re: /\bcoffee table\b/g, value: "coffee table" },
  { re: /\bside table\b/g, value: "side table" },
  { re: /\bdining table\b/g, value: "dining table" },
  { re: /\bdesk lamp\b/g, value: "desk lamp" },
  { re: /\bface brush\b/g, value: "face brush" },
  { re: /\bcar seat cover\b/g, value: "car seat cover" },
  { re: /\bdog bed\b/g, value: "dog bed" },
  { re: /\bcat bed\b/g, value: "cat bed" },
  { re: /\bphone holder\b/g, value: "phone holder" },
  { re: /\bstorage box\b/g, value: "storage box" },
  { re: /\bstorage rack\b/g, value: "storage rack" }
];

function normalizeToken(token) {
  const t = String(token || "").toLowerCase();
  const map = {
    mens:"men", man:"men", male:"men",
    womens:"women", woman:"women", female:"women", ladies:"women",
    children:"kids", child:"kids",
    tshirts:"tshirt", shirts:"shirt", dresses:"dress", watches:"watch",
    bracelets:"bracelet", rings:"ring", bags:"bag", toys:"toy", beds:"bed",
    lights:"light", wooden:"wood", stainless:"steel", puppies:"puppy", kittens:"kitten"
  };
  return map[t] || t;
}

export function tokenizeProductText(text) {
  let s = cleanProductName(text).toLowerCase();
  for (const item of PHRASE_SYNONYMS) s = s.replace(item.re, item.value);
  s = s.replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();

  return s
    .split(/\s+/)
    .map(normalizeToken)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function unique(list) {
  return [...new Set(list.filter(Boolean).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function makeKeyword(text) {
  const words = tokenizeProductText(text);
  return words.slice(0, 4).join(" ").trim();
}

// AI-style local extractor: finds product core, modifiers, audience, material and use-case.
// No paid AI API needed. It is deterministic and safe for GitHub Actions.
export function extractProductIntent(text, category = "") {
  const allText = `${category} ${text}`;
  const words = tokenizeProductText(allText);

  const audience = words.filter(w => AUDIENCE.has(w));
  const seasonUse = words.filter(w => SEASON_USE.has(w));
  const features = words.filter(w => FEATURES.has(w));
  const materials = words.filter(w => MATERIALS.has(w));
  const cores = words.filter(w => CORE_PRODUCT_TERMS.has(w));

  const phraseCandidates = [];
  const clean = words.join(" ");

  // Try to preserve important adjacent product phrases.
  for (let i = 0; i < words.length - 1; i++) {
    const pair = `${words[i]} ${words[i + 1]}`;
    if (CORE_PRODUCT_TERMS.has(words[i]) || CORE_PRODUCT_TERMS.has(words[i + 1])) {
      phraseCandidates.push(pair);
    }
  }

  for (let i = 0; i < words.length - 2; i++) {
    const tri = words.slice(i, i + 3).join(" ");
    if (words.slice(i, i + 3).some(w => CORE_PRODUCT_TERMS.has(w))) {
      phraseCandidates.push(tri);
    }
  }

  return {
    words,
    audience: unique(audience),
    seasonUse: unique(seasonUse),
    features: unique(features),
    materials: unique(materials),
    cores: unique(cores),
    phrases: unique(phraseCandidates),
    clean
  };
}

export function makeSpecificKeywords(text, category = "") {
  const intent = extractProductIntent(text, category);
  const keywords = [];
  const { audience, seasonUse, features, materials, cores, phrases, words } = intent;

  // 1. Most specific: audience/material/feature/use + core.
  for (const core of cores) {
    for (const a of audience) if (a !== core) keywords.push(`${a} ${core}`);
    for (const m of materials) if (m !== core) keywords.push(`${m} ${core}`);
    for (const f of features) if (f !== core) keywords.push(`${f} ${core}`);
    for (const u of seasonUse) if (u !== core) keywords.push(`${u} ${core}`);
  }

  // 2. Strong 3-word combinations: men cotton shirt, wood coffee table, dog car cover.
  for (const core of cores) {
    for (const a of audience) {
      for (const m of materials) if (a !== m && m !== core) keywords.push(`${a} ${m} ${core}`);
      for (const f of features) if (a !== f && f !== core) keywords.push(`${a} ${f} ${core}`);
      for (const u of seasonUse) if (a !== u && u !== core) keywords.push(`${a} ${u} ${core}`);
    }
    for (const m of materials) {
      for (const f of features) if (m !== f && f !== core) keywords.push(`${m} ${f} ${core}`);
      for (const u of seasonUse) if (m !== u && u !== core) keywords.push(`${m} ${u} ${core}`);
    }
  }

  // 3. Original useful phrases from title/category.
  keywords.push(...phrases);

  // 4. Adjacent 2-word and 3-word phrases.
  for (let i = 0; i < words.length - 1; i++) keywords.push(`${words[i]} ${words[i + 1]}`);
  for (let i = 0; i < words.length - 2; i++) keywords.push(words.slice(i, i + 3).join(" "));

  // 5. Full concise phrase.
  const full = words.slice(0, 4).join(" ");
  if (full) keywords.push(full);

  // 6. Core product fallback.
  for (const core of cores) keywords.push(core);

  return unique(keywords)
    .filter(k => k.length >= 4)
    .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || a.localeCompare(b))
    .slice(0, 12);
}

export function extractKeywords(products, limit = 120) {
  const counts = new Map();

  for (const p of products) {
    const rawName = p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "";
    const category = p.category || p.categoryName || p.raw?.categoryName || "";

    const candidates = [
      ...makeSpecificKeywords(rawName, category),
      ...makeSpecificKeywords(category, rawName)
    ];

    for (const kw of candidates) {
      if (!kw || kw.length < 4) continue;

      const wc = kw.split(/\s+/).length;
      const hasCore = kw.split(/\s+/).some(w => CORE_PRODUCT_TERMS.has(w));
      const hasModifier = kw.split(/\s+/).some(w => AUDIENCE.has(w) || SEASON_USE.has(w) || FEATURES.has(w) || MATERIALS.has(w));

      let weight = wc >= 3 ? 6 : wc === 2 ? 4 : 1;
      if (hasCore && hasModifier) weight += 4;
      if (hasCore) weight += 2;

      counts.set(kw, (counts.get(kw) || 0) + weight);
    }
  }

  return [...counts.entries()]
    .sort((a,b) => b[1] - a[1] || b[0].split(/\s+/).length - a[0].split(/\s+/).length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }));
}
