from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "outputs"
PROCESSED_DIR = OUTPUT_DIR / "processed"
PREDICTION_DIR = OUTPUT_DIR / "predictions"
MODEL_DIR = BASE_DIR / "models"
DATASET_DIR = OUTPUT_DIR / "datasets"

CLEANED_TELEMETRY_PATH = DATASET_DIR / "cleaned_telemetry.csv"
EVALUATION_DATASET_PATH = DATASET_DIR / "evaluation_dataset.csv"
TRIP_SESSIONS_PATH = DATASET_DIR / "trip_sessions.csv"

FEATURE_COLUMNS = [
    "fuel_level_filtered",
    "speed_filtered",
    "fuel_delta",
    "odometer_delta",
    "fuel_per_km",
    "fuel_rate_per_hour",
    "distance_per_fuel",
    "route_segment_performance",
    "driver_behavior_score",
]

# Model B: Fuel + Speed + Context OBD-II (17 features)
# Adds 8 features derived from RPM, engine load, throttle, and anomaly-specific
EXTENDED_FEATURE_COLUMNS = FEATURE_COLUMNS + [
    "engine_rpm_normalized",       # RPM / 4000, clipped [0, 1]
    "engine_load_pct_norm",        # engine_load_pct / 100
    "throttle_pct_norm",           # throttle_pct / 100
    "fuel_drop_while_stationary",
    "fuel_drop_with_engine_off",   # |fuel_delta| when engine_status == 'idle'/'off'
    "idle_duration_score",
    "fuel_drop_per_rpm",
    "fuel_drop_per_load",
]

# Adds GPS-OBD fused distance with explicit sensor-divergence and confidence
# proportional to actual displacement AND whether the displacement estimate
# odometer-spoof / GPS-spoof anomalies that pure distance values cannot.
FULL_FEATURE_COLUMNS = EXTENDED_FEATURE_COLUMNS + [
    # (distance_fused_delta, distance_disagreement_norm, distance_obd_residual,
    # set contains no odometer-spoof / GPS-spoof anomalies -- they exercise no
    # part of the fusion signal and the resulting noise dragged precision
    # data is available; tracked as future work in ?6.4.10.
    "speed_variability",            # rolling std of speed -- stop-and-go intensity
    "acceleration_kmph_per_sec",    # instantaneous acceleration -- harsh braking/accel
]

# The new features give the Isolation Forest enough context to learn that
# small fuel-level drops correlated with engine-load spikes or recent refuels
# are slosh / settling, not theft.
# Sources informing this feature set:
#   * Oxmaint AI fuel-theft heuristics (per-asset baseline, refuel suppression)
#     -> time_since_refuel_sec, post_refuel_flag, expected_consumption_residual
#   * Tank sloshing literature (0.2-0.5 Hz LPF, accel-induced false dips)
#     -> delta_engine_load_norm, delta_throttle_norm, load_per_speed
CONTEXT_FEATURE_COLUMNS = FULL_FEATURE_COLUMNS + [
    "motion_state_code",
    "time_since_refuel_norm",
    "post_refuel_flag",
    "delta_engine_load_norm",
    "delta_throttle_norm",               # current throttle_norm minus previous, clipped [-1,1]
    "load_per_speed_norm",
    "expected_consumption_residual",
]

# Barbado A.1 (Table 8) Driving-Behaviour features added here:
#     -- Barbado defines four RPM x vehicle-speed buckets that capture
#       per-trip rolling share (each in [0,1]) so a single row's contribution
#     of Barbado's "speed_events_over_90 / _120" indicators.
# Habib 2015 KMPL anomaly %age:
#   * kmpl_deviation_pct -- distance of the row's fuel_per_km from the
#     "anomaly %age" calculation, applied per-truck instead of per-vehicle-
#   * driver_kmpl_deviation_pct -- same calculation but baselined against
#     Habib ?"Cluster on the basis of drivers" -- driver-fingerprinting view.
# Categorical context (Barbado BR1):
#     IF tree splits work just as well on the ordinal encoding.
CONTEXT_FEATURE_COLUMNS_V2 = CONTEXT_FEATURE_COLUMNS + [
    "rpm_high_share",
    "rpm_red_share",
    "rpm_orange_share",
    "rpm_yellow_share",
    "speed_over_90_share",               # rolling fraction with speed > 90 km/h
    "speed_over_120_share",              # rolling fraction with speed > 120 km/h
    "kmpl_deviation_pct",
    "driver_kmpl_deviation_pct",
    "route_type_code",
]

# BASELINE that every model includes -- they are too important to be optional.
# Each variant then adds one paper's contribution on top of that baseline:
#   Model A -- Context-Aware Baseline (24 features)
#       suppression that fixed the 2026-06-23 TRCK-03 false-positive.
#   Model B -- + Driving Zones (30 features)
#       Adds Barbado A.1 (Table 8) driving-behaviour features: four RPM zones
#       speed-event shares (>90, >120 km/h).
#   Model C -- + Anchor-Paper-Aligned (33 features)
#       baselines) and Barbado's route_type categorical (city / combined /
# Each ablation row shows the marginal value of one paper's contribution,
# which gives ?6 a clean three-line ablation table.

# Internal building blocks (no longer user-facing variants in the paper, but
# and the SO reports import them).

# New 3-variant scheme -- built directly on EXTENDED (B's features) plus the
# Model D context-aware additions, deliberately SKIPPING the C-era
# precision vs B in the canonical evaluation.
_D_ONLY_FEATURES = [
    "motion_state_code",
    "time_since_refuel_norm",
    "post_refuel_flag",
    "delta_engine_load_norm",
    "delta_throttle_norm",
    "load_per_speed_norm",
    "expected_consumption_residual",
]
_DRIVING_ZONE_FEATURES = [
    "rpm_high_share", "rpm_red_share", "rpm_orange_share", "rpm_yellow_share",
    "speed_over_90_share", "speed_over_120_share",
]
_KMPL_BASELINE_FEATURES = [
    "kmpl_deviation_pct",
    "driver_kmpl_deviation_pct",
    "route_type_code",
]

CONTEXT_AWARE_BASELINE_COLUMNS = EXTENDED_FEATURE_COLUMNS + _D_ONLY_FEATURES         # 24
DRIVING_ZONES_COLUMNS          = CONTEXT_AWARE_BASELINE_COLUMNS + _DRIVING_ZONE_FEATURES  # 30
ANCHOR_ALIGNED_COLUMNS         = DRIVING_ZONES_COLUMNS + _KMPL_BASELINE_FEATURES     # 33

# Human-readable model labels used in evaluation reports and paper tables.
MODEL_VARIANT_NAMES = {
    "A": "Model A: Context-Aware Baseline (fuel + speed + OBD-II + slosh suppression)",
    "B": "Model B: + Driving Zones (Barbado RPM bands + speed events)",
    "C": "Model C: + KMPL Baseline-Deviation (Habib per-asset/per-driver + route_type)",
}
MODEL_VARIANT_FEATURES = {
    "A": CONTEXT_AWARE_BASELINE_COLUMNS,
    "B": DRIVING_ZONES_COLUMNS,
    "C": ANCHOR_ALIGNED_COLUMNS,
}

FILTER_WINDOW = 3
MEDIAN_WINDOW = 3
TIME_BUCKET_ORDER = ["night", "morning", "afternoon", "evening"]
TRIP_DURATION_BINS = [-0.01, 12.0, 30.0, np.inf]
TRIP_DURATION_LABELS = ["short", "medium", "long"]

# Grade thresholds (percent grade = vertical rise / horizontal run x 100)
SLOPE_UPHILL_THRESHOLD = 2.0    # > 2 % grade = uphill
SLOPE_DOWNHILL_THRESHOLD = -2.0 # < -2 % grade = downhill

# Load proxy thresholds (relative to per-trip mean fuel-per-km)
LOAD_HEAVY_THRESHOLD = 1.30  # > 30 % above trip mean -> heavy
LOAD_LIGHT_THRESHOLD = 0.80  # < 20 % below trip mean -> light


def ensure_directories() -> None:
    for path in [OUTPUT_DIR, PROCESSED_DIR, PREDICTION_DIR, MODEL_DIR, DATASET_DIR]:
        path.mkdir(parents=True, exist_ok=True)


def load_dataset_csv(path: str | Path) -> pd.DataFrame:
    csv_path = Path(path)
    if not csv_path.exists():
        raise FileNotFoundError(f"Dataset file not found: {csv_path}")
    return pd.read_csv(csv_path)


def load_cleaned_telemetry(path: str | Path = CLEANED_TELEMETRY_PATH) -> pd.DataFrame:
    return load_dataset_csv(path)


def load_evaluation_dataset(path: str | Path = EVALUATION_DATASET_PATH) -> pd.DataFrame:
    return load_dataset_csv(path)


def load_trip_sessions(path: str | Path = TRIP_SESSIONS_PATH) -> pd.DataFrame:
    frame = load_dataset_csv(path)
    if "start_time" in frame.columns:
        frame["start_time"] = pd.to_datetime(frame["start_time"], utc=True, errors="coerce")
    if "end_time" in frame.columns:
        frame["end_time"] = pd.to_datetime(frame["end_time"], utc=True, errors="coerce")
    return frame


def standardize_telemetry_schema(frame: pd.DataFrame) -> pd.DataFrame:
    df = frame.copy()
    rename_map: dict[str, str] = {}
    if "speed" in df.columns and "speed_kmph" not in df.columns:
        rename_map["speed"] = "speed_kmph"
    if "is_anomaly" in df.columns and "anomaly_label" not in df.columns:
        rename_map["is_anomaly"] = "anomaly_label"
    if "anomaly_flag" in df.columns and "anomaly_label" not in df.columns:
        rename_map["anomaly_flag"] = "anomaly_label"
    if rename_map:
        df = df.rename(columns=rename_map)

    required = {"timestamp", "truck_id", "trip_id", "fuel_level"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Telemetry data missing required columns: {sorted(missing)}")

    if "driver_id" not in df.columns:
        df["driver_id"] = pd.NA
    if "speed_kmph" not in df.columns:
        df["speed_kmph"] = 0.0
    if "lat" not in df.columns:
        df["lat"] = np.nan
    if "lon" not in df.columns:
        df["lon"] = np.nan
    if "altitude_m" not in df.columns:
        df["altitude_m"] = np.nan
    if "odometer_km" not in df.columns:
        df["odometer_km"] = 0.0
    if "engine_status" not in df.columns:
        df["engine_status"] = "on"
    if "anomaly_label" not in df.columns:
        df["anomaly_label"] = False
    if "anomaly_type" not in df.columns:
        df["anomaly_type"] = "normal"
    if "source_file" not in df.columns:
        df["source_file"] = "canonical_dataset"
    if "source_dataset" not in df.columns:
        df["source_dataset"] = "canonical_dataset"
    if "record_origin" not in df.columns:
        df["record_origin"] = "canonical_dataset"
    if "label_source" not in df.columns:
        df["label_source"] = "clean"
    if "is_injected" not in df.columns:
        df["is_injected"] = False

    # Extended OBD2 columns -- optional, default to NaN / False when absent
    for _col in ("engine_rpm", "engine_load_pct", "throttle_pct", "maf_gps",
                 "coolant_temp_c", "engine_runtime_sec"):
        if _col not in df.columns:
            df[_col] = np.nan
    for _col in ("dtc_present",):
        if _col not in df.columns:
            df[_col] = False
    for _col in ("fuel_valid",):
        if _col not in df.columns:
            df[_col] = True  # assume valid when field absent (legacy rows)
    for _col in ("fuel_source", "fuel_confidence"):
        if _col not in df.columns:
            df[_col] = "unknown"

    df["timestamp"] = pd.to_datetime(df["timestamp"], format="mixed", utc=True, errors="coerce")
    df = df.dropna(subset=["timestamp"]).copy()

    numeric_cols = [
        "fuel_level",
        "speed_kmph",
        "odometer_km",
        "lat",
        "lon",
        "altitude_m",
        "latency_ms",
        "fuel_delta",
        "odometer_delta",
        "delta_time_sec",
        "fuel_per_km",
        "fuel_rate_per_hour",
        "anomaly_score",
        # Extended OBD2
        "engine_rpm",
        "engine_load_pct",
        "throttle_pct",
        "maf_gps",
        "coolant_temp_c",
        "engine_runtime_sec",
    ]
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    text_cols = [
        "truck_id",
        "trip_id",
        "driver_id",
        "engine_status",
        "anomaly_type",
        "source_file",
        "source_dataset",
        "record_origin",
        "label_source",
    ]
    for col in text_cols:
        if col in df.columns:
            df[col] = df[col].astype(str)

    df["fuel_level"] = df["fuel_level"].clip(lower=0.0, upper=100.0)
    df["speed_kmph"] = df["speed_kmph"].fillna(0.0).clip(lower=0.0)
    df["odometer_km"] = df["odometer_km"].ffill().fillna(0.0)
    df["anomaly_label"] = df["anomaly_label"].fillna(False).astype(bool)
    df["is_injected"] = df["is_injected"].fillna(False).astype(bool)
    return df.sort_values(["truck_id", "trip_id", "timestamp"]).reset_index(drop=True)


def apply_sensor_calibration(series: pd.Series, gain: float = 1.0, offset: float = 0.0) -> pd.Series:

    return (series.astype(float) * gain) + offset


def _rolling_median(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window=window, min_periods=1).median()


def _moving_average(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window=window, min_periods=1).mean()


def _time_bucket(hour: int) -> str:
    if 0 <= hour < 6:
        return "night"
    if 6 <= hour < 12:
        return "morning"
    if 12 <= hour < 18:
        return "afternoon"
    return "evening"


def _behavior_context(score: float) -> str:
    if score >= 2.0:
        return "aggressive"
    if score >= 1.0:
        return "active"
    return "steady"


def _slope_bin(slope_pct: float) -> str:
    """Classify road grade into uphill / flat / downhill."""
    if slope_pct > SLOPE_UPHILL_THRESHOLD:
        return "uphill"
    if slope_pct < SLOPE_DOWNHILL_THRESHOLD:
        return "downhill"
    return "flat"


def _load_level(load_proxy: float) -> str:
    """Classify relative fuel consumption as a load-level proxy."""
    if load_proxy >= LOAD_HEAVY_THRESHOLD:
        return "heavy"
    if load_proxy <= LOAD_LIGHT_THRESHOLD:
        return "light"
    return "medium"


def normalize_trip_source_category(source_dataset: str | None, record_origin: str | None) -> str:
    source_dataset = "" if source_dataset is None else str(source_dataset)
    record_origin = "" if record_origin is None else str(record_origin)
    if "geolife" in source_dataset or "public_geolife" in record_origin:
        return "public_route"
    return "project_native"


def build_threshold_context_key(
    source_category: str | None,
    trip_length_band: str | None,
    context_key: str | None,
) -> str:
    source_label = "unknown_source" if source_category is None or pd.isna(source_category) else str(source_category)
    length_label = "unknown_length" if trip_length_band is None or pd.isna(trip_length_band) else str(trip_length_band)
    base_context = "global" if context_key is None or pd.isna(context_key) or str(context_key).strip() == "" else str(context_key)
    return f"{source_label}|{length_label}|{base_context}"


def build_context_key(
    hour_of_day: int | float | None,
    route_segment_index: int | float | None,
    driver_behavior_score: float | None,
    route_type_code: int | float | None = None,
) -> str:
    if hour_of_day is None or pd.isna(hour_of_day):
        time_bucket = "unknown"
    else:
        time_bucket = _time_bucket(int(hour_of_day))

    if route_segment_index is None or pd.isna(route_segment_index):
        segment_label = "segment_unknown"
    else:
        segment_label = f"segment_{int(route_segment_index)}"

    behavior = _behavior_context(float(driver_behavior_score or 0.0))

    if route_type_code is None or pd.isna(route_type_code):
        return f"{time_bucket}|{segment_label}|{behavior}"

    route_type_label = {0: "city", 1: "combined", 2: "highway"}.get(int(route_type_code), "rt_unknown")
    return f"{time_bucket}|{segment_label}|{behavior}|{route_type_label}"


def _merge_trip_sessions(frame: pd.DataFrame, trip_sessions: pd.DataFrame | None) -> pd.DataFrame:
    if trip_sessions is None or trip_sessions.empty:
        return frame

    session_cols = [
        "id",
        "start_time",
        "end_time",
        "distance_km",
        "operating_hours",
        "trip_status",
    ]
    available_cols = [col for col in session_cols if col in trip_sessions.columns]
    if "id" not in available_cols:
        return frame

    session_frame = trip_sessions[available_cols].copy().rename(columns={"id": "trip_id"})
    if "start_time" in session_frame.columns:
        session_frame["start_time"] = pd.to_datetime(session_frame["start_time"], utc=True, errors="coerce")
    if "end_time" in session_frame.columns:
        session_frame["end_time"] = pd.to_datetime(session_frame["end_time"], utc=True, errors="coerce")
    return frame.merge(session_frame, on="trip_id", how="left")


def engineer_features(
    frame: pd.DataFrame,
    trip_sessions: pd.DataFrame | None = None,
    calibration_gain: float = 1.0,
    calibration_offset: float = 0.0,
    moving_window: int = FILTER_WINDOW,
    median_window: int = MEDIAN_WINDOW,
) -> pd.DataFrame:
    df = standardize_telemetry_schema(frame)
    df = _merge_trip_sessions(df, trip_sessions)
    group_cols = ["truck_id", "trip_id"]
    grouped = df.groupby(group_cols, dropna=False)

    source_fuel_delta = pd.to_numeric(df["fuel_delta"], errors="coerce") if "fuel_delta" in df.columns else pd.Series(np.nan, index=df.index)
    source_odometer_delta = (
        pd.to_numeric(df["odometer_delta"], errors="coerce") if "odometer_delta" in df.columns else pd.Series(np.nan, index=df.index)
    )
    source_delta_time = (
        pd.to_numeric(df["delta_time_sec"], errors="coerce") if "delta_time_sec" in df.columns else pd.Series(np.nan, index=df.index)
    )
    source_fuel_per_km = (
        pd.to_numeric(df["fuel_per_km"], errors="coerce") if "fuel_per_km" in df.columns else pd.Series(np.nan, index=df.index)
    )
    source_fuel_rate_per_hour = (
        pd.to_numeric(df["fuel_rate_per_hour"], errors="coerce") if "fuel_rate_per_hour" in df.columns else pd.Series(np.nan, index=df.index)
    )

    df["fuel_level_calibrated"] = apply_sensor_calibration(df["fuel_level"].fillna(0.0), calibration_gain, calibration_offset)
    df["speed_calibrated"] = apply_sensor_calibration(df["speed_kmph"].fillna(0.0), 1.0, 0.0)
    df["fuel_level_median"] = grouped["fuel_level_calibrated"].transform(lambda s: _rolling_median(s, median_window))
    df["fuel_level_filtered"] = grouped["fuel_level_median"].transform(lambda s: _moving_average(s, moving_window))
    df["speed_median"] = grouped["speed_calibrated"].transform(lambda s: _rolling_median(s, median_window))
    df["speed_filtered"] = grouped["speed_median"].transform(lambda s: _moving_average(s, moving_window))

    prev_fuel = grouped["fuel_level_filtered"].shift(1)
    prev_odo = grouped["odometer_km"].shift(1)
    prev_speed = grouped["speed_filtered"].shift(1)
    prev_ts = grouped["timestamp"].shift(1)

    df["fuel_delta_filtered"] = (df["fuel_level_filtered"] - prev_fuel).fillna(0.0)
    df["odometer_delta_filtered"] = (df["odometer_km"] - prev_odo).fillna(0.0).clip(lower=0.0)
    df["delta_time_sec_synced"] = (df["timestamp"] - prev_ts).dt.total_seconds().fillna(0.0).clip(lower=0.0)

    filtered_fuel_used = (-df["fuel_delta_filtered"]).clip(lower=0.0)
    df["fuel_per_km_filtered"] = np.where(
        df["odometer_delta_filtered"] > 0,
        filtered_fuel_used / df["odometer_delta_filtered"],
        0.0,
    )
    df["fuel_rate_per_hour_filtered"] = np.where(
        df["delta_time_sec_synced"] > 0,
        filtered_fuel_used / (df["delta_time_sec_synced"] / 3600.0),
        0.0,
    )

    df["fuel_delta"] = source_fuel_delta.fillna(df["fuel_delta_filtered"]).fillna(0.0)
    df["odometer_delta"] = source_odometer_delta.fillna(df["odometer_delta_filtered"]).fillna(0.0).clip(lower=0.0)
    df["delta_time_sec"] = source_delta_time.fillna(df["delta_time_sec_synced"]).fillna(0.0).clip(lower=0.0)
    fuel_used = (-df["fuel_delta"]).clip(lower=0.0)
    fallback_fuel_per_km = pd.Series(
        np.where(df["odometer_delta"] > 0, fuel_used / df["odometer_delta"], 0.0),
        index=df.index,
        dtype=float,
    )
    fallback_fuel_rate_per_hour = pd.Series(
        np.where(df["delta_time_sec"] > 0, fuel_used / (df["delta_time_sec"] / 3600.0), 0.0),
        index=df.index,
        dtype=float,
    )
    df["fuel_per_km"] = source_fuel_per_km.fillna(fallback_fuel_per_km)
    df["fuel_rate_per_hour"] = source_fuel_rate_per_hour.fillna(fallback_fuel_rate_per_hour)
    df["distance_per_fuel"] = np.where(fuel_used > 0, df["odometer_delta"] / fuel_used, 0.0)

    # Slope: road-grade percentage derived from GPS altitude
    # device-side GPS altitude is plumbed through the telemetry pipeline.
    altitude_delta_m = grouped["altitude_m"].transform(
        lambda s: pd.to_numeric(s, errors="coerce").ffill().diff().fillna(0.0)
    )
    horizontal_m = (df["odometer_delta_filtered"] * 1000.0).clip(lower=1e-3)
    df["slope_pct"] = np.where(
        df["odometer_delta_filtered"] > 1e-6,
        (altitude_delta_m / horizontal_m * 100.0).clip(-30.0, 30.0),
        0.0,
    ).astype(float)
    df["slope_pct"] = df["slope_pct"].fillna(0.0)

    # Load proxy: relative fuel consumption compared to the per-trip mean
    # to the trip mean gives a dimensionless load indicator (1.0 = trip-average).
    # Current simulation data produces meaningful variance here even without
    trip_mean_fpk = grouped["fuel_per_km"].transform("mean")
    df["load_proxy"] = np.where(
        trip_mean_fpk > 1e-6,
        df["fuel_per_km"].clip(lower=0.0) / (trip_mean_fpk + 1e-9),
        1.0,
    ).astype(float)
    df["load_proxy"] = df["load_proxy"].clip(0.1, 5.0).fillna(1.0)

    # Categorical context labels for slope and load
    df["slope_bin"] = df["slope_pct"].apply(_slope_bin)
    df["load_level"] = df["load_proxy"].apply(_load_level)

    df["speed_delta"] = (df["speed_filtered"] - prev_speed).fillna(0.0)
    df["acceleration_kmph_per_sec"] = np.where(df["delta_time_sec"] > 0, df["speed_delta"] / df["delta_time_sec"], 0.0)
    df["speed_variability"] = grouped["speed_filtered"].transform(lambda s: s.rolling(window=moving_window, min_periods=1).std()).fillna(0.0)
    df["idle_flag"] = ((df["speed_filtered"] <= 3.0) & df["engine_status"].isin(["on", "idle"])).astype(int)
    df["harsh_accel_flag"] = (df["acceleration_kmph_per_sec"] >= 2.5).astype(int)
    df["harsh_brake_flag"] = (df["acceleration_kmph_per_sec"] <= -3.0).astype(int)
    df["driver_behavior_score"] = (
        df["harsh_accel_flag"] + df["harsh_brake_flag"] + (df["speed_variability"] >= 12.0).astype(int)
    ).astype(float)

    if "start_time" in df.columns:
        df["trip_elapsed_sec"] = (df["timestamp"] - df["start_time"]).dt.total_seconds().fillna(0.0).clip(lower=0.0)
    else:
        df["trip_elapsed_sec"] = grouped["delta_time_sec"].cumsum()
    df["trip_elapsed_hours"] = df["trip_elapsed_sec"] / 3600.0

    if "operating_hours" in df.columns:
        df["operating_hours"] = pd.to_numeric(df["operating_hours"], errors="coerce")
    else:
        df["operating_hours"] = np.nan

    session_duration_sec = np.where(
        df["operating_hours"].notna(),
        df["operating_hours"].clip(lower=0.0) * 3600.0,
        grouped["trip_elapsed_sec"].transform("max"),
    )
    df["route_progress"] = np.where(session_duration_sec > 0, df["trip_elapsed_sec"] / session_duration_sec, 0.0)
    df["route_progress"] = np.clip(df["route_progress"], 0.0, 1.0)
    df["route_segment_index"] = pd.cut(
        df["route_progress"],
        bins=[-0.01, 0.33, 0.66, 1.01],
        labels=[0, 1, 2],
        include_lowest=True,
    ).astype(int)
    df["route_segment_label"] = df["route_segment_index"].map({0: "start", 1: "mid", 2: "end"}).astype(str)
    df["route_segment_performance"] = (
        df.groupby(group_cols + ["route_segment_index"], dropna=False)["fuel_per_km"]
        .transform("mean")
        .fillna(0.0)
    )

    df["hour_of_day"] = df["timestamp"].dt.hour
    df["time_of_day_bucket"] = df["hour_of_day"].map(_time_bucket)
    df["driver_behavior_context"] = df["driver_behavior_score"].map(_behavior_context)

    # Derive route_type_code EARLY so build_context_key can reference it.
    # Barbado A.1 categorical: route_type ? {city, highway, combined}.
    _trip_mean_speed_for_ctx = grouped["speed_filtered"].transform("mean")
    df["route_type_code"] = np.where(
        _trip_mean_speed_for_ctx > 60.0, 2.0,
        np.where(_trip_mean_speed_for_ctx < 25.0, 0.0, 1.0),
    )
    df["trip_duration_min"] = grouped["trip_elapsed_sec"].transform("max") / 60.0
    df["trip_length_band"] = pd.cut(
        df["trip_duration_min"],
        bins=TRIP_DURATION_BINS,
        labels=TRIP_DURATION_LABELS,
        include_lowest=True,
    ).astype(str)
    df["trip_source_category"] = df.apply(
        lambda row: normalize_trip_source_category(row.get("source_dataset"), row.get("record_origin")),
        axis=1,
    )
    df["evaluation_subset"] = np.select(
        [
            df["trip_source_category"].eq("public_route"),
            df["is_injected"].astype(bool),
        ],
        [
            "public_clean",
            "project_native_injected",
        ],
        default="project_native_clean",
    )
    df["source_threshold_key"] = df["trip_source_category"].astype(str) + "|" + df["trip_length_band"].astype(str)
    df["context_key"] = df.apply(
        lambda row: build_context_key(
            row["hour_of_day"],
            row["route_segment_index"],
            row["driver_behavior_score"],
            row.get("route_type_code"),
        ),
        axis=1,
    )
    df["threshold_context_key"] = df.apply(
        lambda row: build_threshold_context_key(row["trip_source_category"], row["trip_length_band"], row["context_key"]),
        axis=1,
    )
    df["telemetry_sync_ok"] = (
        df[["timestamp", "fuel_level_filtered", "lat", "lon"]].notna().all(axis=1)
    ).astype(bool)
    df["sequence_id"] = df["truck_id"] + "::" + df["trip_id"]
    df["fuel_level"] = df["fuel_level"].fillna(0.0)
    df["fuel_rate_per_hour"] = df["fuel_rate_per_hour"].replace([np.inf, -np.inf], np.nan).fillna(0.0)
    df["distance_per_fuel"] = df["distance_per_fuel"].replace([np.inf, -np.inf], np.nan).fillna(0.0)
    df["route_segment_performance"] = df["route_segment_performance"].replace([np.inf, -np.inf], np.nan).fillna(0.0)
    df[FEATURE_COLUMNS] = df[FEATURE_COLUMNS].replace([np.inf, -np.inf], np.nan).fillna(0.0)

    # Extended OBD2 features
    rpm_norm = (pd.to_numeric(df["engine_rpm"], errors="coerce").fillna(0.0) / 4000.0).clip(0.0, 1.0)
    load_norm = (pd.to_numeric(df["engine_load_pct"], errors="coerce").fillna(0.0) / 100.0).clip(0.0, 1.0)
    throttle_norm = (pd.to_numeric(df["throttle_pct"], errors="coerce").fillna(0.0) / 100.0).clip(0.0, 1.0)

    df["engine_rpm_normalized"] = rpm_norm
    df["engine_load_pct_norm"]  = load_norm
    df["throttle_pct_norm"]     = throttle_norm

    # Fuel drop while stationary: |fuel_delta| when speed < 5 km/h
    df["fuel_drop_while_stationary"] = np.where(
        df["speed_filtered"] < 5.0,
        (-df["fuel_delta"]).clip(lower=0.0),
        0.0,
    )

    # Fuel drop with engine reported as idle/off
    engine_off_mask = df["engine_status"].isin(["idle", "off"])
    df["fuel_drop_with_engine_off"] = np.where(
        engine_off_mask,
        (-df["fuel_delta"]).clip(lower=0.0),
        0.0,
    )

    df["idle_duration_score"] = (
        grouped["idle_flag"].transform(lambda s: s.rolling(window=5, min_periods=1).sum()).fillna(0.0)
    )

    # Fuel efficiency ratios normalised by RPM and load
    df["fuel_drop_per_rpm"]  = df["fuel_per_km"] / (rpm_norm  + 1e-6)
    df["fuel_drop_per_load"] = df["fuel_per_km"] / (load_norm + 1e-6)

    ext_cols = [c for c in EXTENDED_FEATURE_COLUMNS if c not in FEATURE_COLUMNS]
    df[ext_cols] = df[ext_cols].replace([np.inf, -np.inf], np.nan).fillna(0.0)

    # Distance fusion features (Model C)
    # DistanceCorrectionModel when available; falls back to complementary
    try:
        from distance_fusion import GPSOBDFusion  # local import avoids circular deps at module level
        _fuser = GPSOBDFusion.with_saved_model()
        df = _fuser.fuse_series(df)
        # Rename internal heading columns to avoid clutter in exported CSVs
        if "_heading_deg" in df.columns:
            df = df.drop(columns=["_heading_deg"], errors="ignore")
    except Exception:
        # Fusion not available (distance_corrector.pkl not trained yet) -- fill with OBD estimate
        df["distance_obd_delta"] = np.where(
            df["delta_time_sec"] > 0,
            df["speed_filtered"].clip(lower=0) * df["delta_time_sec"] / 3600.0,
            0.0,
        )
        df["distance_gps_delta"] = df["odometer_delta_filtered"]
        df["distance_fused_delta"] = df["distance_obd_delta"]
        df["distance_disagreement_norm"] = 0.0  # no GPS divergence signal when fusion offline
        df["distance_obd_residual"]      = 0.0  # no correction when fusion offline
        df["gps_confidence"]             = 0.0  # explicit: unknown trust
        df["_heading_change_deg"]        = 0.0

    full_cols = [c for c in FULL_FEATURE_COLUMNS if c not in EXTENDED_FEATURE_COLUMNS]
    for c in full_cols:
        if c not in df.columns:
            df[c] = 0.0
    df[full_cols] = df[full_cols].replace([np.inf, -np.inf], np.nan).fillna(0.0)

    # Model D context features
    # All derived per (truck_id, trip_id) so refuel/state windows never cross

    #   * PARKED (0):    speed < 1 km/h AND engine_status in {idle, off}
    #   * IDLE (1):      speed < 5 km/h AND engine_status == 'on'
    #   * CRUISE (2):    everything else (moving, light load)
    # only in PARKED, fuel-drops during HIGH_LOAD treated as consumption.
    speed_f = df["speed_filtered"].fillna(0.0)
    eng_off = df["engine_status"].isin(["idle", "off"])
    motion_state = np.where(
        (speed_f < 1.0) & eng_off,
        0,
        np.where(
            speed_f < 5.0,
            1,
            np.where(
                (df["engine_load_pct_norm"] >= 0.5) | (df["throttle_pct_norm"] >= 0.25),
                3,
                2,
            ),
        ),
    )
    df["motion_state_code"] = motion_state.astype(float)

    refuel_mask = df["fuel_delta"] >= 5.0
    refuel_ts = df["timestamp"].where(refuel_mask)
    last_refuel_per_row = (
        refuel_ts.groupby([df["truck_id"], df["trip_id"]], dropna=False)
                 .ffill()
    )
    last_refuel_per_row.index = df.index
    seconds_since = (df["timestamp"] - last_refuel_per_row).dt.total_seconds()
    df["_time_since_refuel_sec_raw"] = seconds_since.fillna(99999.0)
    df["time_since_refuel_norm"] = (df["_time_since_refuel_sec_raw"] / 600.0).clip(0.0, 1.0)
    df["post_refuel_flag"] = (df["_time_since_refuel_sec_raw"] <= 300.0).astype(float)

    # Deltaengine_load_norm and Deltathrottle_norm -- per-trip diff, clipped.
    df["delta_engine_load_norm"] = (
        grouped["engine_load_pct_norm"].diff().fillna(0.0).clip(-1.0, 1.0)
    )
    df["delta_throttle_norm"] = (
        grouped["throttle_pct_norm"].diff().fillna(0.0).clip(-1.0, 1.0)
    )

    speed_norm = (df["speed_filtered"].fillna(0.0) / 80.0).clip(0.0, 1.5)
    df["load_per_speed_norm"] = (
        (df["engine_load_pct_norm"] / (speed_norm + 0.1)).clip(0.0, 5.0)
    )

    trip_mean_fpk2 = grouped["fuel_per_km"].transform("mean").replace(0.0, np.nan)
    df["expected_consumption_residual"] = (
        (df["fuel_per_km"] - trip_mean_fpk2).fillna(0.0)
    )

    df = df.drop(columns=["_time_since_refuel_sec_raw"], errors="ignore")

    ctx_cols = [c for c in CONTEXT_FEATURE_COLUMNS if c not in FULL_FEATURE_COLUMNS]
    for c in ctx_cols:
        if c not in df.columns:
            df[c] = 0.0
    df[ctx_cols] = df[ctx_cols].replace([np.inf, -np.inf], np.nan).fillna(0.0)

    # Model E features (Barbado A.1 driving zones + Habib KMPL deviation)
    # Their FAR aggregates driving-behaviour over a day; we apply per-trip
    # rolling shares so the signal is available at row-time for streaming
    # (up to and including the current row) that satisfied the predicate.
    rpm_raw   = pd.to_numeric(df["engine_rpm"], errors="coerce").fillna(0.0)
    speed_for_zones = df["speed_filtered"].fillna(0.0)

    rpm_high_flag   = ((rpm_raw >= 1900) & (rpm_raw < 3500)).astype(float)
    rpm_red_flag    = ((rpm_raw >= 3500) & (speed_for_zones <  40)).astype(float)
    rpm_orange_flag = ((rpm_raw >= 3500) & (speed_for_zones >= 40) & (speed_for_zones < 80)).astype(float)
    rpm_yellow_flag = ((rpm_raw >= 3500) & (speed_for_zones >= 80)).astype(float)
    speed_90_flag   = (speed_for_zones >  90).astype(float)
    speed_120_flag  = (speed_for_zones > 120).astype(float)

    def _expanding_share(series: pd.Series) -> pd.Series:
        return series.groupby([df["truck_id"], df["trip_id"]]).expanding().mean().reset_index(level=[0, 1], drop=True)

    df["rpm_high_share"]      = _expanding_share(rpm_high_flag).fillna(0.0).clip(0.0, 1.0)
    df["rpm_red_share"]       = _expanding_share(rpm_red_flag).fillna(0.0).clip(0.0, 1.0)
    df["rpm_orange_share"]    = _expanding_share(rpm_orange_flag).fillna(0.0).clip(0.0, 1.0)
    df["rpm_yellow_share"]    = _expanding_share(rpm_yellow_flag).fillna(0.0).clip(0.0, 1.0)
    df["speed_over_90_share"] = _expanding_share(speed_90_flag).fillna(0.0).clip(0.0, 1.0)
    df["speed_over_120_share"]= _expanding_share(speed_120_flag).fillna(0.0).clip(0.0, 1.0)

    # IF's StandardScaler from being dragged by zero-baseline divides.
    truck_mean_fpk = df.groupby("truck_id", dropna=False)["fuel_per_km"].transform("mean")
    safe_truck_mean = truck_mean_fpk.replace(0.0, np.nan)
    df["kmpl_deviation_pct"] = (
        ((df["fuel_per_km"] - truck_mean_fpk) / (safe_truck_mean.abs() + 1e-6))
        .clip(-2.0, 2.0)
        .fillna(0.0)
    )

    if "driver_id" in df.columns:
        driver_mean_fpk = df.groupby("driver_id", dropna=False)["fuel_per_km"].transform("mean")
        safe_driver_mean = driver_mean_fpk.replace(0.0, np.nan)
        df["driver_kmpl_deviation_pct"] = (
            ((df["fuel_per_km"] - driver_mean_fpk) / (safe_driver_mean.abs() + 1e-6))
            .clip(-2.0, 2.0)
            .fillna(0.0)
        )
    else:
        df["driver_kmpl_deviation_pct"] = 0.0


    ctx2_cols = [c for c in CONTEXT_FEATURE_COLUMNS_V2 if c not in CONTEXT_FEATURE_COLUMNS]
    for c in ctx2_cols:
        if c not in df.columns:
            df[c] = 0.0
    df[ctx2_cols] = df[ctx2_cols].replace([np.inf, -np.inf], np.nan).fillna(0.0)

    return df.reset_index(drop=True)


def split_by_trip(
    frame: pd.DataFrame,
    train_ratio: float = 0.6,
    val_ratio: float = 0.2,
    trip_sessions: pd.DataFrame | None = None,
) -> dict[str, pd.DataFrame]:
    if frame.empty:
        raise ValueError("No trip data available for splitting.")

    frame_trips = frame[["truck_id", "trip_id", "timestamp", "trip_source_category"]].copy()
    trip_meta = frame_trips[["truck_id", "trip_id", "trip_source_category"]].drop_duplicates()
    fallback = frame.groupby(["truck_id", "trip_id"], dropna=False)["timestamp"].min().reset_index(name="frame_start_time")
    trip_meta = trip_meta.merge(fallback, on=["truck_id", "trip_id"], how="left")
    if trip_sessions is not None and not trip_sessions.empty and {"id", "start_time"}.issubset(trip_sessions.columns):
        ordering = trip_meta.merge(trip_sessions[["id", "start_time"]], left_on="trip_id", right_on="id", how="left").drop(columns=["id"])
        ordering["sort_time"] = ordering["start_time"].fillna(ordering["frame_start_time"])
    else:
        ordering = trip_meta.copy()
        ordering["sort_time"] = ordering["frame_start_time"]

    def _allocate(keys: list[tuple[str, str]]) -> tuple[set[tuple[str, str]], set[tuple[str, str]], set[tuple[str, str]]]:
        total = len(keys)
        if total == 0:
            return set(), set(), set()
        if total == 1:
            return {keys[0]}, set(), set()
        if total == 2:
            return {keys[0]}, set(), {keys[1]}

        train_cut = max(1, int(round(total * train_ratio)))
        val_cut = int(round(total * val_ratio))
        test_cut = total - train_cut - val_cut

        if test_cut <= 0:
            test_cut = 1
            train_cut = max(1, train_cut - 1)
        if val_cut <= 0 and total >= 3:
            val_cut = 1
            if train_cut > test_cut:
                train_cut = max(1, train_cut - 1)
            else:
                test_cut = max(1, test_cut - 1)

        while train_cut + val_cut + test_cut > total:
            if train_cut >= max(val_cut, test_cut) and train_cut > 1:
                train_cut -= 1
            elif val_cut > 0:
                val_cut -= 1
            else:
                test_cut -= 1
        while train_cut + val_cut + test_cut < total:
            train_cut += 1

        train = set(keys[:train_cut])
        val = set(keys[train_cut : train_cut + val_cut])
        test = set(keys[train_cut + val_cut :])
        if not test:
            moved = sorted(train or val)[-1]
            if moved in train:
                train.remove(moved)
            elif moved in val:
                val.remove(moved)
            test.add(moved)
        return train, val, test

    train_keys: set[tuple[str, str]] = set()
    val_keys: set[tuple[str, str]] = set()
    test_keys: set[tuple[str, str]] = set()
    for _, group in ordering.groupby("trip_source_category", dropna=False):
        trip_order = list(group.sort_values(["sort_time", "truck_id", "trip_id"])[["truck_id", "trip_id"]].itertuples(index=False, name=None))
        train_part, val_part, test_part = _allocate(trip_order)
        train_keys |= train_part
        val_keys |= val_part
        test_keys |= test_part

    def _pick(keys: set[tuple[str, str]]) -> pd.DataFrame:
        if not keys:
            return frame.iloc[0:0].copy()
        mask = frame.apply(lambda row: (row["truck_id"], row["trip_id"]) in keys, axis=1)
        return frame.loc[mask].copy().reset_index(drop=True)

    return {
        "train": _pick(train_keys),
        "validation": _pick(val_keys),
        "test": _pick(test_keys),
    }


def save_split_outputs(splits: dict[str, pd.DataFrame], stem: str = "telemetry") -> dict[str, Path]:
    ensure_directories()
    saved: dict[str, Path] = {}
    for split_name, split_frame in splits.items():
        path = PROCESSED_DIR / f"{stem}_{split_name}.csv"
        split_frame.to_csv(path, index=False)
        saved[split_name] = path
    return saved


def _cli() -> None:
    parser = argparse.ArgumentParser(description="Preprocess the canonical thesis telemetry datasets")
    parser.add_argument(
        "--dataset",
        choices=["cleaned", "evaluation"],
        default="cleaned",
        help="Which canonical dataset to preprocess",
    )
    parser.add_argument("--stem", default=None)
    args = parser.parse_args()

    trip_sessions = load_trip_sessions()
    raw = load_cleaned_telemetry() if args.dataset == "cleaned" else load_evaluation_dataset()
    processed = engineer_features(raw, trip_sessions=trip_sessions)
    stem = args.stem or ("cleaned_telemetry" if args.dataset == "cleaned" else "evaluation_dataset")
    saved = save_split_outputs(split_by_trip(processed, trip_sessions=trip_sessions), stem=stem)
    for name, path in saved.items():
        print(f"{name}: {path}")


if __name__ == "__main__":
    _cli()
