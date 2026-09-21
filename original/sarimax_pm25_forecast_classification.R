# ---------------------------------------------------------------------------
# SARIMAX forecasting of PM2.5 (exogenous: TC, HR) for J+1 and J+2,
# followed by the exposure-classification / inhaled-dose pipeline described
# in "Classifications.docx".
#
# Pipeline
# --------
# 1. Load the daily dataset (Date, TC, HR, PM2.5).
# 2. Forecast the two exogenous variables (TC, HR) two days ahead with their
#    own (S)ARIMA models -- SARIMAX needs future exogenous values to forecast
#    PM2.5 out-of-sample, and none are supplied, so TC/HR are forecast first
#    and then fed into the PM2.5 model as xreg.
# 3. Fit a SARIMAX-equivalent model for PM2.5 (auto.arima with xreg = TC,HR),
#    forecast PM2.5 for day+1 and day+2 with 95% CIs and the P25/P50/P95 of
#    the forecast distribution.
# 4. Apply the Classifications.docx logic for every event type (800 m,
#    1500 m, 2000 m steeple, 3000 m, 5000 m marche) and for each day:
#       a. Classify the forecast PM2.5 concentration (Faible / Moderee /
#          Elevee) from its P50.
#       b. Monte-Carlo simulate (10 000 draws) the inhaled dose:
#             Dose = Concentration(P25,P50,P95) x Ventilation(min,mode,max)
#                    x Duree(min,mode,max) x 0.001
#          (each factor drawn from a triangular distribution), then classify
#          the simulated dose (Faible / Elevee) from its P50.
#       c. Combine both classifications into the "Niveau provisoire" (1-3)
#          and the recommended "Action".
#
# Outputs
# -------
# - pm25_forecast.csv           : PM2.5 forecast (mean, 95% CI, P25/P50/P95)
# - exposure_classification.csv : full classification/dose table per event/day
# - console summary tables
#
# Required packages: readxl, forecast, dplyr
#   install.packages(c("readxl", "forecast", "dplyr"))
# ---------------------------------------------------------------------------

suppressMessages({
  library(readxl)
  library(forecast)
  library(dplyr)
})

set.seed(42)

N_SIMULATIONS    <- 10000
FORECAST_HORIZON <- 2  # day+1, day+2
DATA_PATH        <- "Dataset_pollution_Diam_PM2_5_TC_HR.xlsx"
SHEET_NAME       <- "Donnees_Completes"

# ---------------------------------------------------------------------------
# Event-specific ventilation (L/min) and duration (min) triangular
# parameters (min, mode, max), taken from Classifications.docx
# ---------------------------------------------------------------------------
EVENT_PARAMS <- list(
  "800 m"          = list(ventilation = c(70, 128.8, 210), duree = c(3.67, 4.335, 5.67)),
  "1500 m"         = list(ventilation = c(70, 122.5, 195), duree = c(3.88, 4.375, 6.67)),
  "2000 m steeple" = list(ventilation = c(70, 121.3, 190), duree = c(5.58, 6.33, 7.33)),
  "3000 m"         = list(ventilation = c(65, 112.5, 180), duree = c(8.13, 9.21, 11.58)),
  "5000 m marche"  = list(ventilation = c(40, 78.8, 135), duree = c(20.25, 22.75, 25.83))
)

# Niveau provisoire / Action lookup keyed by "concentration_class|dose_class"
NIVEAU_ACTION <- list(
  "Faible|Faible"   = list(niveau = 1, action = "Routine"),
  "Faible|Elevee"   = list(niveau = 2, action = "Vigilance - exposition liee a l'effort"),
  "Moderee|Faible"  = list(niveau = 2, action = "Vigilance"),
  "Moderee|Elevee"  = list(niveau = 3, action = "Precaution renforcee"),
  "Elevee|Faible"   = list(niveau = 3, action = "Precaution renforcee"),
  "Elevee|Elevee"   = list(niveau = 3, action = "Precaution renforcee")
)

# ---------------------------------------------------------------------------
# Triangular random-number generator (base R has no built-in rtriangle)
# ---------------------------------------------------------------------------
rtriangular <- function(n, a, c, b) {
  # a = min, c = mode, b = max
  u  <- runif(n)
  Fc <- (c - a) / (b - a)
  x <- ifelse(
    u < Fc,
    a + sqrt(u * (b - a) * (c - a)),
    b - sqrt((1 - u) * (b - a) * (b - c))
  )
  x
}

# ---------------------------------------------------------------------------
# 1. Load data
# ---------------------------------------------------------------------------
load_data <- function(path = DATA_PATH, sheet = SHEET_NAME) {
  df <- read_excel(path, sheet = sheet)
  df$Date <- as.Date(df$Date)
  df <- df[order(df$Date), ]
  # sanity check: no gaps expected, but fill via linear interpolation if any
  full_dates <- seq(min(df$Date), max(df$Date), by = "day")
  if (length(full_dates) != nrow(df)) {
    df <- data.frame(Date = full_dates) %>%
      left_join(df, by = "Date") %>%
      mutate(across(c(TC, HR, `PM2.5`), ~ zoo::na.approx(.x, na.rm = FALSE)))
  }
  df
}

# ---------------------------------------------------------------------------
# 2. Forecast exogenous variables (TC, HR) with auto.arima (weekly seasonal)
# ---------------------------------------------------------------------------
forecast_exog_series <- function(x, steps = FORECAST_HORIZON) {
  ts_x <- ts(x, frequency = 7)  # weekly seasonality, as in the Python script
  fit  <- auto.arima(ts_x, seasonal = TRUE, stepwise = FALSE, approximation = FALSE)
  fc   <- forecast(fit, h = steps)
  list(mean = as.numeric(fc$mean), model = fit)
}

# ---------------------------------------------------------------------------
# 3. Fit SARIMAX-equivalent (auto.arima + xreg) for PM2.5, forecast with CIs
# ---------------------------------------------------------------------------
fit_pm25_model <- function(endog, exog) {
  auto.arima(
    endog, xreg = exog,
    seasonal = FALSE,          # matches seasonal_order=(0,0,0,0) in the Python version
    stepwise = FALSE, approximation = FALSE
  )
}

forecast_pm25 <- function(fit, xreg_future, level = 95) {
  fc <- forecast(fit, xreg = xreg_future, level = level)

  mean_fc  <- as.numeric(fc$mean)
  lower95  <- as.numeric(fc$lower[, 1])
  upper95  <- as.numeric(fc$upper[, 1])
  se       <- (upper95 - mean_fc) / qnorm(0.975)   # back out the forecast SE

  data.frame(
    PM2.5_forecast_mean = mean_fc,
    CI_lower_95 = pmax(lower95, 0),
    CI_upper_95 = upper95,
    P25 = pmax(mean_fc + qnorm(0.25) * se, 0),
    P50 = pmax(mean_fc, 0),
    P95 = mean_fc + qnorm(0.95) * se
  )
}

# ---------------------------------------------------------------------------
# 4. Classifications.docx logic
# ---------------------------------------------------------------------------
classify_concentration <- function(p50) {
  if (p50 <= 15) "Faible"
  else if (p50 <= 25) "Moderee"
  else "Elevee"
}

classify_dose <- function(p50_dose) {
  if (p50_dose <= 15) "Faible" else "Elevee"
}

simulate_dose <- function(p25, p50, p95, ventilation_params, duree_params,
                           n_sim = N_SIMULATIONS) {
  ord <- sort(c(p25, p50, p95))
  lo <- ord[1]; mode <- min(max(ord[2], ord[1]), ord[3]); hi <- ord[3]

  conc_sim  <- rtriangular(n_sim, lo, mode, hi)
  vent_sim  <- rtriangular(n_sim, ventilation_params[1], ventilation_params[2], ventilation_params[3])
  duree_sim <- rtriangular(n_sim, duree_params[1], duree_params[2], duree_params[3])

  conc_sim * vent_sim * duree_sim * 0.001
}

build_classification_table <- function(pm25_forecast, day_labels) {
  rows <- list()
  idx <- 1
  for (i in seq_len(nrow(pm25_forecast))) {
    day_label <- day_labels[i]
    p25 <- pm25_forecast$P25[i]
    p50 <- pm25_forecast$P50[i]
    p95 <- pm25_forecast$P95[i]
    conc_class <- classify_concentration(p50)

    for (event in names(EVENT_PARAMS)) {
      params <- EVENT_PARAMS[[event]]
      dose_sim <- simulate_dose(p25, p50, p95, params$ventilation, params$duree)
      dose_q <- quantile(dose_sim, probs = c(0.25, 0.50, 0.95))
      dose_class <- classify_dose(dose_q[["50%"]])

      key <- paste0(
        ifelse(conc_class == "Elevee", "Elevee", ifelse(conc_class == "Moderee", "Moderee", "Faible")),
        "|", dose_class
      )
      na_entry <- NIVEAU_ACTION[[key]]

      rows[[idx]] <- data.frame(
        Day = day_label,
        Event = event,
        PM2.5_P25 = round(p25, 2),
        PM2.5_P50 = round(p50, 2),
        PM2.5_P95 = round(p95, 2),
        Classification_concentration_PM2.5 = conc_class,
        Dose_inhalee_P25_mg = round(dose_q[["25%"]], 3),
        Dose_inhalee_P50_mg = round(dose_q[["50%"]], 3),
        Dose_inhalee_P95_mg = round(dose_q[["95%"]], 3),
        Classification_dose_inhalee = dose_class,
        Niveau_provisoire = na_entry$niveau,
        Action = na_entry$action,
        stringsAsFactors = FALSE
      )
      idx <- idx + 1
    }
  }
  do.call(rbind, rows)
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main <- function() {
  df <- load_data()
  cat(sprintf("Loaded %d daily observations: %s -> %s\n",
              nrow(df), min(df$Date), max(df$Date)))

  # --- forecast exogenous variables ---
  tc_fc <- forecast_exog_series(df$TC)
  hr_fc <- forecast_exog_series(df$HR)
  cat("TC forecast (day+1, day+2):", round(tc_fc$mean, 2), "\n")
  cat("HR forecast (day+1, day+2):", round(hr_fc$mean, 2), "\n")

  future_dates <- seq(max(df$Date) + 1, by = "day", length.out = FORECAST_HORIZON)
  xreg_future <- cbind(TC = tc_fc$mean, HR = hr_fc$mean)

  # --- fit SARIMAX-equivalent model for PM2.5 ---
  endog <- df$`PM2.5`
  exog  <- cbind(TC = df$TC, HR = df$HR)
  fit <- fit_pm25_model(endog, exog)
  cat("\nSelected model for PM2.5 ~ TC + HR:\n")
  print(fit)

  # --- forecast PM2.5 for day+1, day+2 ---
  pm25_forecast <- forecast_pm25(fit, xreg_future)
  pm25_forecast <- cbind(Date = future_dates, Day = c("J+1", "J+2"), pm25_forecast)
  cat("\n=== PM2.5 forecast (day+1, day+2) ===\n")
  print(pm25_forecast, row.names = FALSE)
  write.csv(pm25_forecast, "pm25_forecast.csv", row.names = FALSE)

  # --- exposure classification & dose simulation ---
  class_table <- build_classification_table(pm25_forecast, pm25_forecast$Day)
  cat("\n=== Exposure classification & simulated inhaled dose (per event, per day) ===\n")
  print(class_table, row.names = FALSE)
  write.csv(class_table, "exposure_classification.csv", row.names = FALSE)

  invisible(list(pm25_forecast = pm25_forecast, class_table = class_table))
}

main()
