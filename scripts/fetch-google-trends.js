// DropTrend Google Trends RSS matcher - strict version
// Fixes loose matches like "rings -> pyramid rings" and "pet -> celebrity/news topic".
// Keeps output compatible with merge-trend-signals.js: google-trends.json

import { readJson, writeJson, extractKeywords, sleep } from "./utils.js";

const products = readJson("products.json", []);
const limit = Number(process.env.GOOGLE_TRENDS_LIMIT || 120);
const keywords = extractKeywords(products, limit);

const GEOS = String(process.env.GOOGLE_TRENDS_GEOS || "US,IN,GB")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

writeJson("trend-keywords.json", keywords);

const STOP_WORDS = new Set([
  "new", "hot", "sale", "fashion", "style", "quality", "good", "latest",
  "product", "products", "dropshipping", "wholesale", "supplier",
  "solid", "color", "colors", "mini", "large", "small", "piece", "pieces",
  "set", "sets", "with", "for", "and", "the", "this", "that",
  "2024", "2025", "2026", "plus", "size", "best", "high",
  "other", "replacement", "parts", "front", "only", "self", "pickup",
  "man", "men", "woman", "women", "girl", "boy", "adult", "unisex"
]);

const GENERIC_ONE_WORD_BLOCK = new Set([
  "rings", "ring", "parts", "pet", "man", "women", "men", "dress",
  "shoes", "bag", "home", "car", "baby", "toy", "watch", "shorts",
  "pants", "jeans", "furniture", "health", "care", "tools", "clothing"
]);

const NEWS_SPORTS_BLOCK = [
  "cricket", "football", "match", "team", "vs", "score", "weather",
  "forecast", "samara weaving", "martin de la torre", "tiffany haddish",
  "national", "afghanistan", "sri lanka", "celebrity", "actor", "actress",
  "movie", "politics", "election", "death", "arrest"
];

const STRONG_PRODUCT_TERMS = new Set([
  "sofa", "chair", "table", "storage", "organizer", "kitchen", "dress",
  "pants", "jeans", "sandals", "slippers", "shoes", "bracelet", "necklace",
  "watch", "bag", "lamp", "toy", "makeup", "skincare", "phone", "car",
  "baby", "fitness", "bottle", "shower", "mat", "blanket", "jacket",
  "hoodie", "cap", "hat", "shelf", "rack", "pet", "dog", "cat", "ring"
]);

const CATEGORY_EXPANSIONS = {
  sofa: ["cloud sofa", "sectional sofa", "couch", "living room sofa"],
  chair: ["office chair", "dining chair", "gaming chair"],
  table: ["coffee table", "dining table", "side table"],
  storage: ["home storage", "storage organizer", "kitchen storage"],
  organizer: ["home organizer", "storage organizer"],
  kitchen: ["kitchen storage", "kitchen organizer"],
  dress: ["summer dress", "women dress"],
  pants: ["wide leg pants", "cargo pants", "trousers"],
  jeans: ["denim jeans", "wide leg jeans"],
  sandals: ["women sandals", "summer sandals"],
  slippers: ["slippers", "slides"],
  shoes: ["sneakers", "footwear"],
  dog: ["dog toys", "dog bed", "pet supplies"],
  cat: ["cat toys", "cat bed", "pet supplies"],
  bracelet: ["bracelet", "jewelry bracelet"],
  ring: ["jewelry ring", "engagement ring"],
  necklace: ["necklace", "jewelry necklace"],
  watch: ["smart watch", "wrist watch"],
  bag: ["handbag", "travel bag"],
  lamp: ["led lamp", "desk lamp"],
  toy: ["kids toys", "pet toys"],
  makeup: ["makeup", "beauty products"],
  skincare: ["skincare", "skin care"],
  phone: ["phone case", "phone accessories"],
  car: ["car accessories"],
  baby: ["baby products"],
  fitness: ["fitness equipment"],
  bottle: ["water bottle"],
  shower: ["shower head", "bathroom accessories"],
  mat: ["floor mat", "yoga mat"],
  blanket: ["blanket", "bedding"],
  jacket: ["jacket", "outerwear"],
  hoodie: ["hoodie", "sweatshirt"],
  cap: ["cap", "hat"],
  hat: ["hat", "cap"],
  shelf: ["storage shelf"],
  rack: ["storage rack"]
};

function cleanText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, " and ")
    .replace(/&quot;/g, " ")
    .replace(/&#39;/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text) {
  return cleanText(text)
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTagBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const blocks = [];
  let m;
  while ((m = re.exec(xml))) blocks.push(m[1]);
  return blocks;
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? escapeXml(m[1].replace(/<!\\[CDATA\\[|\\]\\]>/g, "").trim()) : "";
}

function extractApproxTraffic(text) {
  const cleaned = String(text || "").replace(/,/g, "");
  const m = cleaned.match(/(\d+(\.\d+)?)\s*(k|m|million|thousand)?/i);
  if (!m) return 0;
  let n = Number(m[1]);
  const suffix = (m[3] || "").toLowerCase();
  if (suffix === "k" || suffix === "thousand") n *= 1000;
  if (suffix === "m" || suffix === "million") n *= 1000000;
  return Math.round(n);
}

function keywordVariants(keyword) {
  const words = tokens(keyword);
  if (!words.length) return [];

  const variants = new Set();

  const meaningful = words.filter(w => !GENERIC_ONE_WORD_BLOCK.has(w));
  if (words.length >= 2) variants.add(words.join(" "));
  if (meaningful.length >= 2) variants.add(meaningful.slice(0, 3).join(" "));
  if (words.length >= 3) variants.add(words.slice(0, 3).join(" "));
  if (words.length >= 2) variants.add(words.slice(0, 2).join(" "));
  if (words.length >= 2) variants.add(words.slice(-2).join(" "));

  for (const w of words) {
    if (CATEGORY_EXPANSIONS[w]) {
      for (const v of CATEGORY_EXPANSIONS[w]) variants.add(v);
    }
  }

  return [...variants]
    .map(cleanText)
    .filter(v => v.length >= 6 && tokens(v).length >= 2)
    .slice(0, 10);
}

async function fetchRss(geo) {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 DropTrendBot/1.0",
      "Accept": "application/rss+xml,text/xml,application/xml"
    }
  });

  if (!res.ok) throw new Error(`Google Trends RSS ${geo} HTTP ${res.status}`);
  const xml = await res.text();

  const items = extractTagBlocks(xml, "item");
  return items.map((item, index) => {
    const title = extractTag(item, "title");
    const description = extractTag(item, "description");
    const traffic = extractTag(item, "ht:approx_traffic") || extractTag(item, "approx_traffic");
    const newsTitles = extractTagBlocks(item, "ht:news_item_title").map(x => escapeXml(x));
    const snippets = extractTagBlocks(item, "ht:news_item_snippet").map(x => escapeXml(x));

    const titleText = cleanText(title);
    const fullText = cleanText([title, description, traffic, ...newsTitles, ...snippets].join(" "));

    return {
      geo,
      rank: index + 1,
      title,
      description,
      approxTrafficText: traffic,
      approxTraffic: extractApproxTraffic(traffic),
      titleText,
      fullText,
      source: "google-trends-rss"
    };
  });
}

function looksLikeNewsOnly(topic) {
  const t = topic.fullText;
  return NEWS_SPORTS_BLOCK.some(x => t.includes(x));
}

function hasStrongProductIntent(keywordWords, topicText) {
  const strongWords = keywordWords.filter(w => STRONG_PRODUCT_TERMS.has(w));
  if (!strongWords.length) return false;
  return strongWords.some(w => topicText.includes(w));
}

function matchScore(keyword, topic) {
  if (looksLikeNewsOnly(topic)) {
    return { score: 0, matchedVariant: "", reason: "blocked_news_or_sports" };
  }

  const variants = keywordVariants(keyword);
  const topicTitle = topic.titleText;
  const topicText = topic.fullText;
  const topicTokenSet = new Set(tokens(topicText));

  let best = 0;
  let bestVariant = "";
  let bestReason = "";

  for (const variant of variants) {
    const vTokens = tokens(variant);
    if (vTokens.length < 2) continue;

    const hits = vTokens.filter(t => topicTokenSet.has(t));
    const hitCount = hits.length;
    const ratio = hitCount / vTokens.length;
    const phraseInTitle = topicTitle.includes(variant);
    const phraseInFullText = topicText.includes(variant);

    // Strict rule: either exact phrase or at least 2 product-relevant token hits.
    if (!phraseInTitle && !phraseInFullText && hitCount < 2) continue;

    // Avoid matching only generic terms.
    const nonGenericHits = hits.filter(h => !GENERIC_ONE_WORD_BLOCK.has(h));
    const keywordHasProductIntent = hasStrongProductIntent(vTokens, topicText);

    if (!phraseInTitle && nonGenericHits.length < 1 && !keywordHasProductIntent) continue;

    let score = 0;
    if (phraseInTitle) score += 70;
    else if (phraseInFullText) score += 55;
    score += Math.round(ratio * 30);

    const trafficBoost = Math.min(12, Math.log10((topic.approxTraffic || 0) + 1) * 2.5);
    const rankBoost = Math.max(0, 8 - topic.rank);
    score += Math.round(trafficBoost + rankBoost);

    score = Math.min(92, score);

    if (score > best) {
      best = score;
      bestVariant = variant;
      bestReason = phraseInTitle ? "phrase_title" : phraseInFullText ? "phrase_text" : "token_match";
    }
  }

  return {
    score: best,
    matchedVariant: bestVariant,
    reason: bestReason
  };
}

const topics = [];
for (const geo of GEOS) {
  try {
    console.log(`Fetching Google Trends RSS for ${geo}...`);
    const geoTopics = await fetchRss(geo);
    console.log(`Loaded ${geoTopics.length} Google RSS topics for ${geo}.`);
    topics.push(...geoTopics);
    await sleep(500);
  } catch (err) {
    console.log(`Google Trends RSS failed for ${geo}: ${err.message}`);
  }
}

const signals = [];
const rejected = [];

for (const item of keywords) {
  const keyword = item.keyword;
  let bestTopic = null;
  let bestMatch = { score: 0, matchedVariant: "", reason: "" };

  for (const topic of topics) {
    const score = matchScore(keyword, topic);
    if (score.score > bestMatch.score) {
      bestMatch = score;
      bestTopic = topic;
    }
  }

  // Higher threshold to prevent nonsense matches.
  if (bestTopic && bestMatch.score >= 65) {
    const googleTrendScore = Math.round(bestMatch.score);

    signals.push({
      keyword,
      usedKeyword: bestMatch.matchedVariant,
      topic: bestTopic.title,
      geo: bestTopic.geo,
      rank: bestTopic.rank,
      approxTraffic: bestTopic.approxTraffic,
      approxTrafficText: bestTopic.approxTrafficText,
      score: googleTrendScore,
      rawScore: googleTrendScore,
      growthPercent: 100,
      match: 1,
      reason: bestMatch.reason,
      source: "google-trends-rss-strict",
      fetchedAt: new Date().toISOString()
    });

    console.log(`Google RSS strict match: ${keyword} -> ${bestTopic.title} (${bestTopic.geo}) score ${googleTrendScore}`);
  } else {
    rejected.push({
      keyword,
      bestTopic: bestTopic?.title || "",
      bestScore: bestMatch.score,
      reason: bestMatch.reason || "no_strong_match"
    });
  }
}

signals.sort((a, b) => b.score - a.score);

writeJson("google-trends.json", signals);
writeJson("google-trends-meta.json", {
  updatedAt: new Date().toISOString(),
  source: "google-trends-rss-strict",
  geos: GEOS,
  attemptedKeywordCount: keywords.length,
  topicCount: topics.length,
  savedSignalCount: signals.length,
  rejectedCount: rejected.length,
  note: "Strict RSS matching: requires exact phrase or multiple relevant product token matches. Blocks broad news/sports/celebrity matches.",
  rejected: rejected.slice(0, 100)
});

console.log(`Saved ${signals.length} strict Google Trends RSS signals from ${keywords.length} attempted keywords and ${topics.length} RSS topics.`);
