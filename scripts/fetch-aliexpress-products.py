#!/usr/bin/env python3
"""
AliExpress source product fetcher using nodriver.
- Page 1 only for each seed keyword/category.
- URL is sorted by orders/sales where AliExpress honors sortType=total_tranpro_desc.
- Saves products with title + URL + image even when price is hidden.
- Falls back to previous aliexpress-products.json if AliExpress blocks heavily.
"""

import asyncio
import html
import json
import math
import os
import random
import re
import sys
import time
import shutil
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

try:
    from bs4 import BeautifulSoup
except Exception:
    BeautifulSoup = None

MAX_PRODUCTS = int(os.getenv("ALIEXPRESS_MAX_PRODUCTS", "750"))
MAX_SEARCHES = int(os.getenv("ALIEXPRESS_MAX_SEARCHES", "70"))
PRODUCTS_PER_KEYWORD = int(os.getenv("ALIEXPRESS_PRODUCTS_PER_KEYWORD", "60"))
MIN_PRODUCTS_PER_KEYWORD = int(os.getenv("ALIEXPRESS_MIN_PRODUCTS_PER_KEYWORD", "12"))
DELAY_MS = int(os.getenv("ALIEXPRESS_DELAY_MS", "2500"))
SEARCH_TIMEOUT_MS = int(os.getenv("ALIEXPRESS_TIMEOUT_MS", "60000"))
HEADLESS = os.getenv("ALIEXPRESS_HEADLESS", "true").lower() != "false"
FALLBACK_CACHE = os.getenv("ALIEXPRESS_FALLBACK_CACHE", "true").lower() != "false"
MAX_RETRIES = int(os.getenv("ALIEXPRESS_RETRIES", "3"))
SESSION_KEYWORD_BATCH_SIZE = int(os.getenv("ALIEXPRESS_SESSION_KEYWORD_BATCH_SIZE", "8"))

OUTPUT_PATH = Path(os.getenv("ALIEXPRESS_OUTPUT_PATH", "aliexpress-products.json"))
META_PATH = Path(os.getenv("ALIEXPRESS_META_PATH", "aliexpress-meta.json"))
KEYWORDS_PATH = Path(os.getenv("ALIEXPRESS_KEYWORDS_PATH", "aliexpress-keywords.json"))

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]

SEED_KEYWORDS = [
    "home gadgets", "kitchen gadgets", "pet supplies", "cat toy", "dog grooming",
    "beauty tools", "skin care tools", "hair styling tools", "phone accessories",
    "car accessories", "car vacuum", "led lights", "room decor", "travel accessories",
    "fitness equipment", "yoga accessories", "baby products", "kids toys", "summer dress",
    "women dress", "mens fashion", "storage organizer", "bathroom organizer",
    "makeup organizer", "smart watch accessories", "wireless earbuds", "portable blender",
    "neck fan", "electric chopper", "desk lamp", "gaming accessories", "outdoor camping",
    "garden tools", "jewelry accessories", "nail tools", "massage tools", "posture corrector",
    "water bottle", "laptop stand", "cleaning brush", "mini printer", "humidifier",
    "air purifier", "mosquito lamp", "shoe organizer", "laundry organizer", "wall hooks",
    "silicone mold", "coffee accessories",
]

FALLBACK_QUERY_MAP = {
    "neck fan": ["portable neck fan", "usb neck fan", "portable fan", "mini fan"],
    "desk lamp": ["led desk lamp", "study lamp", "table lamp"],
    "kids toys": ["children toys", "baby toys", "educational toys"],
    "car vacuum": ["portable car vacuum", "wireless car vacuum", "mini vacuum cleaner"],
    "humidifier": ["mini humidifier", "usb humidifier", "air humidifier"],
    "led lights": ["led strip lights", "rgb led lights", "room led lights"],
    "nail tools": ["nail art tools", "manicure tools", "nail drill"],
    "massage tools": ["massage gun", "neck massager", "body massager"],
    "mini printer": ["portable printer", "thermal printer", "label printer"],
    "mosquito lamp": ["mosquito killer lamp", "bug zapper", "mosquito trap"],
    "shoe organizer": ["shoe rack", "shoe storage", "closet shoe organizer"],
    "laundry organizer": ["laundry basket", "laundry storage", "laundry bag"],
    "wall hooks": ["adhesive wall hooks", "storage hooks", "kitchen hooks"],
    "silicone mold": ["resin mold", "cake mold", "silicone baking mold"],
    "coffee accessories": ["coffee tools", "espresso accessories", "coffee grinder"],
    "home gadgets": ["smart home gadgets", "useful home gadgets", "household gadgets"],
    "kitchen gadgets": ["kitchen tools", "kitchen accessories", "cooking gadgets"],
    "pet supplies": ["pet accessories", "dog supplies", "cat supplies"],
    "beauty tools": ["beauty devices", "makeup tools", "skin care tools"],
    "phone accessories": ["mobile phone accessories", "iphone accessories", "phone holder"],
    "car accessories": ["auto accessories", "car interior accessories", "car gadgets"],
    "room decor": ["home decor", "bedroom decor", "wall decor"],
    "travel accessories": ["travel gadgets", "luggage accessories", "travel organizer"],
    "fitness equipment": ["workout equipment", "fitness accessories", "resistance bands"],
    "yoga accessories": ["yoga mat", "yoga equipment", "pilates accessories"],
    "baby products": ["baby accessories", "baby care", "baby toys"],
    "summer dress": ["women summer dress", "beach dress", "casual dress"],
    "women dress": ["women dresses", "casual dress", "party dress"],
    "mens fashion": ["men fashion", "mens clothing", "men accessories"],
    "storage organizer": ["home organizer", "storage box", "closet organizer"],
    "bathroom organizer": ["bathroom storage", "shower organizer", "toothbrush holder"],
    "makeup organizer": ["cosmetic organizer", "makeup storage", "beauty organizer"],
    "smart watch accessories": ["watch strap", "smartwatch band", "apple watch band"],
    "wireless earbuds": ["bluetooth earbuds", "wireless headphones", "earphones"],
    "portable blender": ["mini blender", "usb blender", "juice blender"],
    "electric chopper": ["food chopper", "mini chopper", "garlic chopper"],
    "gaming accessories": ["gaming gadgets", "game controller", "gaming keyboard"],
    "outdoor camping": ["camping gear", "camping accessories", "outdoor gear"],
    "garden tools": ["gardening tools", "garden accessories", "plant tools"],
    "jewelry accessories": ["fashion jewelry", "earrings", "necklace"],
}


def read_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def clean_text(value):
    return re.sub(r"\s+", " ", html.unescape(str(value or "").replace("\xa0", " "))).strip()


def normalize_keyword(value):
    s = clean_text(value).lower()
    s = re.sub(r"[^a-z0-9\s-]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def hash_id(text):
    h = 2166136261
    for ch in str(text or ""):
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return format(h, "x")


def safe_url(value):
    s = str(value or "").strip().replace("\\/", "/")
    if not s:
        return ""
    if s.startswith("//"):
        s = "https:" + s
    if s.startswith("/"):
        s = urljoin("https://www.aliexpress.com", s)
    try:
        u = urlparse(s)
        if u.scheme not in ("http", "https"):
            return ""
        return s
    except Exception:
        return ""


def absolute_image(value):
    s = str(value or "").strip().replace("\\/", "/")
    if not s:
        return ""
    s = s.split(",")[0].strip().split()[0].strip()
    if s.startswith("//"):
        s = "https:" + s
    if s.startswith("/"):
        s = "https:" + s
    if not re.match(r"^https?://", s, re.I):
        return ""
    if re.search(r"data:image|blank|placeholder|transparent|base64", s, re.I):
        return ""
    return s


def parse_price(text):
    s = clean_text(text)
    patterns = [
        r"(?:US\s*)?[$€£₹]\s*([0-9]+(?:[.,][0-9]{1,2})?)",
        r"(?:USD|EUR|GBP|INR)\s*([0-9]+(?:[.,][0-9]{1,2})?)",
        r"([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:USD|EUR|GBP|INR)",
    ]
    vals = []
    for pat in patterns:
        for m in re.finditer(pat, s, re.I):
            try:
                n = float(m.group(1).replace(",", "."))
                if 0 < n < 100000:
                    vals.append(n)
            except Exception:
                pass
    return min(vals) if vals else 0


def parse_orders(text):
    s = clean_text(text).lower()
    patterns = [
        r"([0-9]+(?:[.,][0-9]+)?)(k|m)?\s*(?:sold|orders|ordered|purchased|vendidos|vendu)",
        r"(?:sold|orders|ordered|purchased)\s*([0-9]+(?:[.,][0-9]+)?)(k|m)?",
    ]
    for pat in patterns:
        m = re.search(pat, s, re.I)
        if not m:
            continue
        base = float(m.group(1).replace(",", "."))
        mult = 1000000 if (m.group(2) or "").lower() == "m" else 1000 if (m.group(2) or "").lower() == "k" else 1
        return round(base * mult)
    return 0


def parse_rating(text):
    m = re.search(r"\b([1-4](?:\.\d)?|5(?:\.0)?)\b\s*(?:/\s*5|stars?|star rating)?", clean_text(text), re.I)
    if not m:
        return 0
    n = float(m.group(1))
    return n if 1 <= n <= 5 else 0


def parse_discount(text):
    m = re.search(r"(\d{1,2})\s*%\s*off", clean_text(text), re.I)
    return int(m.group(1)) if m else 0


def is_blocked_text(text):
    return bool(re.search(r"captcha|verify you are human|robot check|security check|unusual traffic|slide to verify|access denied|sorry, we have detected unusual traffic|login required", str(text or ""), re.I))


def make_urls(keyword, page=1):
    encoded = quote(keyword)
    slug = normalize_keyword(keyword).replace(" ", "-")
    return [
        f"https://www.aliexpress.com/wholesale?SearchText={encoded}&sortType=total_tranpro_desc&page={page}&trafficChannel=main&g=y&d=y",
        f"https://www.aliexpress.com/w/wholesale-{slug}.html?SearchText={encoded}&sortType=total_tranpro_desc&page={page}&g=y&d=y&trafficChannel=main",
        f"https://www.aliexpress.us/w/wholesale-{slug}.html?SearchText={encoded}&sortType=total_tranpro_desc&page={page}&g=y&d=y&trafficChannel=main",
    ]


def query_variants(keyword):
    base = normalize_keyword(keyword)
    variants = [base]
    variants.extend(FALLBACK_QUERY_MAP.get(base, []))
    words = base.split()
    if len(words) > 1:
        variants.append(" ".join(words[-2:]))
        variants.append(words[-1])
    out = []
    for v in variants:
        v = normalize_keyword(v)
        if v and v not in out:
            out.append(v)
    return out[:5]


def build_keyword_pool():
    return [{"keyword": k, "weight": 3} for k in SEED_KEYWORDS[:MAX_SEARCHES]]


def raw_key(p):
    pid = str(p.get("productId") or "").strip()
    if pid:
        return "id:" + pid
    url = safe_url(p.get("url"))
    if url:
        return "url:" + re.sub(r"[?#].*$", "", url)
    return "name:" + normalize_keyword((p.get("title") or "") + " " + (p.get("image") or ""))[:180]


def dedupe_raw(items):
    m = {}
    for p in items:
        key = raw_key(p)
        if not key or key == "name:":
            continue
        score = sum(1 for k in ("title", "url", "image", "priceText", "soldText") if p.get(k))
        if key not in m or score > m[key][0]:
            m[key] = (score, p)
    return [v[1] for v in m.values()]


def extract_dom_products(page_html, source_url=""):
    out = []
    if not page_html:
        return out
    if BeautifulSoup is None:
        return extract_regex_products(page_html, source_url)

    soup = BeautifulSoup(page_html, "html.parser")
    links = soup.select('a[href*="/item/"]')
    seen = set()
    for link in links:
        href = safe_url(link.get("href") or "")
        if not href or href in seen:
            continue
        seen.add(href)
        product_id = ""
        m = re.search(r"/item/(\d+)\.html", href)
        if m:
            product_id = m.group(1)

        # Walk up to a card-like container with image/text.
        root = link
        best = link
        for _ in range(10):
            if not getattr(root, "parent", None):
                break
            text = clean_text(root.get_text(" "))
            imgs = root.select("img, source") if hasattr(root, "select") else []
            item_links = root.select('a[href*="/item/"]') if hasattr(root, "select") else []
            if imgs and 8 <= len(text) <= 2400 and len(item_links) <= 8:
                best = root
            root = root.parent

        text = clean_text(best.get_text(" "))
        image = ""
        for img in best.select("img, source") if hasattr(best, "select") else []:
            for attr in ("src", "data-src", "data-lazy-src", "data-original", "srcset", "data-srcset"):
                image = absolute_image(img.get(attr))
                if image:
                    break
            if image:
                break

        title = clean_text(link.get("title") or link.get("aria-label") or link.get_text(" "))
        if len(title) < 8:
            # Try alt text then first meaningful text chunk.
            img = best.select_one("img") if hasattr(best, "select_one") else None
            title = clean_text((img.get("alt") if img else "") or "")
        if len(title) < 8:
            parts = [p.strip() for p in re.split(r"\s{2,}|\n|\|", text) if len(p.strip()) >= 8]
            # Avoid pure price/order strings.
            parts = [p for p in parts if not re.fullmatch(r"[\$€£₹\d.,\s%-]+", p)]
            title = parts[0] if parts else title

        if title and image and href:
            out.append({
                "productId": product_id,
                "title": title[:260],
                "url": href,
                "image": image,
                "text": text[:1600],
                "priceText": text,
                "soldText": text,
                "ratingText": text,
                "discountText": text,
                "sourceUrl": source_url,
            })
    return dedupe_raw(out)


def extract_regex_products(text, source_url=""):
    out = []
    raw = str(text or "")
    # Extract around item links.
    for m in re.finditer(r"(?:https?:)?//[^\"'\s<>]+?/item/(\d+)\.html[^\"'\s<>]*|/item/(\d+)\.html[^\"'\s<>]*", raw, re.I):
        product_id = m.group(1) or m.group(2) or ""
        start = max(0, m.start() - 5000)
        end = min(len(raw), m.end() + 7000)
        chunk = raw[start:end]
        url = safe_url(m.group(0)) or f"https://www.aliexpress.com/item/{product_id}.html"
        im = re.search(r"((?:https?:)?//[^\"'\s<>]+?\.(?:jpg|jpeg|png|webp)[^\"'\s<>]*)", chunk, re.I)
        image = absolute_image(im.group(1)) if im else ""
        alt = re.search(r"alt=[\"']([^\"']{8,260})[\"']", chunk, re.I)
        title = clean_text(alt.group(1) if alt else "")
        if title and image and url:
            out.append({"productId": product_id, "title": title, "url": url, "image": image, "text": clean_text(chunk[:1200]), "sourceUrl": source_url})
    return dedupe_raw(out)


def source_score(p, rank):
    score = 0
    if p.get("image"):
        score += 18
    price = p.get("price", 0)
    orders = p.get("orders", 0)
    rating = p.get("rating", 0)
    discount = p.get("discount", 0)
    margin = p.get("margin", 0)
    if price > 0:
        score += 12
    score += min(30, math.log10(orders + 1) * 12)
    score += min(20, max(0, rating - 3.5) * 14)
    score += min(8, discount / 8)
    score += min(6, max(0, margin - 35) * 0.2)
    if rank <= 5:
        score += 8
    elif rank <= 12:
        score += 4
    return round(max(1, min(100, score)))


def normalize_product(raw, keyword, rank):
    title = clean_text(raw.get("title"))
    url = safe_url(raw.get("url"))
    image = absolute_image(raw.get("image"))
    if not title or not url or not image:
        return None
    product_id = str(raw.get("productId") or "").strip()
    if not product_id:
        m = re.search(r"/item/(\d+)\.html", url)
        product_id = m.group(1) if m else hash_id(f"{title}|{url}|{keyword}")

    text = clean_text(" ".join(str(raw.get(k, "")) for k in ("text", "priceText", "soldText", "ratingText", "discountText")))
    price = parse_price(text)
    orders = parse_orders(text)
    rating = parse_rating(text)
    discount = parse_discount(text)
    sell = math.ceil(price * 2.25) if price > 0 else 0
    shipping = 0
    profit = max(0, sell - price - shipping) if sell else 0
    margin = round((profit / sell) * 100) if sell else 0
    score = source_score({"image": image, "price": price, "orders": orders, "rating": rating, "discount": discount, "margin": margin}, rank)
    return {
        "id": f"aliexpress-{product_id}",
        "sourceProductId": product_id,
        "name": title,
        "productName": title,
        "productNameEn": title,
        "image": image,
        "supplier": "AliExpress",
        "source": "AliExpress",
        "marketplace": "AliExpress",
        "supplierUrl": url,
        "productUrl": url,
        "supplierPrice": price,
        "cost": price,
        "originalPrice": price,
        "shippingPrice": shipping,
        "shipping": shipping,
        "suggestedPrice": sell,
        "sell": sell,
        "profit": profit,
        "margin": margin,
        "currency": "USD",
        "category": f"AliExpress / {keyword}",
        "market": "Worldwide",
        "listedCount": orders,
        "inventory": 0,
        "orders": orders,
        "soldCount": orders,
        "rating": rating,
        "discount": discount,
        "deliveryTime": "Check AliExpress",
        "aliExpressKeyword": keyword,
        "aliExpressRank": rank,
        "sourceScore": score,
        "trend": score,
        "winningScore": score + min(40, math.log10(orders + 1) * 16),
        "tags": ["AliExpress product", "AliExpress top search page"],
        "raw": raw,
    }


async def start_browser(uc):
    browser_args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--window-size=1440,3600",
        f"--user-agent={random.choice(USER_AGENTS)}",
        "--lang=en-US,en;q=0.9",
    ]

    # GitHub Actions can run Chrome in a restricted/root-like sandbox environment.
    # nodriver 0.50.x uses sandbox=False, not no_sandbox=True.
    # Keeping --no-sandbox args too for compatibility.
    chrome_path = (
        os.getenv("CHROME_PATH")
        or shutil.which("google-chrome")
        or shutil.which("google-chrome-stable")
        or shutil.which("chromium")
        or shutil.which("chromium-browser")
    )

    start_kwargs = {
        "headless": HEADLESS,
        "browser_args": browser_args,
        "sandbox": False,
    }

    if chrome_path:
        start_kwargs["browser_executable_path"] = chrome_path

    try:
        return await uc.start(**start_kwargs)
    except TypeError:
        # Older nodriver builds may not accept browser_executable_path.
        start_kwargs.pop("browser_executable_path", None)
        return await uc.start(**start_kwargs)


async def close_browser(browser):
    if not browser:
        return
    try:
        await browser.stop()
    except Exception:
        try:
            browser.stop()
        except Exception:
            pass


async def warm_browser(browser):
    try:
        page = await browser.get("https://www.aliexpress.com/")
        await page.sleep(3)
        return page
    except Exception:
        return None


async def scroll_page(page):
    # Use native JS when available; fallback to nodriver scroll_down.
    for i in range(8):
        try:
            await page.evaluate(f"window.scrollTo(0, {900 + i * 750});")
        except Exception:
            try:
                await page.scroll_down(750)
            except Exception:
                pass
        await page.sleep(0.8 + random.random() * 0.7)
    try:
        await page.evaluate("window.scrollTo(0, 0);")
    except Exception:
        pass
    await page.sleep(1)


async def fetch_url(browser, url):
    page = await browser.get(url)
    await page.sleep(4 + random.random() * 2)
    await scroll_page(page)
    content = ""
    try:
        content = await page.get_content()
    except Exception:
        try:
            content = await page.evaluate("document.documentElement.outerHTML")
        except Exception:
            content = ""
    return content or ""


async def fetch_keyword_with_browser(browser, keyword):
    best_raw = []
    best_label = ""
    for query in query_variants(keyword):
        for url in make_urls(query, 1):
            try:
                content = await asyncio.wait_for(fetch_url(browser, url), timeout=max(20, SEARCH_TIMEOUT_MS / 1000))
                if is_blocked_text(content):
                    print(f"AliExpress blocked/security page for {query}")
                    continue
                raw = extract_dom_products(content, url)
                print(f"AliExpress raw extracted cards for {query}: {len(raw)}")
                if len(raw) > len(best_raw):
                    best_raw = raw
                    best_label = query
                if len(raw) >= MIN_PRODUCTS_PER_KEYWORD:
                    return query, raw
            except Exception as exc:
                print(f"AliExpress URL failed for {query}: {type(exc).__name__}: {exc}")
            await asyncio.sleep(max(0.5, DELAY_MS / 1000.0))
    return best_label or keyword, best_raw


async def main():
    try:
        import nodriver as uc
    except Exception as exc:
        print(f"Failed to import nodriver: {exc}")
        sys.exit(1)

    previous = read_json(OUTPUT_PATH, [])
    keywords = build_keyword_pool()
    print(f"AliExpress nodriver mode enabled")
    print(f"AliExpress keyword pool: {len(keywords)} searches")
    print(f"Target AliExpress products: {MAX_PRODUCTS}")

    products = []
    product_map = {}
    meta = {
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": "nodriver",
        "target": MAX_PRODUCTS,
        "keywordStats": [],
        "errors": [],
    }

    browser = None
    keywords_since_restart = 0
    try:
        browser = await start_browser(uc)
        await warm_browser(browser)

        for info in keywords:
            if len(products) >= MAX_PRODUCTS:
                break
            keyword = info["keyword"]
            print(f"AliExpress search: {keyword}")

            raw = []
            used_query = keyword
            for attempt in range(1, MAX_RETRIES + 1):
                if not browser or keywords_since_restart >= SESSION_KEYWORD_BATCH_SIZE or attempt > 1:
                    await close_browser(browser)
                    browser = await start_browser(uc)
                    await warm_browser(browser)
                    keywords_since_restart = 0

                used_query, raw = await fetch_keyword_with_browser(browser, keyword)
                if len(raw) >= MIN_PRODUCTS_PER_KEYWORD or len(raw) > 0 and attempt == MAX_RETRIES:
                    break
                print(f"AliExpress low/zero product count for {keyword}: {len(raw)}. Restarting session and retrying...")
                await asyncio.sleep(5 + attempt * 3)

            raw = dedupe_raw(raw)[:PRODUCTS_PER_KEYWORD]
            added = 0
            for idx, item in enumerate(raw, start=1):
                normalized = normalize_product(item, used_query or keyword, idx)
                if not normalized:
                    continue
                key = normalized["id"]
                if key in product_map:
                    continue
                product_map[key] = normalized
                products.append(normalized)
                added += 1
                if len(products) >= MAX_PRODUCTS:
                    break

            print(f"AliExpress {keyword}: {added} products")
            print(f"AliExpress unique collected: {len(products)}/{MAX_PRODUCTS}")
            meta["keywordStats"].append({"keyword": keyword, "usedQuery": used_query, "raw": len(raw), "added": added})
            keywords_since_restart += 1
            await asyncio.sleep(max(0.5, DELAY_MS / 1000.0))
    except Exception as exc:
        meta["errors"].append(str(exc))
        print(f"AliExpress fatal error: {type(exc).__name__}: {exc}")
    finally:
        await close_browser(browser)

    if not products and FALLBACK_CACHE and isinstance(previous, list) and previous:
        print(f"AliExpress using fallback cache: {len(previous)} products")
        products = previous[:MAX_PRODUCTS]
        meta["usedFallbackCache"] = True
    else:
        meta["usedFallbackCache"] = False

    # Rank source products. Higher sourceScore/visible orders first.
    products.sort(key=lambda p: (p.get("sourceScore", 0), p.get("orders", 0), -p.get("aliExpressRank", 999)), reverse=True)
    products = products[:MAX_PRODUCTS]

    write_json(OUTPUT_PATH, products)
    write_json(META_PATH, meta)
    write_json(KEYWORDS_PATH, keywords)
    print(f"Saved AliExpress products: {len(products)}")

    # Do not fail the whole workflow if AliExpress blocks; merge-source-products can fill from CJ/cache.
    if len(products) < max(30, min(200, MAX_PRODUCTS * 0.15)):
        print("AliExpress warning: low product count. GitHub Actions may be blocked/limited by AliExpress.")


if __name__ == "__main__":
    asyncio.run(main())
