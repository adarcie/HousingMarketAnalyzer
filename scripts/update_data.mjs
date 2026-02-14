// scripts/update_data.mjs
// Generates docs/data/latest.json for GitHub Pages
// - Bank of Canada rates via Valet API
// - Vancouver NHPI (New Housing Price Index) via StatCan WDS (best-effort; won’t fail the whole run)
// - Demo listings with outlier/deal scoring (replace later with real listings + url)

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

/** -------------------- Bank of Canada (Valet API) -------------------- **/
async function fetchValetSeries(seriesId, { recent = 260 } = {}) {
  const url = `https://www.bankofcanada.ca/valet/observations/${seriesId}/json?recent=${recent}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "housing-metrics-watch/1.0 (GitHub Actions)" },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `BoC fetch failed for ${seriesId}: ${res.status} ${res.statusText}\n${text.slice(0, 200)}`
    );
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

/** -------------------- StatCan WDS (NHPI) -------------------- **/
async function statcanPost(method, bodyObj) {
  const url = `https://www150.statcan.gc.ca/t1/wds/rest/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `StatCan ${method} failed: ${res.status} ${res.statusText}\n${text.slice(0, 300)}`
    );
  }
  return res.json();
}

function pickMember(dim, wantSubstrings) {
  const members = dim?.member || [];
  const lower = wantSubstrings.map((s) => s.toLowerCase());
  return members.find((m) =>
    lower.every((s) => (m.memberNameEn || "").toLowerCase().includes(s))
  );
}

function pickTotalish(dim) {
  if (!dim) return null;
  return (
    pickMember(dim, ["total"]) ||
    pickMember(dim, ["all"]) ||
    pickMember(dim, ["all", "items"]) ||
    dim.member?.[0] ||
    null
  );
}

// Best-effort NHPI Vancouver (CMA). If it fails, returns null (and workflow continues).
async function fetchVancouverNHPI({ months = 180 } = {}) {
  const productId = 18100205; // table 18-10-0205-01 cube id commonly used by WDS

  const metaArr = await statcanPost("getCubeMetadata", [{ productId }]);
  const meta = metaArr?.[0]?.object;
  if (!meta?.dimension) throw new Error("StatCan cube metadata missing dimensions");

  const dims = meta.dimension;

  const geoDim = dims.find((d) =>
    (d.dimensionNameEn || "").toLowerCase().includes("geography")
  );
  if (!geoDim) throw new Error("Could not find Geography dimension in NHPI metadata");

  // Geography: pick Vancouver (CMA). If there are multiple “Vancouver …”, take the first that includes vancouver.
  const geoMember = pickMember(geoDim, ["vancouver"]);
  if (!geoMember) throw new Error("Could not find 'Vancouver' in Geography members");

  // Safer per-dimension member selection. The earlier “invalid coordinate” came from
  // selecting a combination StatCan doesn’t allow; we bias to “total/all” and pad coordinate.
  function pickForDim(dim) {
    const name = (dim.dimensionNameEn || "").toLowerCase();

    if (dim === geoDim) return geoMember;

    // For “component” dims, prefer total
    if (name.includes("component")) {
      return (
        pickMember(dim, ["total"]) ||
        pickMember(dim, ["all"]) ||
        dim.member?.[0] ||
        null
      );
    }

    // For dwelling type, prefer total
    if (name.includes("dwelling") && name.includes("type")) {
      return pickTotalish(dim);
    }

    // For measure/index dims, prefer the index itself or total
    return (
      pickMember(dim, ["new housing price index"]) ||
      pickTotalish(dim)
    );
  }

  const membersByDim = dims.map(pickForDim);
  if (membersByDim.some((m) => !m)) {
    throw new Error("Could not select members for all NHPI dimensions");
  }

  // Coordinate: dot-separated memberIds in dim order.
  // WDS examples commonly pad with trailing zeros to 10 positions.
  const parts = membersByDim.map((m) => String(m.memberId));
  while (parts.length < 10) parts.push("0");
  const coordinate = parts.join(".");

  // Helpful debug line (shows in Action logs)
  console.log("NHPI coordinate =", coordinate);

  const dataArr = await statcanPost("getDataFromCubePidCoordAndLatestNPeriods", [
    { productId, coordinate, latestN: months },
  ]);

  const obj = dataArr?.[0]?.object;
  const pointsRaw = obj?.vectorDataPoint || [];
  const points = pointsRaw
    .map((dp) => ({ date: (dp.refPer || "").slice(0, 10), value: Number(dp.value) }))
    .filter((p) => p.date && Number.isFinite(p.value));

  if (!points.length) {
    throw new Error("NHPI returned 0 points (coordinate may still be invalid)");
  }

  return {
    productId,
    coordinate,
    points,
    latest: points.at(-1) || null,
    note: "New Housing Price Index (Dec 2016=100), Vancouver (CMA), via StatCan WDS (table 18-10-0205-01).",
  };
}

/** -------------------- Demo listings + outlier scoring -------------------- **/
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
  "Kitsilano",
  "Mount Pleasant",
  "Commercial Drive",
  "Downtown",
  "West End",
  "Fairview",
  "Kerrisdale",
  "Marpole",
  "Renfrew-Collingwood",
  "Hastings-Sunrise",
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
      neighborhood === "Downtown" || neighborhood === "West End"
        ? 1200
        : neighborhood === "Kitsilano" || neighborhood === "Fairview"
          ? 1150
          : neighborhood === "Kerrisdale"
            ? 1100
            : 950;

    let ppsf = ppsfBase * (0.85 + r() * 0.35);
    if (r() < 0.06) ppsf *= 0.78; // inject a few “good deals”
    const price = Math.round((ppsf * sqft) / 1000) * 1000;

    listings.push({
      id: `van-${seed}-${i}`,
      neighborhood,
      beds,
      baths: beds === 1 ? 1 : r() < 0.55 ? 1 : 2,
      sqft,
      price,
      dom: Math.floor(r() * 45),
      url: null, // <- replace with real posting URL later
    });
  }

  // outliers per bed bucket using price/sqft z-score
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

/** -------------------- Main -------------------- **/
async function main() {
  console.log("OUT_PATH =", OUT_PATH);

  const now = new Date().toISOString();

  // Fetch rates (hard fail if these fail)
  const [prime, mort5y, overnight] = await Promise.all([
    fetchValetSeries(SERIES.prime, { recent: 260 }),
    fetchValetSeries(SERIES.mort5y, { recent: 260 }),
    fetchValetSeries(SERIES.overnight, { recent: 520 }),
  ]);

  // Fetch NHPI (best-effort; don't fail the whole run)
  let nhpiVancouver = null;
  try {
    nhpiVancouver = await fetchVancouverNHPI({ months: 180 });
  } catch (e) {
    console.log("NHPI fetch failed (continuing):", e?.message || e);
  }

  const out = {
    generatedAt: now,
    locale: LOCALE,
    rates: { prime, mort5y, overnight },
    homePrice: { nhpiVancouver },
    listings: generateListings(),
    notes: {
      ratesSource: "Bank of Canada Valet API",
      homePriceSource: "StatCan WDS (NHPI table 18-10-0205-01) — best effort",
      listingsSource: "Synthetic demo listings (replace with real feed + urls)",
    },
  };

  writeJsonAtomic(OUT_PATH, out);

  const stat = fs.statSync(OUT_PATH);
  console.log(`Wrote latest.json (${stat.size} bytes) at ${now}`);
  console.log("Prime latest:", out.rates.prime.latest);
  console.log("NHPI latest:", out.homePrice.nhpiVancouver?.latest ?? null);
}

main().catch((e) => {
  console.error("FAILED:", e?.stack || e);
  process.exit(1);
});
