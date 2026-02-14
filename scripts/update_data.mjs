import fs from "node:fs";
import path from "node:path";

const OUT_PATH = path.join(process.cwd(), "docs", "data", "latest.json");

const LOCALE = { name: "Vancouver, BC, Canada", currency: "CAD" };

const SERIES = {
  prime: "V80691311",
  mort5y: "V80691335",
  overnight: "V39079",
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJsonAtomic(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

async function fetchValetSeries(seriesId, { recent = 260 } = {}) {
  const url = `https://www.bankofcanada.ca/valet/observations/${seriesId}/json?recent=${recent}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "housing-metrics-watch/1.0 (GitHub Actions)" },
  });

  // fail loudly if network/API fails
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`BoC fetch failed for ${seriesId}: ${res.status} ${res.statusText}\n${text.slice(0, 200)}`);
  }

  const json = await res.json();

  const obs = json.observations ?? [];
  const points = obs
    .map((o) => {
      const v = o?.[seriesId]?.v;
      const num = v == null ? null : Number(v);
      return { date: o.d, value: Number.isFinite(num) ? num : null };
    })
    .filter((p) => p.value != null);

  return { seriesId, points, latest: points.at(-1) ?? null };
}

// Simple deterministic-ish PRNG for demo listings
function rand(seed) {
  let t = seed + 0x6d2b79f5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function zScores(values) {
  const n = values.length;
  if (n < 2) return values.map(() => 0);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance) || 1;
  return values.map((v) => (v - mean) / sd);
}

const NEIGHBORHOODS = [
  "Kitsilano","Mount Pleasant","Commercial Drive","Downtown","West End",
  "Fairview","Kerrisdale","Marpole","Renfrew-Collingwood","Hastings-Sunrise",
];

function generateListings(seed = Date.now()) {
  const r = rand(seed);
  const listings = [];

  for (let i = 0; i < 60; i++) {
    const beds = r() < 0.55 ? 1 : r() < 0.85 ? 2 : 3;
    const sqftBase = beds === 1 ? 550 : beds === 2 ? 850 : 1200;
    const sqft = Math.round(sqftBase * (0.8 + r() * 0.6));
    const neighborhood = NEIGHBORHOODS[Math.floor(r() * NEIGHBORHOODS.length)];

    const ppsfBase =
      (neighborhood === "Downtown" || neighborhood === "West End") ? 1200 :
      (neighborhood === "Kitsilano" || neighborhood === "Fairview") ? 1150 :
      (neighborhood === "Kerrisdale") ? 1100 : 950;

    let ppsf = ppsfBase * (0.85 + r() * 0.35);
    if (r() < 0.06) ppsf *= 0.78; // inject “good deal” outliers
    const price = Math.round((ppsf * sqft) / 1000) * 1000;

    listings.push({
      id: `van-${seed}-${i}`,
      neighborhood,
      beds,
      baths: beds === 1 ? 1 : (r() < 0.55 ? 1 : 2),
      sqft,
      price,
      dom: Math.floor(r() * 45),
      url: null,
    });
  }

  // z-score outliers per bed bucket on price/sqft
  const buckets = new Map();
  for (const l of listings) {
    const k = String(l.beds);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(l);
  }

  for (const [, arr] of buckets) {
    const ppsfArr = arr.map((l) => l.price / l.sqft);
    const zs = zScores(ppsfArr);
    arr.forEach((l, idx) => {
      l.pricePerSqft = Math.round((l.price / l.sqft) * 10) / 10;
      l.z = Math.round(zs[idx] * 100) / 100;
      l.dealScore = Math.max(0, Math.round((-zs[idx]) * 20));
    });
  }

  return listings.sort((a, b) => (b.dealScore ?? 0) - (a.dealScore ?? 0));
}

async function main() {
  console.log("OUT_PATH =", OUT_PATH);

  const now = new Date().toISOString();

  const [prime, mort5y, overnight] = await Promise.all([
    fetchValetSeries(SERIES.prime, { recent: 260 }),
    fetchValetSeries(SERIES.mort5y, { recent: 260 }),
    fetchValetSeries(SERIES.overnight, { recent: 520 }),
  ]);

  const out = {
    generatedAt: now,
    locale: LOCALE,
    rates: { prime, mort5y, overnight },
    listings: generateListings(),
    notes: {
      ratesSource: "Bank of Canada Valet API",
      listingsSource: "Synthetic demo listings (replace later)",
    },
  };

  writeJsonAtomic(OUT_PATH, out);

  const stat = fs.statSync(OUT_PATH);
  console.log(`Wrote latest.json (${stat.size} bytes) at ${now}`);
  console.log(`Prime latest:`, out.rates.prime.latest);
}

main().catch((e) => {
  console.error("FAILED:", e?.stack || e);
  process.exit(1);
});
