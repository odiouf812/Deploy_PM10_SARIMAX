/* Souffle — logique du tableau de bord */
(() => {
  "use strict";

  // ------------------------------------------------------------------
  // Utilitaires
  // ------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const SID = (() => {
    let s = sessionStorage.getItem("souffle_sid");
    if (!s) {
      s = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
      sessionStorage.setItem("souffle_sid", s);
    }
    return s;
  })();

  const nf = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? "—"
    : Number(v).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, d = 0) => nf(v * 100, d) + " %";
  const fdate = (iso, opts = { day: "numeric", month: "long", year: "numeric" }) =>
    new Date(iso + "T00:00:00Z").toLocaleDateString("fr-FR", { ...opts, timeZone: "UTC" });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const CLASS_LABEL = { Faible: "Faible", Moderee: "Modérée", Elevee: "Élevée" };
  const ACTION_LABEL = {
    "Routine": "Routine",
    "Vigilance": "Vigilance",
    "Vigilance - exposition liee a l'effort": "Vigilance, exposition liée à l'effort",
    "Precaution renforcee": "Précaution renforcée",
  };
  const NIVEAU_LABEL = { 1: "Routine", 2: "Vigilance", 3: "Précaution renforcée" };
  const TERM_LABEL = {
    intercept: "Constante", TC: "Température (TC)", HR: "Humidité (HR)", sigma2: "Variance résiduelle (σ²)",
  };
  const termLabel = (n) => {
    if (TERM_LABEL[n]) return TERM_LABEL[n];
    let m;
    if ((m = n.match(/^ar\.L(\d+)$/))) return `AR(${m[1]})`;
    if ((m = n.match(/^ma\.L(\d+)$/))) return `MA(${m[1]})`;
    if ((m = n.match(/^ar\.S\.L(\d+)$/))) return `AR saisonnier (retard ${m[1]})`;
    if ((m = n.match(/^ma\.S\.L(\d+)$/))) return `MA saisonnier (retard ${m[1]})`;
    return n;
  };

  // ------------------------------------------------------------------
  // État
  // ------------------------------------------------------------------
  const KEYS = { 1: "data", 2: "model", 3: "forecast", 4: "sim", 5: "cls" };
  const RESULT_EL = { 1: "#dataResult", 2: "#modelResult", 3: "#forecastResult", 4: "#simResult", 5: "#classResult" };
  const state = { cfg: null, data: null, model: null, forecast: null, sim: null, cls: null, step: 1, day: null, seen5: false };
  const rendered = { 1: false, 2: false, 3: false, 4: false, 5: false };

  const completed = (n) => n === 5 ? (!!state.cls && state.seen5) : !!state[KEYS[n]];
  const accessible = (n) => n === 1 || (n === 5 ? !!state.cls : completed(n - 1));

  // ------------------------------------------------------------------
  // Réseau, attente, messages
  // ------------------------------------------------------------------
  async function api(path, { method = "GET", json, form } = {}) {
    const opts = { method, headers: { "X-Session-Id": SID } };
    if (json !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(json); }
    if (form) opts.body = form;
    let res;
    try { res = await fetch(path, opts); }
    catch { throw new Error("Le serveur ne répond pas. Vérifiez qu'il est toujours lancé."); }
    let body = null;
    try { body = await res.json(); } catch { /* corps vide */ }
    if (!res.ok) {
      let msg = body && body.detail;
      if (Array.isArray(msg)) msg = msg.map((e) => e.msg).join(" ; ");
      throw new Error(msg || `Erreur ${res.status}`);
    }
    return body;
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 8000);
  }
  const busy = (text) => { $("#busyText").textContent = text; $("#busy").hidden = false; };
  const unbusy = () => { $("#busy").hidden = true; };

  async function guarded(text, fn) {
    busy(text);
    try { return await fn(); }
    catch (e) { toast(e.message); return null; }
    finally { unbusy(); }
  }

  // ------------------------------------------------------------------
  // Navigation par étapes
  // ------------------------------------------------------------------
  function refreshStepper() {
    $$(".step").forEach((b) => {
      const n = +b.dataset.step;
      b.disabled = !accessible(n);
      b.classList.toggle("is-current", n === state.step);
      b.classList.toggle("is-done", completed(n));
      if (n === state.step) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
    });
  }

  function ensureRendered(n) {
    const el = $(RESULT_EL[n]);
    if (!state[KEYS[n]]) { el.hidden = true; return; }
    el.hidden = false;
    if (!rendered[n]) { RENDER[n](); rendered[n] = true; }
    else $$(".js-plotly-plot", $(`#panel${n}`)).forEach((g) => Plotly.Plots.resize(g));
  }

  function goto(n, scroll = true) {
    if (!accessible(n)) return;
    state.step = n;
    if (n === 5) state.seen5 = true;
    $$(".panel").forEach((p) => { p.hidden = +p.dataset.panel !== n; });
    ensureRendered(n);
    refreshStepper();
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Enregistre un résultat et invalide tout ce qui en dépend. */
  function setResult(n, value) {
    state[KEYS[n]] = value;
    rendered[n] = false;
    for (let m = n + 1; m <= 5; m++) {
      state[KEYS[m]] = null; rendered[m] = false; $(RESULT_EL[m]).hidden = true;
    }
    if (n < 5) state.seen5 = false;
    if (state.step === n) ensureRendered(n);
    refreshStepper();
  }

  // ------------------------------------------------------------------
  // Plotly : réglages communs
  // ------------------------------------------------------------------
  const FONT = { family: "Public Sans, Segoe UI, system-ui, sans-serif", size: 12.5, color: "#0D2B33" };
  const AXIS = { gridcolor: "#E3EAE9", linecolor: "#B7C6C4", zerolinecolor: "#CDD9D7", tickfont: { size: 12 } };
  const CONFIG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d", "toggleSpikelines"] };
  const baseLayout = (extra = {}) => ({
    font: FONT, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    margin: { l: 58, r: 20, t: 12, b: 42 },
    hoverlabel: { font: { family: FONT.family, size: 13 }, bgcolor: "#0D2B33", bordercolor: "#0D2B33", font_color: "#fff" },
    legend: { orientation: "h", y: 1.12, x: 0, font: { size: 12.5 } },
    ...extra,
  });
  const RANGE_BUTTONS = {
    buttons: [
      { count: 1, label: "1 mois", step: "month", stepmode: "backward" },
      { count: 3, label: "3 mois", step: "month", stepmode: "backward" },
      { count: 6, label: "6 mois", step: "month", stepmode: "backward" },
      { count: 1, label: "1 an", step: "year", stepmode: "backward" },
      { step: "all", label: "Tout" },
    ],
    font: { size: 12.5 }, bgcolor: "#EDF2F1", activecolor: "#71D3D0", x: 0, y: 1.0, yanchor: "bottom",
  };

  // ------------------------------------------------------------------
  // 1. Données
  // ------------------------------------------------------------------
  function renderData() {
    const { info, stats, series, preview } = state.data;
    $("#dsChip").hidden = false;
    $("#dsChipText").textContent = `${info.filename || "Données"} (${info.n_obs} jours)`;

    const sb = $("#sheetBar");
    if (info.sheets && info.sheets.length > 1) {
      sb.hidden = false;
      $("#sheetSelect").innerHTML = info.sheets.map((s) => `<option${s === info.sheet ? " selected" : ""}>${esc(s)}</option>`).join("");
    } else sb.hidden = true;

    $("#dataFacts").innerHTML = `
      <div><dt>Observations</dt><dd>${nf(info.n_obs, 0)}<small>jours</small></dd></div>
      <div><dt>Période couverte</dt><dd class="sm">${fdate(info.date_min, { day: "numeric", month: "short", year: "numeric" })}<br>au ${fdate(info.date_max, { day: "numeric", month: "short", year: "numeric" })}</dd></div>
      <div><dt>PM2.5 moyen</dt><dd>${nf(stats["PM2.5"].mean)}<small>µg/m³</small></dd></div>
      <div><dt>PM2.5 maximal</dt><dd>${nf(stats["PM2.5"].max)}<small>µg/m³</small></dd></div>
      <div><dt>Température moyenne</dt><dd>${nf(stats.TC.mean)}<small>°C</small></dd></div>
      <div><dt>Humidité moyenne</dt><dd>${nf(stats.HR.mean, 0)}<small>%</small></dd></div>`;

    const notes = [];
    if (info.n_interpolated > 0) notes.push(`${info.n_interpolated} valeur(s) manquante(s) sur ${info.n_gap_days} jour(s) absent(s) ou incomplet(s) ont été comblées par interpolation linéaire, comme dans le script R.`);
    if (info.n_bad_dates > 0) notes.push(`${info.n_bad_dates} ligne(s) ignorée(s) : date illisible.`);
    const nt = $("#dataNotice");
    nt.hidden = !notes.length; nt.textContent = notes.join(" ");

    const traces = [
      { x: series.dates, y: series["PM2.5"], name: "PM2.5 (µg/m³)", type: "scatter", mode: "lines", line: { color: "#0B6668", width: 1.6 }, xaxis: "x", yaxis: "y", hovertemplate: "%{y:.1f} µg/m³<extra>PM2.5</extra>" },
      { x: series.dates, y: series.TC, name: "TC (°C)", type: "scatter", mode: "lines", line: { color: "#6B5CA5", width: 1.4 }, xaxis: "x", yaxis: "y2", hovertemplate: "%{y:.1f} °C<extra>TC</extra>" },
      { x: series.dates, y: series.HR, name: "HR (%)", type: "scatter", mode: "lines", line: { color: "#3C7DC4", width: 1.4 }, xaxis: "x", yaxis: "y3", hovertemplate: "%{y:.0f} %<extra>HR</extra>" },
    ];
    const layout = baseLayout({
      margin: { l: 62, r: 16, t: 44, b: 36 },
      showlegend: false,
      xaxis: { ...AXIS, anchor: "y3", rangeselector: RANGE_BUTTONS, tickformat: "%d/%m/%y", hoverformat: "%d/%m/%Y" },
      yaxis: { ...AXIS, domain: [0.68, 1], title: { text: "PM2.5 (µg/m³)", font: { size: 12 } } },
      yaxis2: { ...AXIS, domain: [0.35, 0.62], title: { text: "TC (°C)", font: { size: 12 } } },
      yaxis3: { ...AXIS, domain: [0, 0.29], title: { text: "HR (%)", font: { size: 12 } } },
      hovermode: "x unified",
    });
    Plotly.react("chartSeries", traces, layout, CONFIG);

    const cols = ["Date", "TC", "HR", "PM2.5"];
    $("#previewTable").innerHTML = `<thead><tr>${cols.map((c, i) => `<th class="${i ? "num" : ""}">${c}</th>`).join("")}</tr></thead><tbody>${
      preview.map((r) => `<tr><td>${fdate(r.Date, { day: "2-digit", month: "2-digit", year: "numeric" })}</td><td class="num">${nf(r.TC)}</td><td class="num">${nf(r.HR)}</td><td class="num">${nf(r["PM2.5"])}</td></tr>`).join("")
    }</tbody>`;
  }

  function onDataLoaded(payload) {
    setResult(1, payload);
    goto(1, false);
  }

  async function uploadFile(file) {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    const payload = await guarded("Lecture du fichier", () => api("/api/upload", { method: "POST", form }));
    if (payload) onDataLoaded(payload);
  }

  function setupUpload() {
    const drop = $("#drop"), input = $("#fileInput");
    drop.addEventListener("click", (e) => { if (!e.target.closest("button")) input.click(); });
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", () => { uploadFile(input.files[0]); input.value = ""; });
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("is-over"); }));
    drop.addEventListener("drop", (e) => uploadFile(e.dataTransfer.files[0]));

    $("#btnSample").addEventListener("click", async () => {
      const payload = await guarded("Chargement de l'exemple", () => api("/api/upload-sample", { method: "POST" }));
      if (payload) onDataLoaded(payload);
    });
    $("#sheetSelect").addEventListener("change", async (e) => {
      const payload = await guarded("Lecture de la feuille", () => api("/api/data/sheet", { method: "POST", json: { sheet: e.target.value } }));
      if (payload) onDataLoaded(payload);
    });
    $("#btnReset").addEventListener("click", () => {
      Object.assign(state, { data: null, model: null, forecast: null, sim: null, cls: null, seen5: false });
      Object.keys(rendered).forEach((k) => { rendered[k] = false; });
      $$(".panel [id$='Result']").forEach((el) => { el.hidden = true; });
      $("#dsChip").hidden = true;
      goto(1);
    });
    $("#btnToModel").addEventListener("click", () => goto(2));
    $("#btnRunAll").addEventListener("click", runAll);
  }

  // ------------------------------------------------------------------
  // 2. Modèle
  // ------------------------------------------------------------------
  const fmtP = (p) => p === null || p === undefined ? "—" : (p < 0.001 ? "< 0,001" : nf(p, 3));

  function renderModel() {
    const { pm25: m, exog } = state.model;
    $("#modelName").textContent = m.label;
    $("#modelSub").textContent = `${m.n_tested} modèles comparés sur ${nf(m.nobs, 0)} observations. Le meilleur AICc est retenu.`;
    $("#modelMetrics").innerHTML = [
      ["AICc", nf(m.aicc, 1)], ["BIC", nf(m.bic, 1)], ["R²", nf(m.r2, 2)],
      ["RMSE", nf(m.rmse, 2) + " µg/m³"], ["MAE", nf(m.mae, 2) + " µg/m³"], ["Ljung-Box (p)", fmtP(m.ljung_box_p)],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");

    $("#coefTable").innerHTML = `<thead><tr><th>Terme</th><th class="num">Coefficient</th><th class="num">Erreur std</th><th class="num">z</th><th class="num">p</th><th>p &lt; 5 %</th></tr></thead><tbody>${
      m.coefficients.map((c) => `<tr><td>${esc(termLabel(c.name))}</td><td class="num">${nf(c.coef, 3)}</td><td class="num">${nf(c.se, 3)}</td><td class="num">${nf(c.z, 2)}</td><td class="num">${fmtP(c.p)}</td><td>${c.name === "sigma2" ? '<span class="muted">sans objet</span>' : (c.p < 0.05 ? '<span class="sig">Oui</span>' : '<span class="muted">Non</span>')}</td></tr>`).join("")
    }</tbody>`;

    const lb = m.ljung_box_p;
    $("#ljungNote").textContent = lb === null ? "" : (lb > 0.05
      ? `Test de Ljung-Box sur ${m.ljung_box_lag} retards : p = ${fmtP(lb)}. Aucune autocorrélation résiduelle détectée au seuil de 5 %.`
      : `Test de Ljung-Box sur ${m.ljung_box_lag} retards : p = ${fmtP(lb)}. Il reste de l'autocorrélation dans les résidus : les intervalles de prévision peuvent être trop étroits.`);

    $("#exogTable").innerHTML = `<thead><tr><th>Variable</th><th>Modèle retenu</th><th class="num">AICc</th></tr></thead><tbody>${
      exog.map((e) => `<tr><td>${e.name === "TC" ? "Température (TC)" : "Humidité (HR)"}</td><td class="wrap-cell">${esc(e.label)}</td><td class="num">${nf(e.aicc, 1)}</td></tr>`).join("")
    }</tbody>`;

    const last = m.dates.length - 1;
    const start = m.dates[Math.max(0, last - 179)];
    Plotly.react("chartFit", [
      { x: m.dates, y: m.observed, name: "Observé", mode: "lines", line: { color: "#0D2B33", width: 1.5 }, hovertemplate: "%{y:.1f}<extra>Observé</extra>" },
      { x: m.dates, y: m.fitted, name: "Ajusté", mode: "lines", line: { color: "#0F8B8D", width: 1.8 }, hovertemplate: "%{y:.1f}<extra>Ajusté</extra>" },
    ], baseLayout({
      margin: { l: 58, r: 16, t: 50, b: 40 },
      xaxis: { ...AXIS, rangeselector: RANGE_BUTTONS, range: [start, m.dates[last]], tickformat: "%d/%m/%y", hoverformat: "%d/%m/%Y" },
      yaxis: { ...AXIS, title: { text: "PM2.5 (µg/m³)", font: { size: 12 } } },
      legend: { orientation: "h", x: 1, xanchor: "right", y: 1.0, yanchor: "bottom" },
      hovermode: "x unified",
    }), CONFIG);

    const lags = m.acf.map((_, i) => i + 1);
    Plotly.react("chartAcf", [
      { x: lags, y: m.acf, type: "bar", marker: { color: m.acf.map((v) => Math.abs(v) > m.acf_conf ? "#B8324A" : "#0F8B8D") }, hovertemplate: "Retard %{x} : %{y:.3f}<extra></extra>" },
    ], baseLayout({
      showlegend: false,
      margin: { l: 58, r: 16, t: 10, b: 44 },
      xaxis: { ...AXIS, title: { text: "Retard (jours)", font: { size: 12 } }, dtick: 5 },
      yaxis: { ...AXIS, title: { text: "Autocorrélation", font: { size: 12 } }, range: [-0.4, 0.5] },
      shapes: [{ type: "rect", xref: "paper", x0: 0, x1: 1, yref: "y", y0: -m.acf_conf, y1: m.acf_conf, fillcolor: "rgba(13,43,51,.09)", line: { width: 0 }, layer: "below" }],
    }), CONFIG);
  }

  async function fitModel() {
    const res = await guarded("Ajustement des trois modèles, environ 20 secondes", () => api("/api/model", { method: "POST" }));
    if (res) setResult(2, res);
    return res;
  }

  // ------------------------------------------------------------------
  // 3. Prévisions
  // ------------------------------------------------------------------
  function renderForecast() {
    const f = state.forecast;
    $("#fcTiles").innerHTML = f.table.map((r, i) => {
      const x = f.exog[i];
      return `<article class="tile c-${r.Classification}">
        <div class="tile-head"><span class="tile-day">${r.Day}</span><span class="tile-date">${fdate(r.Date, { weekday: "long", day: "numeric", month: "long" })}</span></div>
        <div class="tile-value">${nf(r["PM2.5_forecast_mean"])}<small>µg/m³ de PM2.5</small></div>
        <div class="tile-class"><span class="chip chip-${r.Classification}">Concentration ${CLASS_LABEL[r.Classification].toLowerCase()}</span></div>
        <dl class="tile-rows">
          <div><dt>Intervalle à 95 %</dt><dd>${nf(r.CI_lower_95)} à ${nf(r.CI_upper_95)}</dd></div>
          <div><dt>P25, P50, P95</dt><dd>${nf(r.P25)}, ${nf(r.P50)}, ${nf(r.P95)}</dd></div>
          <div><dt>Température attendue</dt><dd>${nf(x.TC)} °C</dd></div>
          <div><dt>Humidité attendue</dt><dd>${nf(x.HR, 0)} %</dd></div>
        </dl>
      </article>`;
    }).join("");

    const hist = f.history, T = f.table;
    const dates = T.map((r) => r.Date);
    const means = T.map((r) => r["PM2.5_forecast_mean"]);
    const ymax = Math.max(30, ...T.map((r) => r.CI_upper_95), ...hist.pm25) * 1.12;
    const zone = (y0, y1, color) => ({ type: "rect", xref: "paper", x0: 0, x1: 1, yref: "y", y0, y1, fillcolor: color, line: { width: 0 }, layer: "below" });
    const zlabel = (y, text, color) => ({ xref: "paper", x: 0.004, xanchor: "left", yref: "y", y, yanchor: "middle", text, showarrow: false, font: { size: 12, color } });
    const traces = [
      { x: hist.dates, y: hist.pm25, name: "Historique", mode: "lines+markers", line: { color: "#0D2B33", width: 1.8 }, marker: { size: 4 }, hovertemplate: "%{y:.1f} µg/m³<extra>Observé</extra>" },
      { x: [f.last_observed.date, ...dates], y: [f.last_observed.pm25, ...means], name: "Trajectoire", mode: "lines", line: { color: "#0F8B8D", width: 2, dash: "dot" }, hoverinfo: "skip", showlegend: false },
      { x: dates, y: means, name: "IC à 95 %", showlegend: false, mode: "markers", marker: { size: 1, color: "rgba(0,0,0,0)" },
        error_y: { type: "data", symmetric: false, array: T.map((r) => r.CI_upper_95 - r["PM2.5_forecast_mean"]), arrayminus: T.map((r) => r["PM2.5_forecast_mean"] - r.CI_lower_95), color: "#3F5C66", thickness: 1.6, width: 9 }, hoverinfo: "skip" },
      { x: dates, y: means, name: "P25 à P95", showlegend: false, mode: "markers", marker: { size: 1, color: "rgba(0,0,0,0)" },
        error_y: { type: "data", symmetric: false, array: T.map((r) => r.P95 - r["PM2.5_forecast_mean"]), arrayminus: T.map((r) => r["PM2.5_forecast_mean"] - r.P25), color: "rgba(15,139,141,.55)", thickness: 9, width: 0 }, hoverinfo: "skip" },
      { x: dates, y: means, name: "Prévision", mode: "markers", marker: { size: 13, color: "#0F8B8D", line: { color: "#fff", width: 2.5 } },
        customdata: T.map((r) => [r.Day, r.CI_lower_95, r.CI_upper_95]),
        hovertemplate: "<b>%{customdata[0]}</b> : %{y:.1f} µg/m³<br>IC 95 % : %{customdata[1]:.1f} à %{customdata[2]:.1f}<extra></extra>" },
    ];
    const x0 = hist.dates[Math.max(0, hist.dates.length - 30)];
    const lastDate = new Date(dates[dates.length - 1] + "T00:00:00Z"); lastDate.setUTCDate(lastDate.getUTCDate() + 1);
    Plotly.react("chartForecast", traces, baseLayout({
      margin: { l: 58, r: 16, t: 44, b: 44 },
      xaxis: { ...AXIS, range: [x0, lastDate.toISOString().slice(0, 10)], tickformat: "%d/%m", hoverformat: "%d/%m/%Y" },
      yaxis: { ...AXIS, range: [0, ymax], title: { text: "PM2.5 (µg/m³)", font: { size: 12 } } },
      shapes: [zone(0, 15, "rgba(35,121,91,.10)"), zone(15, 25, "rgba(227,167,47,.16)"), zone(25, ymax, "rgba(184,50,74,.09)")],
      annotations: [zlabel(7.5, "Faible", "#23795B"), zlabel(20, "Modérée", "#8A5E08"), zlabel(Math.min(ymax - 4, 25 + (ymax - 25) / 2), "Élevée", "#B8324A")],
      legend: { orientation: "h", x: 0, y: 1.0, yanchor: "bottom", font: { size: 12.5 } },
    }), CONFIG);

    const cols = ["Jour", "Date", "Moyenne", "IC bas", "IC haut", "P25", "P50", "P95", "Classification"];
    $("#fcTable").innerHTML = `<thead><tr>${cols.map((c, i) => `<th class="${i > 1 && i < 8 ? "num" : ""}">${c}</th>`).join("")}</tr></thead><tbody>${
      T.map((r) => `<tr><td><b>${r.Day}</b></td><td>${fdate(r.Date, { day: "2-digit", month: "2-digit", year: "numeric" })}</td><td class="num">${nf(r["PM2.5_forecast_mean"], 2)}</td><td class="num">${nf(r.CI_lower_95, 2)}</td><td class="num">${nf(r.CI_upper_95, 2)}</td><td class="num">${nf(r.P25, 2)}</td><td class="num">${nf(r.P50, 2)}</td><td class="num">${nf(r.P95, 2)}</td><td><span class="chip chip-${r.Classification}">${CLASS_LABEL[r.Classification]}</span></td></tr>`).join("")
    }</tbody>`;
    $("#dlForecast").href = `/api/download/forecast?sid=${SID}`;
  }

  async function runForecast() {
    const res = await guarded("Calcul des prévisions", () => api("/api/forecast", { method: "POST" }));
    if (res) setResult(3, res);
    return res;
  }

  // ------------------------------------------------------------------
  // 4. Simulation Monte-Carlo
  // ------------------------------------------------------------------
  function renderParams() {
    const ev = state.cfg.events;
    const nfx = (v) => Number(v).toLocaleString("fr-FR", { maximumFractionDigits: 3 });
    const tri = (a) => `${nfx(a[0])} – <b>${nfx(a[1])}</b> – ${nfx(a[2])}`;
    $("#paramsTable").innerHTML = `<thead><tr><th>Épreuve</th><th>Ventilation (L/min)<br>min – mode – max</th><th>Durée (min)<br>min – mode – max</th></tr></thead><tbody>${
      Object.entries(ev).map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${tri(v.ventilation)}</td><td>${tri(v.duree)}</td></tr>`).join("")
    }</tbody>`;
  }

  function updateSimLabel() {
    const n = parseInt($("#nSim").value, 10);
    $("#btnSim").textContent = Number.isFinite(n) ? `Lancer les ${nf(n, 0)} simulations` : "Lancer la simulation";
  }

  function drawHistograms() {
    const sim = state.sim, thr = sim.dose_threshold;
    const list = sim.histograms.filter((h) => h.Day === state.day);
    $("#histGrid").innerHTML = list.map((h, i) => `
      <div class="hist"><div class="hist-head"><h3>${esc(h.Event)}</h3>
        <div class="hist-prob">Médiane <b>${nf(h.p50, 1)} mg</b>. Dose &gt; ${thr} mg dans <b>${pct(h.prob_above_threshold)}</b> des tirages.</div></div>
        <div class="plot" id="hist${i}"></div></div>`).join("");

    list.forEach((h, i) => {
      const e = h.edges, centers = h.counts.map((_, k) => (e[k] + e[k + 1]) / 2);
      const share = h.counts.map((c) => c / sim.n_sim * 100);
      const xmax = Math.max(e[e.length - 1] * 1.04, thr * 1.15);
      const ymax = Math.max(...share) * 1.12;
      const vline = (x, dash, color, width) => ({ type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1, line: { color, width, dash } });
      Plotly.react(`hist${i}`, [{
        type: "bar", x: centers, y: share, width: centers.map((_, k) => e[k + 1] - e[k]),
        marker: { color: centers.map((c) => c > thr ? "rgba(184,50,74,.75)" : "rgba(15,139,141,.8)"), line: { width: 0 } },
        customdata: centers.map((_, k) => [e[k], e[k + 1]]),
        hovertemplate: "%{customdata[0]:.1f} à %{customdata[1]:.1f} mg<br>%{y:.2f} % des tirages<extra></extra>",
      }], baseLayout({
        showlegend: false, bargap: 0,
        margin: { l: 46, r: 10, t: 6, b: 40 },
        xaxis: { ...AXIS, range: [0, xmax], title: { text: "Dose inhalée (mg)", font: { size: 11.5 } } },
        yaxis: { ...AXIS, range: [0, ymax], tickformat: ".0f", ticksuffix: " %", automargin: true },
        shapes: [vline(thr, "dash", "#B8324A", 2), vline(h.p25, "dot", "#0D2B33", 1.3), vline(h.p95, "dot", "#0D2B33", 1.3), vline(h.p50, "solid", "#0D2B33", 2.2)],
      }), CONFIG);
    });
  }

  function renderSim() {
    const days = [...new Set(state.sim.histograms.map((h) => h.Day))];
    if (!days.includes(state.day)) state.day = days[0];
    const seg = $("#daySeg");
    seg.innerHTML = days.map((d) => `<button role="tab" type="button" data-day="${d}" aria-selected="${d === state.day}">${d}</button>`).join("");
    $$("button", seg).forEach((b) => b.addEventListener("click", () => {
      state.day = b.dataset.day;
      $$("button", seg).forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      drawHistograms();
    }));
    drawHistograms();
  }

  async function runSimulation() {
    const n = parseInt($("#nSim").value, 10), seed = parseInt($("#seed").value, 10);
    if (!Number.isFinite(n) || n < 100 || n > 200000) { toast("Le nombre de simulations doit être compris entre 100 et 200 000."); return null; }
    if (!Number.isFinite(seed) || seed < 0) { toast("La graine doit être un entier positif ou nul."); return null; }
    const res = await guarded(`Simulation de ${nf(n, 0)} tirages par épreuve et par jour`, async () => {
      const sim = await api("/api/simulate", { method: "POST", json: { n_sim: n, seed } });
      const cls = await api("/api/classification");
      return { sim, cls };
    });
    if (!res) return null;
    setResult(4, res.sim);
    state.cls = res.cls; rendered[5] = false;
    refreshStepper();
    return res;
  }

  // ------------------------------------------------------------------
  // 5. Classification
  // ------------------------------------------------------------------
  function niceScale(rows, thr) {
    const top = Math.max(thr * 1.2, ...rows.map((r) => r.Dose_inhalee_P95_mg)) * 1.04;
    const step = top <= 40 ? 5 : top <= 90 ? 10 : 20;
    return { max: Math.ceil(top / step) * step, step };
  }

  function renderBoard() {
    const rows = state.cls.rows, thr = state.sim.dose_threshold;
    const { max, step } = niceScale(rows, thr);
    const x = (v) => Math.min(100, Math.max(0, v / max * 100));

    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += step) {
      if (Math.abs(v - thr) / max < 0.07) continue;
      ticks.push(`<span class="axis-tick" style="left:${x(v)}%">${v}</span>`);
    }
    ticks.push(`<span class="axis-tick axis-thr" style="left:${x(thr)}%">seuil ${thr} mg</span>`);
    const axis = `<div class="lane axis"><span></span><div class="lane-bar">${ticks.join("")}</div><span></span><span></span><span></span></div>`;

    const days = [...new Set(rows.map((r) => r.Day))];
    let idx = 0;
    $("#board").className = "board";
    $("#board").innerHTML = days.map((day) => {
      const fc = state.forecast.table.find((t) => t.Day === day);
      const lanes = rows.filter((r) => r.Day === day).map((r) => {
        const lo = x(r.Dose_inhalee_P25_mg), hi = x(r.Dose_inhalee_P95_mg), med = x(r.Dose_inhalee_P50_mg);
        const i = idx++;
        return `<div class="lane" style="--i:${i}">
          <div class="lane-name">${esc(r.Event)}</div>
          <div class="lane-bar" role="img" aria-label="${esc(r.Event)} : dose médiane ${nf(r.Dose_inhalee_P50_mg)} mg, de ${nf(r.Dose_inhalee_P25_mg)} à ${nf(r.Dose_inhalee_P95_mg)} mg">
            <span class="lane-thr" style="left:${x(thr)}%"></span>
            <span class="lane-range lvl-${r.Niveau_provisoire}" style="left:${lo}%;width:${Math.max(hi - lo, 1)}%"></span>
            <span class="lane-dot" style="left:${med}%"></span>
          </div>
          <div class="lane-dose"><b>${nf(r.Dose_inhalee_P50_mg)} mg</b><small>de ${nf(r.Dose_inhalee_P25_mg)} à ${nf(r.Dose_inhalee_P95_mg)}</small></div>
          <div class="lane-lvl"><span class="lvl lvl-${r.Niveau_provisoire}" title="Niveau ${r.Niveau_provisoire}">${r.Niveau_provisoire}</span></div>
          <div class="lane-action"><b>${esc(ACTION_LABEL[r.Action] || r.Action)}</b>
            <span class="conc">Concentration ${CLASS_LABEL[r["Classification_concentration_PM2.5"]].toLowerCase()}, dose ${CLASS_LABEL[r.Classification_dose_inhalee].toLowerCase()}</span></div>
        </div>`;
      }).join("");
      return `<section class="track" aria-label="Prévision ${day}">
        <div class="track-head"><h3>${day}</h3><span>${fc ? fdate(fc.Date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) + ", PM2.5 médian " + nf(fc.P50) + " µg/m³" : ""}</span></div>
        ${lanes}${axis}</section>`;
    }).join("");
    void $("#board").offsetWidth;
    $("#board").className = "board animate";
  }

  function renderClass() {
    const cfg = state.cfg, rows = state.cls.rows;
    $("#legend").innerHTML = `
      ${[1, 2, 3].map((n) => `<span class="legend-item"><span class="lvl lvl-${n}">${n}</span>${NIVEAU_LABEL[n]}</span>`).join("")}
      <span class="legend-item"><span class="legend-dot"></span>Dose médiane (P50)</span>
      <span class="legend-item">Segment : P25 à P95</span>`;
    renderBoard();

    const cols = ["Jour", "Épreuve", "PM2.5 (µg/m³)\nP25 / P50 / P95", "Concentration", "Dose inhalée (mg)\nP25 / P50 / P95", "Dose", "Niveau", "Action", `Dose > ${state.sim.dose_threshold} mg`];
    const numCols = new Set([2, 4, 8]);
    const trio = (a, b, c, d) => `${nf(a, d)} / ${nf(b, d)} / ${nf(c, d)}`;
    $("#classTable").innerHTML = `<thead><tr>${cols.map((c, i) => `<th class="${numCols.has(i) ? "num" : ""}">${c.replace("\n", "<br>")}</th>`).join("")}</tr></thead><tbody>${
      rows.map((r) => `<tr>
        <td><b>${r.Day}</b></td><td>${esc(r.Event)}</td>
        <td class="num">${trio(r["PM2.5_P25"], r["PM2.5_P50"], r["PM2.5_P95"], 2)}</td>
        <td><span class="chip chip-${r["Classification_concentration_PM2.5"]}">${CLASS_LABEL[r["Classification_concentration_PM2.5"]]}</span></td>
        <td class="num">${trio(r.Dose_inhalee_P25_mg, r.Dose_inhalee_P50_mg, r.Dose_inhalee_P95_mg, 2)}</td>
        <td><span class="chip chip-${r.Classification_dose_inhalee}">${CLASS_LABEL[r.Classification_dose_inhalee]}</span></td>
        <td><span class="lvl lvl-${r.Niveau_provisoire}">${r.Niveau_provisoire}</span></td>
        <td class="wrap-cell">${esc(ACTION_LABEL[r.Action] || r.Action)}</td>
        <td class="num">${pct(r.Prob_dose_sup_seuil)}</td></tr>`).join("")
    }</tbody>`;

    const cell = (conc, dose) => {
      const m = cfg.matrix.find((e) => e.conc === conc && e.dose === dose);
      return `<td><div class="cell-lvl"><span class="lvl lvl-${m.niveau}">${m.niveau}</span><span>${esc(ACTION_LABEL[m.action] || m.action)}</span></div></td>`;
    };
    $("#matrixTable").innerHTML = `<thead><tr><th>Concentration de PM2.5 (P50)</th><th>Dose faible (≤ ${cfg.dose_threshold} mg)</th><th>Dose élevée (&gt; ${cfg.dose_threshold} mg)</th></tr></thead><tbody>
      <tr><td><span class="chip chip-Faible">Faible</span> &nbsp;≤ ${cfg.conc_thresholds.faible_max} µg/m³</td>${cell("Faible", "Faible")}${cell("Faible", "Elevee")}</tr>
      <tr><td><span class="chip chip-Moderee">Modérée</span> &nbsp;jusqu'à ${cfg.conc_thresholds.moderee_max} µg/m³</td>${cell("Moderee", "Faible")}${cell("Moderee", "Elevee")}</tr>
      <tr><td><span class="chip chip-Elevee">Élevée</span> &nbsp;&gt; ${cfg.conc_thresholds.moderee_max} µg/m³</td>${cell("Elevee", "Faible")}${cell("Elevee", "Elevee")}</tr></tbody>`;

    $("#dlAll").href = `/api/download/all?sid=${SID}`;
    $("#dlXlsx").href = `/api/download/xlsx?sid=${SID}`;
    $("#dlClass").href = `/api/download/classification?sid=${SID}`;
    $("#dlForecast2").href = `/api/download/forecast?sid=${SID}`;
  }

  // ------------------------------------------------------------------
  // Exécution complète
  // ------------------------------------------------------------------
  async function runAll() {
    if (!(await fitModel())) return;
    if (!(await runForecast())) return;
    if (!(await runSimulation())) return;
    goto(5);
  }

  // ------------------------------------------------------------------
  // Démarrage
  // ------------------------------------------------------------------
  const RENDER = { 1: renderData, 2: renderModel, 3: renderForecast, 4: renderSim, 5: renderClass };

  async function init() {
    setupUpload();
    $$(".step").forEach((b) => b.addEventListener("click", () => goto(+b.dataset.step)));

    $("#btnModel").addEventListener("click", async () => { if (await fitModel()) $("#modelResult").scrollIntoView({ behavior: "smooth", block: "start" }); });
    $("#btnToForecast").addEventListener("click", () => goto(3));
    $("#btnForecast").addEventListener("click", async () => { if (await runForecast()) $("#forecastResult").scrollIntoView({ behavior: "smooth", block: "start" }); });
    $("#btnToSim").addEventListener("click", () => goto(4));
    $("#btnSim").addEventListener("click", async () => { if (await runSimulation()) $("#simResult").scrollIntoView({ behavior: "smooth", block: "start" }); });
    $("#btnToClass").addEventListener("click", () => goto(5));
    $("#nSim").addEventListener("input", updateSimLabel);

    try {
      state.cfg = await api("/api/config");
      $("#nSim").value = state.cfg.defaults.n_sim;
      $("#seed").value = state.cfg.defaults.seed;
      $("#btnSample").hidden = !state.cfg.sample_available;
      renderParams();
      updateSimLabel();
    } catch (e) { toast(e.message); }

    $("#runAllHint").textContent = "Enchaîne modèle, prévisions, simulation et classification avec les réglages par défaut.";
    goto(1, false);
  }

  window.addEventListener("resize", () => { $$(".panel:not([hidden]) .js-plotly-plot").forEach((g) => Plotly.Plots.resize(g)); });
  document.addEventListener("DOMContentLoaded", init);
})();
