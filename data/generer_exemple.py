"""Génère data/exemple_dataset.xlsx — données SYNTHÉTIQUES pour tester l'application.
Structure identique à Dataset_pollution_Diam_PM2_5_TC_HR.xlsx (feuille Donnees_Completes)."""
import numpy as np, pandas as pd
rng = np.random.default_rng(7)
dates = pd.date_range("2024-01-01", "2026-09-18", freq="D")
n = len(dates); t = np.arange(n); doy = dates.dayofyear.values
tc = 26 + 3.2*np.sin(2*np.pi*(doy-120)/365) + 0.8*np.sin(2*np.pi*t/7) + rng.normal(0, 0.9, n)
hr = 72 + 8*np.sin(2*np.pi*(doy-200)/365) + 2*np.sin(2*np.pi*t/7+1) + rng.normal(0, 3, n)
season = 6*np.cos(2*np.pi*(doy-30)/365)                 # saison sèche / poussières
noise = np.zeros(n)
for i in range(1, n): noise[i] = 0.55*noise[i-1] + rng.normal(0, 3.2)
pm = 18 + season + 0.6*(tc-26) - 0.12*(hr-72) + noise
pm = np.clip(pm, 2, None)
df = pd.DataFrame({"Date": dates, "TC": tc.round(1), "HR": hr.round(1), "PM2.5": pm.round(1)})
with pd.ExcelWriter("data/exemple_dataset.xlsx", engine="openpyxl", datetime_format="YYYY-MM-DD") as w:
    df.to_excel(w, sheet_name="Donnees_Completes", index=False)
print(df.describe().round(1)); print(len(df))
