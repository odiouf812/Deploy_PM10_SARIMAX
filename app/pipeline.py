"""Équivalent Python du script R `sarimax_pm25_forecast_classification.R`.

R (forecast::auto.arima)            ->  Python (statsmodels SARIMAX + recherche stepwise)
- choix de d : test KPSS            ->  idem (statsmodels.tsa.stattools.kpss)
- choix de D : force saisonnière    ->  idem (STL, seuil 0.64)
- sélection (p,q,P,Q) : AICc        ->  recherche pas-à-pas de Hyndman-Khandakar
- régression + erreurs ARIMA (xreg) ->  SARIMAX(exog=...)
"""
from __future__ import annotations

import io
import re
import unicodedata
import warnings
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd
from scipy.stats import norm
from statsmodels.stats.diagnostic import acorr_ljungbox
from statsmodels.tsa.seasonal import STL
from statsmodels.tsa.statespace.sarimax import SARIMAX
from statsmodels.tsa.stattools import acf, kpss

from . import config as C

warnings.filterwarnings("ignore")


# ---------------------------------------------------------------------------
# 1. Chargement des données
# ---------------------------------------------------------------------------
class DataError(ValueError):
    """Erreur de données lisible par l'utilisateur."""


_ALIASES = {
    "date": {"date", "jour", "day", "datetime", "time"},
    "TC": {"tc", "temp", "temperature", "temperaturec", "t"},
    "HR": {"hr", "rh", "humidite", "humidity", "humiditerelative"},
    "PM2.5": {"pm25", "pm2_5", "pm", "pm25ugm3"},
}


def _norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _map_columns(columns) -> dict:
    mapping = {}
    for col in columns:
        n = _norm(col)
        for target, aliases in _ALIASES.items():
            if target not in mapping.values() and n in {_norm(a) for a in aliases}:
                mapping[col] = target
                break
    return mapping


def list_sheets(raw: bytes, filename: str) -> list[str]:
    if filename.lower().endswith((".csv", ".txt")):
        return []
    try:
        return pd.ExcelFile(io.BytesIO(raw)).sheet_names
    except Exception as exc:  # noqa: BLE001
        raise DataError(f"Fichier Excel illisible : {exc}") from exc


def load_data(raw: bytes, filename: str, sheet: Optional[str] = None):
    """Retourne (DataFrame[Date,TC,HR,PM2.5], infos)."""
    is_csv = filename.lower().endswith((".csv", ".txt"))
    sheets = list_sheets(raw, filename)
    try:
        if is_csv:
            df = pd.read_csv(io.BytesIO(raw), sep=None, engine="python")
            used_sheet = None
        else:
            used_sheet = sheet or (C.SHEET_NAME_DEFAULT if C.SHEET_NAME_DEFAULT in sheets else sheets[0])
            df = pd.read_excel(io.BytesIO(raw), sheet_name=used_sheet)
    except DataError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise DataError(f"Impossible de lire le fichier : {exc}") from exc

    mapping = _map_columns(df.columns)
    missing = [c for c in ("date", "TC", "HR", "PM2.5") if c not in mapping.values()]
    if missing:
        raise DataError(
            "Colonnes introuvables : " + ", ".join(missing)
            + ". Colonnes détectées : " + ", ".join(map(str, df.columns))
            + ". Le fichier doit contenir Date, TC, HR et PM2.5."
        )
    df = df.rename(columns=mapping)[["date", "TC", "HR", "PM2.5"]].rename(columns={"date": "Date"})

    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    n_bad_dates = int(df["Date"].isna().sum())
    df = df.dropna(subset=["Date"])
    for col in ("TC", "HR", "PM2.5"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df["Date"] = df["Date"].dt.normalize()
    df = df.groupby("Date", as_index=False)[["TC", "HR", "PM2.5"]].mean().sort_values("Date")
    if len(df) < 30:
        raise DataError(f"Seulement {len(df)} jours exploitables : il en faut au moins 30 pour ajuster un modèle.")

    full = pd.date_range(df["Date"].min(), df["Date"].max(), freq="D")
    n_gap_days = len(full) - len(df)
    df = df.set_index("Date").reindex(full)
    n_missing_values = int(df.isna().sum().sum())
    df = df.interpolate(method="linear", limit_direction="both")
    df.index.name = "Date"
    df = df.reset_index()

    info = {
        "sheets": sheets,
        "sheet": used_sheet,
        "n_obs": int(len(df)),
        "date_min": df["Date"].min().strftime("%Y-%m-%d"),
        "date_max": df["Date"].max().strftime("%Y-%m-%d"),
        "n_gap_days": int(n_gap_days),
        "n_interpolated": n_missing_values,
        "n_bad_dates": n_bad_dates,
        "columns_detected": {str(k): v for k, v in mapping.items()},
    }
    return df, info


# ---------------------------------------------------------------------------
# 2. auto.arima (équivalent Python)
# ---------------------------------------------------------------------------
def _ndiffs(x: np.ndarray, max_d: int = 2) -> int:
    d = 0
    while d < max_d:
        try:
            _, p, _, _ = kpss(x, regression="c", nlags="auto")
        except Exception:  # noqa: BLE001
            break
        if p >= 0.05:
            break
        x = np.diff(x)
        d += 1
    return d


def _nsdiffs(x: np.ndarray, m: int) -> int:
    if m <= 1 or len(x) < 2 * m + 2:
        return 0
    try:
        stl = STL(x, period=m, seasonal=len(x) | 1, robust=False).fit()
        rem, seas = stl.resid, stl.seasonal
        fs = max(0.0, min(1.0, 1 - np.var(rem) / np.var(rem + seas)))
        return 1 if fs > 0.64 else 0
    except Exception:  # noqa: BLE001
        return 0


@dataclass
class ArimaFit:
    result: object
    order: tuple
    seasonal_order: tuple
    const: bool
    exog_names: list = field(default_factory=list)
    n_tested: int = 0

    @property
    def label(self) -> str:
        p, d, q = self.order
        s = f"ARIMA({p},{d},{q})"
        P, D, Q, m = self.seasonal_order
        if m > 1:
            s += f"({P},{D},{Q})[{m}]"
        if self.const:
            s += " avec constante"
        if self.exog_names:
            s += " + " + ", ".join(self.exog_names) + " (régresseurs)"
        return s

    @property
    def skip(self) -> int:
        """Nombre d'observations initiales non fiables (différenciation)."""
        return self.order[1] + self.seasonal_order[1] * max(self.seasonal_order[3], 1)


def auto_arima(y, exog=None, m: int = 1, seasonal: bool = False, max_fits: int = 60) -> ArimaFit:
    """Recherche pas-à-pas de Hyndman-Khandakar, critère AICc."""
    y = np.asarray(y, dtype=float)
    X = None if exog is None else pd.DataFrame(exog).astype(float).reset_index(drop=True)
    exog_names = [] if X is None else list(X.columns)

    # d et D testés sur y (résidus de la régression si régresseurs, comme auto.arima)
    base = y
    if X is not None:
        A = np.column_stack([np.ones(len(y)), X.values])
        beta, *_ = np.linalg.lstsq(A, y, rcond=None)
        base = y - A @ beta
    D = _nsdiffs(base, m) if seasonal else 0
    x_d = base
    if D:
        x_d = base[m:] - base[:-m]
    d = _ndiffs(x_d)
    use_seasonal = seasonal and m > 1

    cache: dict = {}

    def fit(p, q, P, Q, const):
        key = (p, q, P, Q, const)
        if key in cache:
            return cache[key]
        try:
            mod = SARIMAX(
                y, exog=X, order=(p, d, q),
                seasonal_order=(P, D, Q, m) if use_seasonal else (0, 0, 0, 0),
                trend="c" if const else None,
            )
            res = mod.fit(disp=False, maxiter=200)
            aicc = float(res.aicc)
            if not np.isfinite(aicc) or res.llf == 0.0:
                raise ValueError("ajustement dégénéré")
            # comme auto.arima : rejet des modèles dont les racines AR/MA sont
            # trop proches du cercle unité (< 1,01)
            for roots in (res.arroots, res.maroots):
                if len(roots) and np.min(np.abs(roots)) < 1.01:
                    raise ValueError("racines trop proches du cercle unité")
        except Exception:  # noqa: BLE001
            cache[key] = (np.inf, None)
            return cache[key]
        cache[key] = (aicc, res)
        return cache[key]

    allow_const = (d + D) == 0
    maxp, maxq, maxP, maxQ, max_order = 5, 5, 2, 2, 5
    starts = [(2, 2, 1, 1), (0, 0, 0, 0), (1, 0, 1, 0), (0, 1, 0, 1)]
    if not use_seasonal:
        starts = [(p, q, 0, 0) for p, q, *_ in starts]
    best_key, best_aicc = None, np.inf
    for p, q, P, Q in starts:
        if len(cache) >= max_fits:
            break
        aicc, _ = fit(p, q, P, Q, allow_const)
        if aicc < best_aicc:
            best_aicc, best_key = aicc, (p, q, P, Q, allow_const)
    if allow_const and best_key is not None:  # variante sans constante
        p, q, P, Q, _ = best_key
        aicc, _ = fit(p, q, P, Q, False)
        if aicc < best_aicc:
            best_aicc, best_key = aicc, (p, q, P, Q, False)
    if best_key is None:
        raise DataError("Aucun modèle ARIMA n'a convergé sur cette série.")

    improved = True
    while improved and len(cache) < max_fits:
        improved = False
        p, q, P, Q, const = best_key
        cands = []
        for dp, dq in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)]:
            cands.append((p + dp, q + dq, P, Q, const))
        if use_seasonal:
            for dP, dQ in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)]:
                cands.append((p, q, P + dP, Q + dQ, const))
        if allow_const:
            cands.append((p, q, P, Q, not const))
        for cp, cq, cP, cQ, cc in cands:
            if not (0 <= cp <= maxp and 0 <= cq <= maxq and 0 <= cP <= maxP and 0 <= cQ <= maxQ):
                continue
            if cp + cq + cP + cQ > max_order:
                continue
            if len(cache) >= max_fits:
                break
            aicc, _ = fit(cp, cq, cP, cQ, cc)
            if aicc < best_aicc - 1e-6:
                best_aicc, best_key, improved = aicc, (cp, cq, cP, cQ, cc), True
                break

    p, q, P, Q, const = best_key
    return ArimaFit(
        result=cache[best_key][1],
        order=(p, d, q),
        seasonal_order=(P, D, Q, m) if use_seasonal else (0, 0, 0, 0),
        const=const,
        exog_names=exog_names,
        n_tested=len([v for v in cache.values() if np.isfinite(v[0])]),
    )


# ---------------------------------------------------------------------------
# 3. Modèles exogènes + PM2.5
# ---------------------------------------------------------------------------
def fit_all_models(df: pd.DataFrame) -> dict:
    """TC (saisonnier), HR (saisonnier), puis PM2.5 ~ TC + HR."""
    tc_fit = auto_arima(df["TC"].values, m=C.SEASONAL_PERIOD, seasonal=True)
    hr_fit = auto_arima(df["HR"].values, m=C.SEASONAL_PERIOD, seasonal=True)
    pm_fit = auto_arima(df["PM2.5"].values, exog=df[["TC", "HR"]], seasonal=False)
    return {"TC": tc_fit, "HR": hr_fit, "PM2.5": pm_fit}


def model_summary(fit: ArimaFit, df: pd.DataFrame) -> dict:
    res = fit.result
    skip = max(fit.skip, 1)
    y = df["PM2.5"].values
    fitted = np.asarray(res.fittedvalues)
    resid = np.asarray(res.resid)
    dates = df["Date"].dt.strftime("%Y-%m-%d").tolist()

    resid_ok = resid[skip:]
    nlags = 30
    ac = acf(resid_ok, nlags=nlags, fft=True)[1:]
    conf = 1.96 / np.sqrt(len(resid_ok))
    lb_lag = int(min(10, max(len(resid_ok) // 5, 1)))
    n_arma = fit.order[0] + fit.order[2]
    try:
        lb = acorr_ljungbox(resid_ok, lags=[lb_lag], model_df=min(n_arma, lb_lag - 1))
        lb_p = float(lb["lb_pvalue"].iloc[0])
    except Exception:  # noqa: BLE001
        lb_p = None

    names = list(res.model.param_names)
    params = np.asarray(res.params)
    bse = np.asarray(res.bse)
    pv = np.asarray(res.pvalues)
    coefs = [
        {"name": n, "coef": float(c), "se": float(s), "z": float(c / s) if s else None, "p": float(p)}
        for n, c, s, p in zip(names, params, bse, pv)
    ]
    rmse = float(np.sqrt(np.mean((y[skip:] - fitted[skip:]) ** 2)))
    mae = float(np.mean(np.abs(y[skip:] - fitted[skip:])))
    ss_res = np.sum((y[skip:] - fitted[skip:]) ** 2)
    ss_tot = np.sum((y[skip:] - y[skip:].mean()) ** 2)
    return {
        "label": fit.label,
        "order": list(fit.order),
        "n_tested": fit.n_tested,
        "aicc": float(res.aicc),
        "aic": float(res.aic),
        "bic": float(res.bic),
        "loglik": float(res.llf),
        "nobs": int(res.nobs),
        "rmse": rmse,
        "mae": mae,
        "r2": float(1 - ss_res / ss_tot) if ss_tot else None,
        "ljung_box_lag": lb_lag,
        "ljung_box_p": lb_p,
        "coefficients": coefs,
        "dates": dates[skip:],
        "observed": np.round(y[skip:], 3).tolist(),
        "fitted": np.round(fitted[skip:], 3).tolist(),
        "residuals": np.round(resid_ok, 3).tolist(),
        "acf": np.round(ac, 4).tolist(),
        "acf_conf": float(conf),
    }


def exog_model_info(name: str, fit: ArimaFit) -> dict:
    return {"name": name, "label": fit.label, "aicc": float(fit.result.aicc), "n_tested": fit.n_tested}


# ---------------------------------------------------------------------------
# 4. Prévisions
# ---------------------------------------------------------------------------
def forecast_all(fits: dict, df: pd.DataFrame) -> dict:
    h = C.FORECAST_HORIZON
    tc = np.asarray(fits["TC"].result.get_forecast(steps=h).predicted_mean)
    hr = np.asarray(fits["HR"].result.get_forecast(steps=h).predicted_mean)
    future_dates = pd.date_range(df["Date"].max() + pd.Timedelta(days=1), periods=h, freq="D")
    xreg = pd.DataFrame({"TC": tc, "HR": hr})

    fc = fits["PM2.5"].result.get_forecast(steps=h, exog=xreg)
    mean = np.asarray(fc.predicted_mean)
    se = np.asarray(fc.se_mean)
    ci = np.asarray(fc.conf_int(alpha=0.05))
    lower, upper = ci[:, 0], ci[:, 1]

    table = pd.DataFrame({
        "Date": future_dates.strftime("%Y-%m-%d"),
        "Day": [f"J+{i + 1}" for i in range(h)],
        "PM2.5_forecast_mean": mean,
        "CI_lower_95": np.maximum(lower, 0),
        "CI_upper_95": upper,
        "P25": np.maximum(mean + norm.ppf(0.25) * se, 0),
        "P50": np.maximum(mean, 0),
        "P95": mean + norm.ppf(0.95) * se,
    })
    exog_fc = pd.DataFrame({"Date": future_dates.strftime("%Y-%m-%d"), "Day": table["Day"], "TC": tc, "HR": hr})
    return {"table": table, "exog": exog_fc}


# ---------------------------------------------------------------------------
# 5. Classification + Monte-Carlo
# ---------------------------------------------------------------------------
def classify_concentration(p50: float) -> str:
    if p50 <= C.CONC_THRESHOLDS["faible_max"]:
        return "Faible"
    if p50 <= C.CONC_THRESHOLDS["moderee_max"]:
        return "Moderee"
    return "Elevee"


def classify_dose(p50_dose: float) -> str:
    return "Faible" if p50_dose <= C.DOSE_THRESHOLD else "Elevee"


def rtriangular(rng: np.random.Generator, n: int, a: float, c: float, b: float) -> np.ndarray:
    """Loi triangulaire (min a, mode c, max b) ; gère le cas dégénéré a == b."""
    if b - a < 1e-12:
        return np.full(n, float(a))
    c = min(max(c, a), b)
    return rng.triangular(a, c, b, size=n)


def simulate_dose(rng, p25, p50, p95, vent, duree, n_sim) -> np.ndarray:
    lo, mode, hi = sorted([p25, p50, p95])
    mode = min(max(mode, lo), hi)
    conc = rtriangular(rng, n_sim, lo, mode, hi)
    v = rtriangular(rng, n_sim, *vent)
    t = rtriangular(rng, n_sim, *duree)
    return conc * v * t * C.DOSE_FACTOR


def run_simulation(pm25_fc: pd.DataFrame, n_sim: int = C.N_SIMULATIONS_DEFAULT,
                   seed: int = C.SEED_DEFAULT, n_bins: int = 40) -> dict:
    rng = np.random.default_rng(seed)
    rows, hists = [], []
    for _, r in pm25_fc.iterrows():
        p25, p50, p95 = float(r["P25"]), float(r["P50"]), float(r["P95"])
        conc_class = classify_concentration(p50)
        for event, params in C.EVENT_PARAMS.items():
            dose = simulate_dose(rng, p25, p50, p95, params["ventilation"], params["duree"], n_sim)
            q25, q50, q95 = np.quantile(dose, [0.25, 0.50, 0.95])
            dose_class = classify_dose(q50)
            niveau, action = C.NIVEAU_ACTION[f"{conc_class}|{dose_class}"]
            rows.append({
                "Day": r["Day"], "Event": event,
                "PM2.5_P25": round(p25, 2), "PM2.5_P50": round(p50, 2), "PM2.5_P95": round(p95, 2),
                "Classification_concentration_PM2.5": conc_class,
                "Dose_inhalee_P25_mg": round(float(q25), 3),
                "Dose_inhalee_P50_mg": round(float(q50), 3),
                "Dose_inhalee_P95_mg": round(float(q95), 3),
                "Classification_dose_inhalee": dose_class,
                "Niveau_provisoire": niveau, "Action": action,
            })
            counts, edges = np.histogram(dose, bins=n_bins)
            hists.append({
                "Day": r["Day"], "Event": event,
                "edges": np.round(edges, 4).tolist(), "counts": counts.astype(int).tolist(),
                "mean": float(dose.mean()), "min": float(dose.min()), "max": float(dose.max()),
                "p25": float(q25), "p50": float(q50), "p95": float(q95),
                "prob_above_threshold": float(np.mean(dose > C.DOSE_THRESHOLD)),
            })
    return {"table": pd.DataFrame(rows), "histograms": hists, "n_sim": int(n_sim), "seed": int(seed)}
