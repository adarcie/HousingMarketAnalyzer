function money(n, currency = "CAD") {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}
function pct(n) { return `${Number(n).toFixed(2)}%`; }

async function loadData() {
  // cache-bust so Pages doesn't serve an old JSON
  const res = await fetch(`./data/latest.json?v=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load data: ${res.status}`);
  return res.json();
}

function renderRates(data) {
  const el = document.getElementById("rates");
  el.innerHTML = "";

  const items = [
    { title: "Prime (posted)", s: data.rates.prime },
    { title: "5Y Conventional (posted)", s: data.rates.mort5y },
    { title: "Overnight target", s: data.rates.overnight },
  ];

  for (const it of items) {
    const latest = it.s.latest?.value ?? null;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="k">${it.title}</div>
      <div class="v">${latest == null ? "—" : pct(latest)}</div>
      <div class="small">Series: ${it.s.seriesId}</div>
    `;
    el.appendChild(card);
  }
}

function applyFiltersAndRenderTable(data) {
  const minScore = Number(document.getElementById("minScore").value);
  const maxDom = Number(document.getElementById("maxDom").value);

  document.getElementById("minScoreLabel").textContent = String(minScore);
  document.getElementById("maxDomLabel").textContent = String(maxDom);

  const rowsEl = document.getElementById("rows");
  rowsEl.innerHTML = "";

  const deals = (data.listings || []).filter(l => (l.dealScore ?? 0) >= minScore && l.dom <= maxDom);
  document.getElementById("count").textContent = String(deals.length);

  for (const l of deals) {
    const tr = document.createElement("tr");

    const nameCell = l.url
      ? `<a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.neighborhood}</a>`
      : `${l.neighborhood}`;

    tr.innerHTML = `
      <td>${nameCell}</td>
      <td>${l.beds}</td>
      <td>${l.sqft}</td>
      <td>${money(l.price, data.locale.currency)}</td>
      <td>${(l.pricePerSqft ?? 0).toFixed(1)}</td>
      <td>${(l.z ?? 0).toFixed(2)}</td>
      <td>${l.dom}</td>
      <td><b>${l.dealScore ?? 0}</b></td>
    `;
    rowsEl.appendChild(tr);
  }
}

function drawLineChart(canvas, seriesList, { yFormat = (v)=>String(v), title = "" } = {}) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  const allPoints = seriesList.flatMap(s => (s.points || []).map(p => p.value)).filter(v => Number.isFinite(v));
  if (allPoints.length < 2) {
    ctx.globalAlpha = 0.75;
    ctx.font = "16px system-ui";
    ctx.fillStyle = "white";
    ctx.fillText("No data yet", 16, 28);
    ctx.globalAlpha = 1;
    return;
  }

  const padL = 56, padR = 18, padT = 20, padB = 38;
  const minY = Math.min(...allPoints);
  const maxY = Math.max(...allPoints);
  const ySpan = (maxY - minY) || 1;

  const maxLen = Math.max(...seriesList.map(s => (s.points || []).length));
  const xToPx = (i) => padL + (i / (maxLen - 1)) * (W - padL - padR);
  const yToPx = (v) => padT + (1 - (v - minY) / ySpan) * (H - padT - padB);

  // axes
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = "white";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, H - padB);
  ctx.lineTo(W - padR, H - padB);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // y grid + labels
  ctx.font = "12px system-ui";
  ctx.fillStyle = "white";
  for (let t = 0; t <= 4; t++) {
    const v = minY + (ySpan * t) / 4;
    const y = yToPx(v);

    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();

    ctx.globalAlpha = 0.75;
    ctx.fillText(yFormat(v), 10, y + 4);
  }
  ctx.globalAlpha = 1;

  // lines (no custom colors; use opacity offsets)
  seriesList.forEach((s, idx) => {
    const pts = s.points || [];
    const offset = maxLen - pts.length;

    ctx.globalAlpha = 0.9 - idx * 0.2;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xToPx(i + offset);
      const y = yToPx(p.value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "white";
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  if (title) {
    ctx.globalAlpha = 0.85;
    ctx.font = "14px system-ui";
    ctx.fillStyle = "white";
    ctx.fillText(title, padL, 16);
    ctx.globalAlpha = 1;
  }
}

(async function main() {
  try {
    const data = await loadData();

    const meta = document.getElementById("meta");
    const ageMinutes = (Date.now() - new Date(data.generatedAt).getTime()) / 60000;

    meta.innerHTML = `Data refreshed: <b>${new Date(data.generatedAt).toLocaleString()}</b>` +
      (ageMinutes > 24 * 60 ? ` <span class="badge" style="margin-left:8px">stale data</span>` : "");

    renderRates(data);

    // Rates chart
    drawLineChart(
      document.getElementById("chartRates"),
      [
        { name: "Prime", points: (data.rates.prime.points || []).slice(-120) },
        { name: "5Y", points: (data.rates.mort5y.points || []).slice(-120) },
        { name: "Overnight", points: (data.rates.overnight.points || []).slice(-120) },
      ],
      { yFormat: (v) => pct(v), title: "Prime vs 5Y vs Overnight" }
    );

    // Home price chart (NHPI Vancouver)
    const home = data.homePrice?.nhpiVancouver;
    const homeNoteEl = document.getElementById("homeNote");

    if (home?.points?.length) {
      drawLineChart(
        document.getElementById("chartHome"),
        [{ name: "NHPI", points: home.points.slice(-120) }],
        { yFormat: (v) => String(v.toFixed(1)), title: "NHPI (Dec 2016 = 100)" }
      );
      homeNoteEl.textContent = home.note || "";
    } else {
      homeNoteEl.textContent = "Home price series not loaded yet (StatCan WDS).";
    }

    if (!data.listings || data.listings.length === 0) {
      document.getElementById("count").textContent = "0";
      document.getElementById("rows").innerHTML =
        `<tr><td colspan="8" style="opacity:.75;padding:16px 8px">
           No listings loaded. (This is okay if you haven’t wired a real feed yet.)<br/>
           To enable click-through, ensure each listing has a <code>url</code>.
         </td></tr>`;
      return;
    }

    applyFiltersAndRenderTable(data);

    document.getElementById("minScore").addEventListener("input", () => applyFiltersAndRenderTable(data));
    document.getElementById("maxDom").addEventListener("input", () => applyFiltersAndRenderTable(data));
  } catch (e) {
    document.getElementById("meta").textContent = `Error: ${e.message}`;
  }
})();
