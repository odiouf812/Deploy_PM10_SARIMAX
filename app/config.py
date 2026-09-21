"""Paramètres métier — repris à l'identique du script R d'origine
(sarimax_pm25_forecast_classification.R, issu de Classifications.docx)."""

N_SIMULATIONS_DEFAULT = 10_000
SEED_DEFAULT = 42
FORECAST_HORIZON = 2  # J+1, J+2
SEASONAL_PERIOD = 7   # saisonnalité hebdomadaire pour TC et HR
SHEET_NAME_DEFAULT = "Donnees_Completes"
DOSE_FACTOR = 0.001   # Dose (mg) = C (µg/m³) x V (L/min) x durée (min) x 0.001

# (min, mode, max) — distributions triangulaires
EVENT_PARAMS = {
    "800 m":          {"ventilation": (70, 128.8, 210), "duree": (3.67, 4.335, 5.67)},
    "1500 m":         {"ventilation": (70, 122.5, 195), "duree": (3.88, 4.375, 6.67)},
    "2000 m steeple": {"ventilation": (70, 121.3, 190), "duree": (5.58, 6.33, 7.33)},
    "3000 m":         {"ventilation": (65, 112.5, 180), "duree": (8.13, 9.21, 11.58)},
    "5000 m marche":  {"ventilation": (40, 78.8, 135),  "duree": (20.25, 22.75, 25.83)},
}

# Seuils de classification
CONC_THRESHOLDS = {"faible_max": 15.0, "moderee_max": 25.0}   # µg/m³ (sur le P50)
DOSE_THRESHOLD = 15.0                                          # mg    (sur le P50)

# Clé "classe_concentration|classe_dose" -> (niveau, action)
NIVEAU_ACTION = {
    "Faible|Faible":  (1, "Routine"),
    "Faible|Elevee":  (2, "Vigilance - exposition liee a l'effort"),
    "Moderee|Faible": (2, "Vigilance"),
    "Moderee|Elevee": (3, "Precaution renforcee"),
    "Elevee|Faible":  (3, "Precaution renforcee"),
    "Elevee|Elevee":  (3, "Precaution renforcee"),
}
