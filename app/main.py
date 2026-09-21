"""Souffle — API FastAPI + service du tableau de bord."""
from __future__ import annotations

import io
import math
import threading
import zipfile
from collections import OrderedDict
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config as C
from . import pipeline as P

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
SAMPLE_PATH = BASE_DIR.parent / "data" / "exemple_dataset.xlsx"

app = FastAPI(title="Souffle — PM2.5, prévisions et dose inhalée", version="1.0.0")

# ---------------------------------------------------------------------------
# État par session (en mémoire — usage local / mono-serveur)
# ---------------------------------------------------------------------------
_SESSIONS: "OrderedDict[str, dict]" = OrderedDict()
_LOCK = threading.Lock()
_MAX_SESSIONS = 25


def _state(sid: Optional[str]) -> dict:
    if not sid:
        raise HTTPException(400, "Identifiant de session manquant.")
    with _LOCK:
        if sid not in _SESSIONS:
            _SESSIONS[sid] = {}
            while len(_SESSIONS) > _MAX_SESSIONS:
                _SESSIONS.popitem(last=False)
        _SESSIONS.move_to_end(sid)
        return _SESSIONS[sid]


def _require(st: dict, key: str, message: str):
    if key not in st:
        raise HTTPException(409, message)
    return st[key]


def _clean(obj):
    """Remplace NaN/inf par None pour un JSON valide."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    return obj


def _json(payload: dict) -> JSONResponse:
    return JSONResponse(_clean(payload))


@app.exception_handler(P.DataError)
async def data_error_handler(_, exc: P.DataError):
    return JSONResponse({"detail": str(exc)}, status_code=422)


# ---------------------------------------------------------------------------
# Modèles de requête
# ---------------------------------------------------------------------------
class SheetRequest(BaseModel):
    sheet: str


class SimRequest(BaseModel):
    n_sim: int = Field(C.N_SIMULATIONS_DEFAULT, ge=100, le=200_000)
    seed: int = Field(C.SEED_DEFAULT, ge=0, le=2**31 - 1)


# ---------------------------------------------------------------------------
# Configuration publique
# ---------------------------------------------------------------------------
@app.get("/api/config")
def get_config():
    return {
        "events": {k: {"ventilation": list(v["ventilation"]), "duree": list(v["duree"])}
                   for k, v in C.EVENT_PARAMS.items()},
        "conc_thresholds": C.CONC_THRESHOLDS,
        "dose_threshold": C.DOSE_THRESHOLD,
        "matrix": [
            {"conc": k.split("|")[0], "dose": k.split("|")[1], "niveau": v[0], "action": v[1]}
            for k, v in C.NIVEAU_ACTION.items()
        ],
        "defaults": {"n_sim": C.N_SIMULATIONS_DEFAULT, "seed": C.SEED_DEFAULT},
        "sample_available": SAMPLE_PATH.exists(),
    }


# ---------------------------------------------------------------------------
# 1. Données
# ---------------------------------------------------------------------------
def _data_payload(df: pd.DataFrame, info: dict) -> dict:
    stats = {}
    for col in ("TC", "HR", "PM2.5"):
        s = df[col]
        stats[col] = {"mean": float(s.mean()), "min": float(s.min()), "max": float(s.max()), "std": float(s.std())}
    prev = df.head(6).copy()
    prev["Date"] = prev["Date"].dt.strftime("%Y-%m-%d")
    return {
        "info": info,
        "stats": stats,
        "series": {
            "dates": df["Date"].dt.strftime("%Y-%m-%d").tolist(),
            "TC": df["TC"].round(3).tolist(),
            "HR": df["HR"].round(3).tolist(),
            "PM2.5": df["PM2.5"].round(3).tolist(),
        },
        "preview": prev.round(2).to_dict(orient="records"),
    }


def _load_into_state(st: dict, raw: bytes, filename: str, sheet: Optional[str]):
    df, info = P.load_data(raw, filename, sheet)
    st.clear()
    st.update({"raw": raw, "filename": filename, "df": df, "info": info})
    return df, info


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), sheet: Optional[str] = Form(None),
                 x_session_id: Optional[str] = Header(None)):
    st = _state(x_session_id)
    raw = await file.read()
    if not raw:
        raise P.DataError("Le fichier est vide.")
    if len(raw) > 30 * 1024 * 1024:
        raise P.DataError("Fichier trop volumineux (30 Mo maximum).")
    df, info = _load_into_state(st, raw, file.filename or "donnees.xlsx", sheet)
    info["filename"] = file.filename
    return _json(_data_payload(df, info))


@app.post("/api/upload-sample")
def upload_sample(x_session_id: Optional[str] = Header(None)):
    if not SAMPLE_PATH.exists():
        raise HTTPException(404, "Aucun fichier d'exemple n'est fourni.")
    st = _state(x_session_id)
    df, info = _load_into_state(st, SAMPLE_PATH.read_bytes(), SAMPLE_PATH.name, None)
    info["filename"] = SAMPLE_PATH.name + " (données synthétiques)"
    return _json(_data_payload(df, info))


@app.post("/api/data/sheet")
def change_sheet(req: SheetRequest, x_session_id: Optional[str] = Header(None)):
    st = _state(x_session_id)
    raw = _require(st, "raw", "Importez d'abord un fichier.")
    filename = st["filename"]
    df, info = _load_into_state(st, raw, filename, req.sheet)
    info["filename"] = filename
    return _json(_data_payload(df, info))


# ---------------------------------------------------------------------------
# 2. Modèle
# ---------------------------------------------------------------------------
@app.post("/api/model")
def fit_model(x_session_id: Optional[str] = Header(None)):
    st = _state(x_session_id)
    df = _require(st, "df", "Importez d'abord un fichier Excel.")
    fits = P.fit_all_models(df)
    for k in ("forecast", "sim"):
        st.pop(k, None)
    st["fits"] = fits
    summary = P.model_summary(fits["PM2.5"], df)
    st["model_summary"] = summary
    st["exog_models"] = [P.exog_model_info("TC", fits["TC"]), P.exog_model_info("HR", fits["HR"])]
    return _json({"pm25": summary, "exog": st["exog_models"]})


# ---------------------------------------------------------------------------
# 3. Prévisions
# ---------------------------------------------------------------------------
@app.post("/api/forecast")
def forecast(x_session_id: Optional[str] = Header(None)):
    st = _state(x_session_id)
    df = _require(st, "df", "Importez d'abord un fichier Excel.")
    fits = _require(st, "fits", "Ajustez d'abord le modèle.")
    st.pop("sim", None)
    res = P.forecast_all(fits, df)
    st["forecast"] = res

    table = res["table"].copy()
    table["Classification"] = table["P50"].apply(P.classify_concentration)
    tail = df.tail(45)
    return _json({
        "table": table.to_dict(orient="records"),
        "exog": res["exog"].to_dict(orient="records"),
        "history": {
            "dates": tail["Date"].dt.strftime("%Y-%m-%d").tolist(),
            "pm25": tail["PM2.5"].round(3).tolist(),
        },
        "last_observed": {"date": df["Date"].max().strftime("%Y-%m-%d"), "pm25": float(df["PM2.5"].iloc[-1])},
    })


# ---------------------------------------------------------------------------
# 4. Simulation Monte-Carlo
# ---------------------------------------------------------------------------
@app.post("/api/simulate")
def simulate(req: SimRequest, x_session_id: Optional[str] = Header(None)):
    st = _state(x_session_id)
    fc = _require(st, "forecast", "Calculez d'abord les prévisions.")
    sim = P.run_simulation(fc["table"], n_sim=req.n_sim, seed=req.seed)
    st["sim"] = sim
    return _json({
        "n_sim": sim["n_sim"], "seed": sim["seed"],
        "histograms": sim["histograms"],
        "dose_threshold": C.DOSE_THRESHOLD,
    })


# ---------------------------------------------------------------------------
# 5. Classification
# ---------------------------------------------------------------------------
@app.get("/api/classification")
def classification(x_session_id: Optional[str] = Header(None)):
    st = _state(x_session_id)
    sim = _require(st, "sim", "Lancez d'abord la simulation Monte-Carlo.")
    table = sim["table"]
    probs = {(h["Day"], h["Event"]): h["prob_above_threshold"] for h in sim["histograms"]}
    rows = table.to_dict(orient="records")
    for r in rows:
        r["Prob_dose_sup_seuil"] = probs[(r["Day"], r["Event"])]
    return _json({"rows": rows, "n_sim": sim["n_sim"], "seed": sim["seed"]})


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------
def _csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode("utf-8")


def _xlsx_bytes(st: dict) -> bytes:
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        if "forecast" in st:
            st["forecast"]["table"].to_excel(w, sheet_name="Prevision_PM25", index=False)
            st["forecast"]["exog"].to_excel(w, sheet_name="Prevision_TC_HR", index=False)
        if "sim" in st:
            st["sim"]["table"].to_excel(w, sheet_name="Classification", index=False)
        if "model_summary" in st:
            ms = st["model_summary"]
            pd.DataFrame(ms["coefficients"]).to_excel(w, sheet_name="Modele_PM25", index=False)
            pd.DataFrame([
                {"Indicateur": "Modèle", "Valeur": ms["label"]},
                {"Indicateur": "AICc", "Valeur": ms["aicc"]},
                {"Indicateur": "BIC", "Valeur": ms["bic"]},
                {"Indicateur": "RMSE", "Valeur": ms["rmse"]},
                {"Indicateur": "MAE", "Valeur": ms["mae"]},
                {"Indicateur": "R²", "Valeur": ms["r2"]},
                {"Indicateur": "Ljung-Box p", "Valeur": ms["ljung_box_p"]},
            ]).to_excel(w, sheet_name="Modele_indicateurs", index=False)
        rows = [{"Epreuve": e, "Ventilation_min": v["ventilation"][0], "Ventilation_mode": v["ventilation"][1],
                 "Ventilation_max": v["ventilation"][2], "Duree_min": v["duree"][0],
                 "Duree_mode": v["duree"][1], "Duree_max": v["duree"][2]}
                for e, v in C.EVENT_PARAMS.items()]
        pd.DataFrame(rows).to_excel(w, sheet_name="Parametres_epreuves", index=False)
        for ws in w.book.worksheets:
            for col in ws.columns:
                width = max(len(str(c.value)) if c.value is not None else 0 for c in col)
                ws.column_dimensions[col[0].column_letter].width = min(max(width + 2, 10), 46)
    return buf.getvalue()


@app.get("/api/download/{kind}")
def download(kind: str, sid: Optional[str] = Query(None)):
    st = _state(sid)
    if kind == "forecast":
        fc = _require(st, "forecast", "Aucune prévision à télécharger.")
        return _attachment(_csv_bytes(fc["table"]), "pm25_forecast.csv", "text/csv")
    if kind == "classification":
        sim = _require(st, "sim", "Aucune classification à télécharger.")
        return _attachment(_csv_bytes(sim["table"]), "exposure_classification.csv", "text/csv")
    if kind == "xlsx":
        _require(st, "df", "Aucun résultat à télécharger.")
        return _attachment(_xlsx_bytes(st), "souffle_resultats.xlsx",
                           "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    if kind == "all":
        sim = _require(st, "sim", "Terminez d'abord la simulation pour exporter l'ensemble.")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("pm25_forecast.csv", _csv_bytes(st["forecast"]["table"]))
            z.writestr("exposure_classification.csv", _csv_bytes(sim["table"]))
            z.writestr("souffle_resultats.xlsx", _xlsx_bytes(st))
        return _attachment(buf.getvalue(), "souffle_resultats.zip", "application/zip")
    raise HTTPException(404, "Export inconnu.")


def _attachment(content: bytes, name: str, media: str) -> Response:
    return Response(content, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/sample-file")
def sample_file():
    if not SAMPLE_PATH.exists():
        raise HTTPException(404, "Aucun fichier d'exemple.")
    return FileResponse(SAMPLE_PATH, filename=SAMPLE_PATH.name)


# ---------------------------------------------------------------------------
# Front-end statique
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
