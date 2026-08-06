"""Build Supabase-aligned telemetry datasets for ML, simulation, and demo use."""

from __future__ import annotations

import argparse
import json
import math
import uuid
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import pandas as pd


BASE_DIR = Path(__file__).resolve().parent
SIM_LOG_DIR = BASE_DIR.parent / "simulation" / "logs"
DATA_DIR = BASE_DIR / "data"
OUTPUT_DIR = BASE_DIR / "outputs" / "datasets"
NAMESPACE = uuid.UUID("7b0e7f1d-9e8d-40d7-9a1b-29e3097f3a7d")
GEOLIFE_ZIP_PATH = DATA_DIR / "geolife_trajectories_1_3.zip"
PUBLIC_DEMO_BASE_START = pd.Timestamp("2026-02-01T00:00:00Z")
PUBLIC_MODE_TARGETS = {"bus": 24, "car": 42, "taxi": 18}
PUBLIC_DURATION_BANDS = ["short", "medium", "long"]
PUBLIC_MAX_TRIPS_PER_USER = 14
PUBLIC_MAX_TRIPS_PER_USER_PER_MODE = 6
GEOLIFE_MEDIAN_GAP_SEC_LIMIT = 30.0
GEOLIFE_P95_GAP_SEC_LIMIT = 120.0
GEOLIFE_GAP_OVER_30_RATIO_LIMIT = 0.30


TRUCKS = [
    {
        "id": "11111111-0000-0000-0000-000000000001",
        "truck_code": "TRK-001",
        "plate_number": "ABC-1234",
        "model": "Isuzu Elf NHR 2020",
        "status": "active",
    },
    {
        "id": "11111111-0000-0000-0000-000000000002",
        "truck_code": "TRK-002",
        "plate_number": "DEF-5678",
        "model": "Mitsubishi Fuso 2019",
        "status": "idle",
    },
    {
        "id": "11111111-0000-0000-0000-000000000003",
        "truck_code": "TRK-003",
        "plate_number": "GHI-9012",
        "model": "Hino 300 Series 2021",
        "status": "maintenance",
    },
    {
        "id": "11111111-0000-0000-0000-000000000004",
        "truck_code": "TRK-004",
        "plate_number": "JKL-3456",
        "model": "Isuzu NLR 2022",
        "status": "low_fuel",
    },
]

DRIVERS = [
    {
        "id": "22222222-0000-0000-0000-000000000002",
        "full_name": "Juan Dela Cruz",
        "username": "juan",
        "role": "driver",
        "assigned_truck_id": "11111111-0000-0000-0000-000000000001",
        "is_active": True,
    },
    {
        "id": "22222222-0000-0000-0000-000000000003",
        "full_name": "Maria Santos",
        "username": "maria",
        "role": "driver",
        "assigned_truck_id": "11111111-0000-0000-0000-000000000002",
        "is_active": True,
    },
    {
        "id": "22222222-0000-0000-0000-000000000004",
        "full_name": "Roberto Garcia",
        "username": "roberto",
        "role": "driver",
        "assigned_truck_id": "11111111-0000-0000-0000-000000000003",
        "is_active": True,
    },
    {
        "id": "22222222-0000-0000-0000-000000000005",
        "full_name": "Ana Reyes",
        "username": "ana",
        "role": "driver",
        "assigned_truck_id": "11111111-0000-0000-0000-000000000004",
        "is_active": True,
    },
]

PRIMARY_DRIVER_BY_TRUCK = {row["assigned_truck_id"]: row["id"] for row in DRIVERS}
ALERT_SEVERITY = {
    "sudden_fuel_drop": "high",
    "gradual_leak": "medium",
    "abnormal_rapid_decrease": "high",
}


def deterministic_uuid(*parts: object) -> str:
    token = "::".join("" if part is None else str(part) for part in parts)
    return str(uuid.uuid5(NAMESPACE, token))


def ensure_output_dir() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def haversine_km(lat1: np.ndarray, lon1: np.ndarray, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    lat1 = np.radians(lat1.astype(float))
    lon1 = np.radians(lon1.astype(float))
    lat2 = np.radians(lat2.astype(float))
    lon2 = np.radians(lon2.astype(float))
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2.0) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2.0) ** 2
    return 6371.0 * 2.0 * np.arctan2(np.sqrt(a), np.sqrt(1.0 - a))


def shift_trip_to_demo_calendar(trip: pd.DataFrame, trip_number: int) -> pd.DataFrame:
    frame = trip.copy()
    original_start = frame["timestamp"].iloc[0]
    day_offset = trip_number // 4
    slot_hours = [6, 10, 14, 18][trip_number % 4]
    target_start = PUBLIC_DEMO_BASE_START + pd.Timedelta(days=day_offset, hours=slot_hours)
    frame["timestamp"] = target_start + (frame["timestamp"] - original_start)
    return frame


def load_project_simulation_logs() -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for csv_path in sorted(SIM_LOG_DIR.glob("*.csv")):
        frame = pd.read_csv(csv_path)
        if frame.empty:
            continue
        frame["source_file"] = csv_path.name
        frames.append(frame)
    if not frames:
        raise FileNotFoundError("No non-empty simulation log CSVs were found.")
    return pd.concat(frames, ignore_index=True)


def standardize_project_telemetry(raw: pd.DataFrame) -> pd.DataFrame:
    df = raw.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=["timestamp"]).copy()
    df["trip_id"] = df["trip_id"].replace({"nan": np.nan, "None": np.nan}).where(lambda s: s.notna(), np.nan)
    df["raw_trip_id"] = df["trip_id"]
    df["truck_id"] = df["truck_id"].astype(str)
    df["fuel_level"] = pd.to_numeric(df["fuel_level"], errors="coerce").clip(lower=0.0, upper=100.0)
    df["speed"] = pd.to_numeric(df["speed"], errors="coerce").fillna(0.0).clip(lower=0.0)
    df["odometer_km"] = pd.to_numeric(df["odometer_km"], errors="coerce")
    df["lat"] = pd.to_numeric(df["lat"], errors="coerce")
    df["lon"] = pd.to_numeric(df["lon"], errors="coerce")
    df["latency_ms"] = pd.to_numeric(df["latency_ms"], errors="coerce")
    df["is_anomaly"] = df["is_anomaly"].fillna(False).astype(bool)
    df["anomaly_type"] = df["anomaly_type"].fillna("normal").astype(str)
    return df.sort_values(["source_file", "truck_id", "timestamp"]).reset_index(drop=True)


def assign_trip_ids(df: pd.DataFrame, gap_minutes: int = 15) -> pd.DataFrame:
    frame = df.copy()
    original_mask = frame["raw_trip_id"].notna()
    frame.loc[original_mask, "trip_id"] = frame.loc[original_mask].apply(
        lambda row: deterministic_uuid("source_trip", row["source_file"], row["truck_id"], row["raw_trip_id"]),
        axis=1,
    )
    frame["trip_id_source"] = np.where(original_mask, "canonicalized_from_original_log", "")
    result_groups: list[pd.DataFrame] = []

    for (_, truck_id), group in frame.groupby(["source_file", "truck_id"], dropna=False):
        group = group.sort_values("timestamp").copy()
        time_gap = group["timestamp"].diff().dt.total_seconds().fillna(0)
        segment = (time_gap > gap_minutes * 60).cumsum().astype(int)

        missing_mask = group["trip_id"].isna()
        for seg_value in sorted(segment[missing_mask].unique().tolist()):
            if math.isnan(seg_value):
                continue
            idx = missing_mask & (segment == seg_value)
            if idx.any():
                generated_trip = deterministic_uuid("project_trip", group["source_file"].iloc[0], truck_id, int(seg_value))
                group.loc[idx, "trip_id"] = generated_trip
                group.loc[idx, "trip_id_source"] = "derived_from_file_and_gap"

        result_groups.append(group)

    return pd.concat(result_groups, ignore_index=True)


def assign_driver_ids(df: pd.DataFrame) -> pd.DataFrame:
    frame = df.copy()
    trip_driver = {}
    for (truck_id, trip_id), group in frame.groupby(["truck_id", "trip_id"], dropna=False):
        trip_driver[(truck_id, trip_id)] = PRIMARY_DRIVER_BY_TRUCK.get(truck_id)
    frame["driver_id"] = frame.apply(lambda row: trip_driver[(row["truck_id"], row["trip_id"])], axis=1)
    frame["driver_id_source"] = "primary_truck_assignment"
    return frame


def add_canonical_fields(df: pd.DataFrame, label_mode: str) -> pd.DataFrame:
    frame = df.copy()
    frame = frame.sort_values(["truck_id", "trip_id", "timestamp"]).reset_index(drop=True)
    frame["engine_status"] = np.where(frame["speed"] < 1.0, "idle", "on")
    frame["speed_kmph"] = frame["speed"]

    prev_fuel = frame.groupby(["truck_id", "trip_id"], dropna=False)["fuel_level"].shift(1)
    prev_odo = frame.groupby(["truck_id", "trip_id"], dropna=False)["odometer_km"].shift(1)
    prev_ts = frame.groupby(["truck_id", "trip_id"], dropna=False)["timestamp"].shift(1)

    frame["delta_time_sec"] = (frame["timestamp"] - prev_ts).dt.total_seconds()
    frame["fuel_delta"] = frame["fuel_level"] - prev_fuel
    frame["odometer_delta"] = frame["odometer_km"] - prev_odo
    frame["fuel_used_pct"] = (-frame["fuel_delta"]).clip(lower=0.0)
    frame["fuel_per_km"] = np.where(frame["odometer_delta"] > 0, frame["fuel_used_pct"] / frame["odometer_delta"], 0.0)
    frame["fuel_rate_per_hour"] = np.where(
        frame["delta_time_sec"] > 0,
        frame["fuel_used_pct"] / (frame["delta_time_sec"] / 3600.0),
        0.0,
    )

    frame["id"] = [
        deterministic_uuid("telemetry", row.source_file, row.truck_id, row.trip_id, row.timestamp.isoformat(), idx)
        for idx, row in frame.reset_index(drop=True).iterrows()
    ]
    frame["record_origin"] = "project_simulation_logs"
    frame["source_dataset"] = "simulation_logs"

    if label_mode == "clean":
        frame["is_injected"] = False
        frame["label_source"] = "clean"
        frame["anomaly_flag"] = False
        frame["anomaly_score"] = np.nan
        frame["model_source"] = pd.NA
        frame["anomaly_type"] = "normal"
        frame["difficulty_tier"] = "normal"
    else:
        if "is_injected" not in frame.columns:
            frame["is_injected"] = False
        if "label_source" not in frame.columns:
            frame["label_source"] = "controlled_injection"
        if "difficulty_tier" not in frame.columns:
            frame["difficulty_tier"] = "normal"
        frame["anomaly_flag"] = frame["is_anomaly"].astype(bool)
        frame["anomaly_score"] = np.nan
        frame["model_source"] = pd.NA

    columns = [
        "id",
        "timestamp",
        "truck_id",
        "driver_id",
        "trip_id",
        "fuel_level",
        "lat",
        "lon",
        "speed",
        "speed_kmph",
        "odometer_km",
        "engine_status",
        "anomaly_flag",
        "anomaly_score",
        "model_source",
        "fuel_delta",
        "odometer_delta",
        "delta_time_sec",
        "fuel_per_km",
        "fuel_rate_per_hour",
        "latency_ms",
        "anomaly_type",
        "raw_trip_id",
        "trip_id_source",
        "driver_id_source",
        "source_dataset",
        "record_origin",
        "label_source",
        "is_injected",
        "difficulty_tier",
        "source_file",
    ]
    return frame[columns]


def inject_controlled_anomalies(clean_df: pd.DataFrame, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    frame = clean_df.copy()
    frame["anomaly_flag"] = False
    frame["anomaly_type"] = "normal"
    frame["label_source"] = "clean"
    frame["is_injected"] = False
    frame["difficulty_tier"] = "normal"

    trip_keys = sorted(frame.groupby(["truck_id", "trip_id"], dropna=False).groups.keys())
    anomaly_cycle = ["sudden_fuel_drop", "gradual_leak", "abnormal_rapid_decrease"]
    anomaly_idx = 0
    hard_anomaly_idx = 0

    for trip_number, (truck_id, trip_id) in enumerate(trip_keys):
        # Every odd-indexed trip becomes anomalous; alternating odd trips
        # tiers see comparable trip-count and class coverage.
        if trip_number % 2 == 0:
            continue
        # Within the odd-indexed pool, alternate easy/hard.
        is_easy_tier = ((trip_number // 2) % 2) == 0
        tier_label = "easy" if is_easy_tier else "hard"

        mask = (frame["truck_id"] == truck_id) & (frame["trip_id"] == trip_id)
        group = frame.loc[mask].sort_values("timestamp").copy()
        if len(group) < 8:
            continue

        start_at = int(rng.integers(max(2, len(group) // 3), max(3, len(group) - 3)))
        if is_easy_tier:
            anomaly_name = anomaly_cycle[anomaly_idx % len(anomaly_cycle)]
            anomaly_idx += 1
        else:
            anomaly_name = anomaly_cycle[hard_anomaly_idx % len(anomaly_cycle)]
            hard_anomaly_idx += 1

        if anomaly_name == "sudden_fuel_drop":
            magnitude = float(rng.uniform(10.0, 18.0)) if is_easy_tier else float(rng.uniform(3.0, 6.0))
            frame.loc[group.index[start_at:], "fuel_level"] = (
                frame.loc[group.index[start_at:], "fuel_level"] - magnitude
            ).clip(lower=0.0)
            frame.loc[group.index[start_at], "anomaly_flag"] = True
            frame.loc[group.index[start_at], "anomaly_type"] = anomaly_name
            frame.loc[group.index[start_at:], "label_source"] = "controlled_injection"
            frame.loc[group.index[start_at:], "is_injected"] = True
            frame.loc[group.index[start_at:], "difficulty_tier"] = tier_label
        elif anomaly_name == "gradual_leak":
            leak_per_step = float(rng.uniform(0.18, 0.35)) if is_easy_tier else float(rng.uniform(0.05, 0.12))
            steps = np.arange(len(group) - start_at, dtype=float) + 1.0
            frame.loc[group.index[start_at:], "fuel_level"] = (
                frame.loc[group.index[start_at:], "fuel_level"] - steps * leak_per_step
            ).clip(lower=0.0)
            frame.loc[group.index[start_at:], "anomaly_flag"] = True
            frame.loc[group.index[start_at:], "anomaly_type"] = anomaly_name
            frame.loc[group.index[start_at:], "label_source"] = "controlled_injection"
            frame.loc[group.index[start_at:], "is_injected"] = True
            frame.loc[group.index[start_at:], "difficulty_tier"] = tier_label
        else:
            per_step = float(rng.uniform(1.0, 2.0)) if is_easy_tier else float(rng.uniform(0.3, 0.7))
            duration = int(rng.integers(3, 6))
            affected = min(duration, len(group) - start_at)
            steps = np.arange(affected, dtype=float) + 1.0
            indices = group.index[start_at : start_at + affected]
            frame.loc[indices, "fuel_level"] = (frame.loc[indices, "fuel_level"] - steps * per_step).clip(lower=0.0)
            if start_at + affected < len(group):
                frame.loc[group.index[start_at + affected :], "fuel_level"] = (
                    frame.loc[group.index[start_at + affected :], "fuel_level"] - steps[-1] * per_step
                ).clip(lower=0.0)
            frame.loc[indices, "anomaly_flag"] = True
            frame.loc[indices, "anomaly_type"] = anomaly_name
            frame.loc[indices, "label_source"] = "controlled_injection"
            frame.loc[indices, "is_injected"] = True
            frame.loc[indices, "difficulty_tier"] = tier_label

    raw_like = frame.rename(columns={"anomaly_flag": "is_anomaly"})
    raw_like["speed"] = raw_like["speed_kmph"]
    return add_canonical_fields(raw_like, label_mode="controlled_injection")


def build_trip_sessions(clean_df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (truck_id, trip_id), group in clean_df.groupby(["truck_id", "trip_id"], dropna=False):
        group = group.sort_values("timestamp")
        start_row = group.iloc[0]
        end_row = group.iloc[-1]
        distance = max(float(end_row["odometer_km"] - start_row["odometer_km"]), 0.0)
        hours = max((end_row["timestamp"] - start_row["timestamp"]).total_seconds() / 3600.0, 0.0)
        rows.append(
            {
                "id": trip_id,
                "truck_id": truck_id,
                "driver_id": start_row["driver_id"],
                "start_time": start_row["timestamp"],
                "end_time": end_row["timestamp"],
                "trip_status": "ended",
                "start_lat": start_row["lat"],
                "start_lon": start_row["lon"],
                "end_lat": end_row["lat"],
                "end_lon": end_row["lon"],
                "distance_km": round(distance, 3),
                "operating_hours": round(hours, 3),
                "trip_source": start_row["source_dataset"],
                "raw_trip_id": start_row["raw_trip_id"],
                "trip_id_source": start_row["trip_id_source"],
            }
        )
    return pd.DataFrame(rows).sort_values(["start_time", "truck_id"]).reset_index(drop=True)


def build_alerts_seed(evaluation_df: pd.DataFrame) -> pd.DataFrame:
    anomaly_rows = evaluation_df[evaluation_df["anomaly_flag"]].copy()
    if anomaly_rows.empty:
        return pd.DataFrame(columns=["id", "truck_id", "driver_id", "trip_id", "timestamp", "alert_type", "message", "severity", "is_resolved"])

    alert_rows = []
    for (truck_id, trip_id), group in anomaly_rows.groupby(["truck_id", "trip_id"], dropna=False):
        first_row = group.sort_values("timestamp").iloc[0]
        anomaly_type = first_row["anomaly_type"]
        message_map = {
            "sudden_fuel_drop": "Controlled sudden fuel drop injected for thesis evaluation.",
            "gradual_leak": "Controlled gradual leak pattern injected for thesis evaluation.",
            "abnormal_rapid_decrease": "Controlled abnormal rapid decrease injected for thesis evaluation.",
        }
        alert_rows.append(
            {
                "id": deterministic_uuid("alert", truck_id, trip_id, first_row["timestamp"].isoformat(), anomaly_type),
                "truck_id": truck_id,
                "driver_id": first_row["driver_id"],
                "trip_id": trip_id,
                "timestamp": first_row["timestamp"],
                "alert_type": "fuel_anomaly",
                "message": message_map.get(anomaly_type, "Controlled fuel anomaly injected for evaluation."),
                "severity": ALERT_SEVERITY.get(anomaly_type, "medium"),
                "is_resolved": False,
                "alert_origin": "controlled_injection",
            }
        )
    return pd.DataFrame(alert_rows).sort_values(["timestamp", "truck_id"]).reset_index(drop=True)


def build_public_vehicle_telematics() -> pd.DataFrame:
    path = DATA_DIR / "vehicle_telematics.csv"
    df = pd.read_csv(path)
    df["timestamp"] = pd.to_datetime(df["timeStamp"], dayfirst=True, errors="coerce")
    df = df.dropna(subset=["timestamp"]).copy()
    df["duplicate_idx"] = df.groupby(["deviceID", "tripID", "timestamp"]).cumcount()
    df["timestamp"] = df["timestamp"] + pd.to_timedelta(df["duplicate_idx"] * 5, unit="s")
    df["speed"] = pd.to_numeric(df["speed"], errors="coerce").fillna(pd.to_numeric(df["gps_speed"], errors="coerce")).fillna(0.0)
    df["truck_id"] = df["deviceID"].apply(lambda v: deterministic_uuid("public_vehicle", v))
    df["trip_id_canonical"] = df.apply(lambda row: deterministic_uuid("public_vehicle_trip", row["deviceID"], row["tripID"]), axis=1)
    df["driver_id"] = pd.NA
    df = df.sort_values(["deviceID", "tripID", "timestamp"]).reset_index(drop=True)

    prev_ts = df.groupby(["deviceID", "tripID"])["timestamp"].shift(1)
    df["delta_time_sec"] = (df["timestamp"] - prev_ts).dt.total_seconds().fillna(5.0)
    df.loc[df["delta_time_sec"] <= 0, "delta_time_sec"] = 5.0
    df["odometer_delta"] = df["speed"] * df["delta_time_sec"] / 3600.0
    df["odometer_km"] = df.groupby(["deviceID", "tripID"])["odometer_delta"].cumsum()

    kpl = pd.to_numeric(df["kpl"], errors="coerce")
    df["fuel_per_km_l"] = np.where(kpl > 0, 1.0 / kpl, np.nan)
    df["fuel_rate_per_hour_l"] = np.where(kpl > 0, df["speed"] / kpl, np.nan)
    df["fuel_per_km_pct"] = df["fuel_per_km_l"] / 60.0 * 100.0
    df["fuel_rate_per_hour_pct"] = df["fuel_rate_per_hour_l"] / 60.0 * 100.0
    df["fuel_delta_pct"] = -(df["odometer_delta"] * df["fuel_per_km_pct"])
    df["fuel_level"] = 100.0 + df.groupby(["deviceID", "tripID"])["fuel_delta_pct"].cumsum().fillna(0.0)
    df["fuel_level"] = df["fuel_level"].clip(lower=0.0, upper=100.0)
    df["engine_status"] = np.where(df["speed"] < 1.0, "idle", "on")

    return pd.DataFrame(
        {
            "timestamp": df["timestamp"],
            "truck_id": df["truck_id"],
            "driver_id": df["driver_id"],
            "trip_id": df["trip_id_canonical"],
            "fuel_level": df["fuel_level"],
            "lat": pd.NA,
            "lon": pd.NA,
            "speed": df["speed"],
            "odometer_km": df["odometer_km"],
            "engine_status": df["engine_status"],
            "fuel_delta": df["fuel_delta_pct"],
            "odometer_delta": df["odometer_delta"],
            "fuel_rate_per_hour": df["fuel_rate_per_hour_pct"],
            "fuel_per_km": df["fuel_per_km_pct"],
            "anomaly_flag": False,
            "anomaly_score": np.nan,
            "model_source": pd.NA,
            "source_dataset": "vehicle_telematics_public",
            "record_origin": "public_primary_telemetry",
            "event_label": df["event"].fillna("unknown"),
            "hard_brake_event": df["hard_brake_event"].fillna(False),
            "maf": pd.to_numeric(df["maf"], errors="coerce"),
            "rpm": pd.to_numeric(df["rpm"], errors="coerce"),
            "fuel_per_km_l_raw": df["fuel_per_km_l"],
            "fuel_rate_per_hour_l_raw": df["fuel_rate_per_hour_l"],
            "derivation_note": "fuel features converted to percentage units using a nominal 60 L tank; lat/lon unavailable in source",
        }
    )


def build_aux_fuel_reference() -> pd.DataFrame:
    path = DATA_DIR / "bus_fuel_sensors.csv"
    df = pd.read_csv(path, sep=";")
    df["timestamp"] = pd.to_datetime(df["Date-time"], errors="coerce")
    df = df.dropna(subset=["timestamp"]).copy()
    df["trip_date"] = df["timestamp"].dt.date.astype(str)
    df["truck_id"] = df["VehicleID"].apply(lambda v: deterministic_uuid("public_bus", v))
    df["trip_id"] = df.apply(lambda row: deterministic_uuid("public_bus_trip", row["VehicleID"], row["trip_date"]), axis=1)
    df["speed_est_kmph"] = (1.0 - pd.to_numeric(df["stop_ptime"], errors="coerce").fillna(0.0).clip(0.0, 1.0)) * 35.0
    df["odometer_delta"] = df["speed_est_kmph"] * (6.0 / 60.0)
    df["odometer_km"] = df.groupby(["VehicleID", "trip_date"])["odometer_delta"].cumsum()
    fuel_per_km = pd.to_numeric(df["fuel_per_km"], errors="coerce")
    df["fuel_per_km_pct"] = fuel_per_km / 150.0 * 100.0
    df["fuel_rate_per_hour_pct"] = df["fuel_per_km_pct"] * df["speed_est_kmph"]
    df["fuel_delta_pct"] = -(df["fuel_per_km_pct"] * df["odometer_delta"])
    df["fuel_level"] = 100.0 + df.groupby(["VehicleID", "trip_date"])["fuel_delta_pct"].cumsum().fillna(0.0)
    df["fuel_level"] = df["fuel_level"].clip(lower=0.0, upper=100.0)

    return pd.DataFrame(
        {
            "timestamp": df["timestamp"],
            "truck_id": df["truck_id"],
            "driver_id": pd.NA,
            "trip_id": df["trip_id"],
            "fuel_level": df["fuel_level"],
            "lat": pd.NA,
            "lon": pd.NA,
            "speed": df["speed_est_kmph"],
            "odometer_km": df["odometer_km"],
            "engine_status": np.where(df["speed_est_kmph"] < 1.0, "idle", "on"),
            "fuel_delta": df["fuel_delta_pct"],
            "odometer_delta": df["odometer_delta"],
            "fuel_rate_per_hour": df["fuel_rate_per_hour_pct"],
            "fuel_per_km": df["fuel_per_km_pct"],
            "anomaly_flag": False,
            "anomaly_score": np.nan,
            "model_source": pd.NA,
            "source_dataset": "bus_fuel_sensors_public",
            "record_origin": "public_auxiliary_fuel_reference",
            "avg_slope": pd.to_numeric(df["avg_slope"], errors="coerce"),
            "mass": pd.to_numeric(df["mass"], errors="coerce"),
            "aircond_ptime": pd.to_numeric(df["aircond_ptime"], errors="coerce"),
            "stop_ptime": pd.to_numeric(df["stop_ptime"], errors="coerce"),
            "brake_usage": pd.to_numeric(df["brake_usage"], errors="coerce"),
            "accel": pd.to_numeric(df["accel"], errors="coerce"),
            "fuel_per_km_l_raw": fuel_per_km,
            "derivation_note": "speed and fuel features are controlled heavy-vehicle estimates using a nominal 150 L tank; GPS unavailable in source",
        }
    )


def load_geolife_labels(zf: ZipFile, label_name: str) -> list[tuple[pd.Timestamp, pd.Timestamp, str]]:
    rows: list[tuple[pd.Timestamp, pd.Timestamp, str]] = []
    content = zf.read(label_name).decode("utf-8", errors="ignore").splitlines()
    for line in content[1:]:
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        start = pd.to_datetime(parts[0], errors="coerce", utc=True)
        end = pd.to_datetime(parts[1], errors="coerce", utc=True)
        mode = parts[2].strip().lower()
        if pd.isna(start) or pd.isna(end) or not mode:
            continue
        rows.append((start, end, mode))
    return rows


def load_geolife_trajectory(zf: ZipFile, trajectory_name: str) -> pd.DataFrame:
    lines = zf.read(trajectory_name).decode("utf-8", errors="ignore").splitlines()[6:]
    rows = [line.split(",") for line in lines if line.count(",") >= 6]
    if not rows:
        return pd.DataFrame(columns=["lat", "lon", "timestamp"])
    frame = pd.DataFrame(rows, columns=["lat", "lon", "zero", "altitude_ft", "days", "date", "time"])
    frame["timestamp"] = pd.to_datetime(
        frame["date"] + " " + frame["time"],
        format="%Y-%m-%d %H:%M:%S",
        errors="coerce",
        utc=True,
    )
    frame["lat"] = pd.to_numeric(frame["lat"], errors="coerce")
    frame["lon"] = pd.to_numeric(frame["lon"], errors="coerce")
    frame["altitude_ft"] = pd.to_numeric(frame["altitude_ft"], errors="coerce")
    frame = frame.dropna(subset=["timestamp", "lat", "lon"]).copy()
    frame = frame.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
    return frame[["timestamp", "lat", "lon", "altitude_ft"]]


def scan_geolife_vehicle_candidates() -> pd.DataFrame:
    if not GEOLIFE_ZIP_PATH.exists():
        raise FileNotFoundError(
            f"Expected GeoLife archive at {GEOLIFE_ZIP_PATH}. Download the official non-commercial archive first."
        )

    metadata_rows: list[dict[str, object]] = []
    with ZipFile(GEOLIFE_ZIP_PATH) as zf:
        label_files = sorted(name for name in zf.namelist() if name.endswith("labels.txt"))
        for label_name in label_files:
            user_id = label_name.split("/")[-2]
            labels = load_geolife_labels(zf, label_name)
            if not labels:
                continue

            user_traj_files = sorted(
                name
                for name in zf.namelist()
                if f"/Data/{user_id}/Trajectory/" in name and name.endswith(".plt")
            )
            for traj_name in user_traj_files:
                trip = load_geolife_trajectory(zf, traj_name)
                if len(trip) < 20:
                    continue

                start = trip["timestamp"].iloc[0]
                end = trip["timestamp"].iloc[-1]
                matched_mode = None
                for label_start, label_end, label_mode in labels:
                    if start >= label_start and end <= label_end:
                        matched_mode = label_mode
                        break
                if matched_mode not in {"car", "taxi", "bus"}:
                    continue

                distance_km = haversine_km(
                    trip["lat"].to_numpy()[:-1],
                    trip["lon"].to_numpy()[:-1],
                    trip["lat"].to_numpy()[1:],
                    trip["lon"].to_numpy()[1:],
                )
                delta_hours = (
                    np.diff(trip["timestamp"].astype("int64").to_numpy() / 1_000_000_000.0) / 3600.0
                )
                delta_seconds = delta_hours * 3600.0
                segment_speed = distance_km / np.where(delta_hours > 0, delta_hours, np.nan)
                finite_speed = segment_speed[np.isfinite(segment_speed)]
                finite_dt = delta_seconds[np.isfinite(delta_seconds)]
                median_gap_sec = float(np.nanmedian(finite_dt)) if finite_dt.size else np.nan
                p95_gap_sec = float(np.nanquantile(finite_dt, 0.95)) if finite_dt.size else np.nan
                gap_over_30_ratio = float(np.nanmean(finite_dt > 30.0)) if finite_dt.size else np.nan

                metadata_rows.append(
                    {
                        "user_id": user_id,
                        "trajectory_name": traj_name,
                        "mode": matched_mode,
                        "rows": int(len(trip)),
                        "duration_min": float((end - start).total_seconds() / 60.0),
                        "distance_km": float(np.nansum(distance_km)),
                        "avg_speed_kmph": float(np.nanmean(finite_speed)) if finite_speed.size else 0.0,
                        "max_speed_kmph": float(np.nanmax(finite_speed)) if finite_speed.size else 0.0,
                        "stop_ratio": float(np.nanmean(finite_speed < 8.0)) if finite_speed.size else 0.0,
                        "median_gap_sec": median_gap_sec,
                        "p95_gap_sec": p95_gap_sec,
                        "gap_over_30_ratio": gap_over_30_ratio,
                    }
                )

    candidates = pd.DataFrame(metadata_rows)
    if candidates.empty:
        raise RuntimeError("No labeled GeoLife vehicle trajectories were found.")

    return candidates[
        (candidates["rows"] >= 30)
        & (candidates["duration_min"].between(4.0, 90.0))
        & (candidates["distance_km"].between(1.0, 60.0))
        & (candidates["avg_speed_kmph"].between(10.0, 90.0))
        & (candidates["max_speed_kmph"] <= 120.0)
        & (candidates["median_gap_sec"] <= GEOLIFE_MEDIAN_GAP_SEC_LIMIT)
        & (candidates["p95_gap_sec"] <= GEOLIFE_P95_GAP_SEC_LIMIT)
        & (candidates["gap_over_30_ratio"] <= GEOLIFE_GAP_OVER_30_RATIO_LIMIT)
    ].reset_index(drop=True)


def select_geolife_candidates(candidates: pd.DataFrame) -> pd.DataFrame:
    selected_rows: list[dict[str, object]] = []
    global_user_counts: dict[str, int] = {}

    for mode, target in PUBLIC_MODE_TARGETS.items():
        mode_candidates = candidates[candidates["mode"] == mode].copy()
        if mode_candidates.empty:
            continue

        mode_candidates["duration_band"] = pd.cut(
            mode_candidates["duration_min"],
            bins=[0.0, 12.0, 25.0, 90.0],
            labels=PUBLIC_DURATION_BANDS,
            include_lowest=True,
        )
        mode_candidates["duration_band"] = mode_candidates["duration_band"].astype(str)
        gap_quality = 1.0 - np.clip(mode_candidates["p95_gap_sec"] / GEOLIFE_P95_GAP_SEC_LIMIT, 0.0, 1.0)
        density_quality = 1.0 - np.clip(mode_candidates["gap_over_30_ratio"] / GEOLIFE_GAP_OVER_30_RATIO_LIMIT, 0.0, 1.0)
        stop_balance_quality = 1.0 - np.clip(np.abs(mode_candidates["stop_ratio"] - 0.28) / 0.28, 0.0, 1.0)
        row_quality = np.clip(mode_candidates["rows"] / mode_candidates["rows"].quantile(0.85), 0.0, 1.0)
        mode_candidates["quality_score"] = (
            0.35 * gap_quality + 0.25 * density_quality + 0.20 * stop_balance_quality + 0.20 * row_quality
        )
        mode_candidates = mode_candidates.sort_values(
            ["quality_score", "rows", "distance_km", "user_id", "trajectory_name"],
            ascending=[False, False, False, True, True],
        ).reset_index(drop=True)

        available_by_band = mode_candidates["duration_band"].value_counts().to_dict()
        desired_quota = {
            "short": max(1, int(round(target * 0.25))),
            "medium": max(1, int(round(target * 0.35))),
            "long": max(1, target - max(1, int(round(target * 0.25))) - max(1, int(round(target * 0.35)))),
        }
        quota_by_band: dict[str, int] = {}
        remaining_target = target
        for band in PUBLIC_DURATION_BANDS:
            quota = min(desired_quota.get(band, 0), int(available_by_band.get(band, 0)))
            quota_by_band[band] = quota
            remaining_target -= quota
        while remaining_target > 0:
            expanded = False
            for band in PUBLIC_DURATION_BANDS:
                available = int(available_by_band.get(band, 0))
                if quota_by_band.get(band, 0) >= available:
                    continue
                quota_by_band[band] += 1
                remaining_target -= 1
                expanded = True
                if remaining_target == 0:
                    break
            if not expanded:
                break

        mode_selected: list[dict[str, object]] = []
        mode_user_counts: dict[str, int] = {}
        remaining = mode_candidates.copy()

        def _pick_from_pool(pool: pd.DataFrame) -> pd.Series | None:
            if pool.empty:
                return None
            ranked = pool.assign(
                global_user_count=pool["user_id"].map(lambda user: global_user_counts.get(str(user), 0)),
                mode_user_count=pool["user_id"].map(lambda user: mode_user_counts.get(str(user), 0)),
            ).sort_values(
                ["global_user_count", "mode_user_count", "quality_score", "rows", "distance_km", "trajectory_name"],
                ascending=[True, True, False, False, False, True],
            )
            return ranked.iloc[0]

        for band in PUBLIC_DURATION_BANDS:
            needed = quota_by_band.get(band, 0)
            for _ in range(needed):
                strict_pool = remaining[
                    (remaining["duration_band"] == band)
                    & (remaining["user_id"].map(lambda user: global_user_counts.get(str(user), 0)) < PUBLIC_MAX_TRIPS_PER_USER)
                    & (remaining["user_id"].map(lambda user: mode_user_counts.get(str(user), 0)) < PUBLIC_MAX_TRIPS_PER_USER_PER_MODE)
                ]
                chosen = _pick_from_pool(strict_pool)
                if chosen is None:
                    break
                chosen_dict = chosen.to_dict()
                mode_selected.append(chosen_dict)
                user_id = str(chosen_dict["user_id"])
                global_user_counts[user_id] = global_user_counts.get(user_id, 0) + 1
                mode_user_counts[user_id] = mode_user_counts.get(user_id, 0) + 1
                remaining = remaining[remaining["trajectory_name"] != chosen_dict["trajectory_name"]]

        while len(mode_selected) < target and not remaining.empty:
            strict_pool = remaining[
                (remaining["user_id"].map(lambda user: global_user_counts.get(str(user), 0)) < PUBLIC_MAX_TRIPS_PER_USER)
                & (remaining["user_id"].map(lambda user: mode_user_counts.get(str(user), 0)) < PUBLIC_MAX_TRIPS_PER_USER_PER_MODE)
            ]
            chosen = _pick_from_pool(strict_pool)
            if chosen is None:
                break
            chosen_dict = chosen.to_dict()
            mode_selected.append(chosen_dict)
            user_id = str(chosen_dict["user_id"])
            global_user_counts[user_id] = global_user_counts.get(user_id, 0) + 1
            mode_user_counts[user_id] = mode_user_counts.get(user_id, 0) + 1
            remaining = remaining[remaining["trajectory_name"] != chosen_dict["trajectory_name"]]

        selected_rows.extend(mode_selected)

    selected = pd.DataFrame(selected_rows)
    if selected.empty:
        raise RuntimeError("Unable to select any GeoLife trajectories for the public trip pool.")
    return selected.reset_index(drop=True)


def derive_geolife_fuel_trace(
    trip: pd.DataFrame,
    mode: str,
    trip_number: int,
    public_profile: dict[str, float],
    bus_reference: pd.DataFrame,
    rng: np.random.Generator,
) -> pd.DataFrame:
    frame = trip.copy().sort_values("timestamp").reset_index(drop=True)
    frame = shift_trip_to_demo_calendar(frame, trip_number)
    frame = (
        frame.set_index("timestamp")[["lat", "lon"]]
        .resample("5s")
        .mean()
        .interpolate(method="linear", limit_direction="both")
        .reset_index()
    )
    if len(frame) < 24:
        return frame.iloc[0:0].copy()

    segment_distance = np.concatenate(
        [
            [0.0],
            haversine_km(
                frame["lat"].to_numpy()[:-1],
                frame["lon"].to_numpy()[:-1],
                frame["lat"].to_numpy()[1:],
                frame["lon"].to_numpy()[1:],
            ),
        ]
    )
    delta_hours = np.concatenate(
        [[0.0], np.diff(frame["timestamp"].astype("int64").to_numpy() / 1_000_000_000.0) / 3600.0]
    )
    speed_kmph = np.divide(segment_distance, delta_hours, out=np.zeros_like(segment_distance), where=delta_hours > 0)
    speed_kmph = np.clip(speed_kmph, 0.0, 100.0)
    accel_kmph = np.abs(np.diff(speed_kmph, prepend=speed_kmph[0]))

    bus_fuel_per_km = pd.to_numeric(bus_reference["fuel_per_km"], errors="coerce").dropna()
    quantile_lookup = {"bus": 0.62, "car": 0.48, "taxi": 0.55}
    base_fuel_per_km = float(bus_fuel_per_km.quantile(quantile_lookup.get(mode, 0.55)))
    stop_ratio = float(np.mean(speed_kmph < 8.0))
    speed_multiplier = np.where(speed_kmph < 8.0, 1.10, np.where(speed_kmph > 65.0, 1.06, 1.0))
    accel_multiplier = 1.0 + np.clip(accel_kmph / 40.0, 0.0, 0.12)
    stop_multiplier = 1.0 + np.clip(stop_ratio, 0.0, 0.6) * 0.12
    per_km_pct = base_fuel_per_km * speed_multiplier * accel_multiplier * stop_multiplier
    idle_draw = np.where(
        speed_kmph < 3.0,
        np.interp(stop_ratio, [0.0, 0.6], [public_profile["idle_fuel_drop_min"], public_profile["idle_fuel_drop_max"]]),
        0.0,
    )
    fuel_drop_pct = segment_distance * per_km_pct + idle_draw
    fuel_drop_pct += np.clip(
        rng.normal(0.0, public_profile["whole_trip_fuel_jitter_std"] / 2.0, len(frame)),
        -0.003,
        0.008,
    )
    fuel_drop_pct = np.clip(fuel_drop_pct, 0.0, None)

    start_fuel = float(rng.uniform(62.0, 94.0))
    frame["fuel_level"] = np.clip(start_fuel - np.cumsum(fuel_drop_pct), 0.0, 100.0)
    startup_len = min(len(frame), public_profile["startup_window_min"])
    frame.loc[: startup_len - 1, "fuel_level"] = (
        frame.loc[: startup_len - 1, "fuel_level"]
        + rng.normal(0.0, public_profile["startup_fuel_jitter_std"], startup_len)
    ).clip(lower=0.0, upper=100.0)

    frame["speed"] = speed_kmph
    frame["odometer_km"] = np.cumsum(segment_distance)
    frame["engine_status"] = np.where(frame["speed"] < 1.0, "idle", "on")
    return frame


def build_public_geolife_routes(
    public_profile: dict[str, float],
    bus_reference: pd.DataFrame,
    seed: int = 42,
) -> tuple[pd.DataFrame, dict[str, object]]:
    rng = np.random.default_rng(seed)
    candidates = scan_geolife_vehicle_candidates()
    selected = select_geolife_candidates(candidates)
    selected["duration_band"] = pd.cut(
        selected["duration_min"],
        bins=[0.0, 12.0, 25.0, 90.0],
        labels=PUBLIC_DURATION_BANDS,
        include_lowest=True,
    ).astype(str)

    telemetry_groups: list[pd.DataFrame] = []
    selected_rows: list[dict[str, object]] = []
    with ZipFile(GEOLIFE_ZIP_PATH) as zf:
        for trip_number, row in enumerate(selected.itertuples(index=False), start=1):
            raw_trip = load_geolife_trajectory(zf, row.trajectory_name)
            derived_trip = derive_geolife_fuel_trace(raw_trip, row.mode, trip_number - 1, public_profile, bus_reference, rng)
            if len(derived_trip) < 24:
                continue

            truck_id = deterministic_uuid("public_geolife_truck", row.user_id)
            driver_id = deterministic_uuid("public_geolife_driver", row.user_id)
            trip_id = deterministic_uuid("public_geolife_trip", row.user_id, Path(row.trajectory_name).name)

            derived_trip["id"] = [
                deterministic_uuid("public_geolife_row", trip_id, idx, ts.isoformat())
                for idx, ts in enumerate(derived_trip["timestamp"])
            ]
            derived_trip["truck_id"] = truck_id
            derived_trip["driver_id"] = driver_id
            derived_trip["trip_id"] = trip_id
            derived_trip["anomaly_flag"] = False
            derived_trip["anomaly_score"] = np.nan
            derived_trip["model_source"] = pd.NA
            derived_trip["latency_ms"] = np.nan
            derived_trip["anomaly_type"] = "normal"
            derived_trip["raw_trip_id"] = Path(row.trajectory_name).name
            derived_trip["trip_id_source"] = "mapped_from_public_geolife_labeled_trajectory"
            derived_trip["driver_id_source"] = "mapped_from_public_geolife_user"
            derived_trip["source_dataset"] = "geolife_public_route"
            derived_trip["record_origin"] = "public_geolife_route_derived_fuel"
            derived_trip["label_source"] = "clean_public_route"
            derived_trip["is_injected"] = False
            derived_trip["difficulty_tier"] = "normal"
            derived_trip["source_file"] = row.trajectory_name
            derived_trip["public_user_id"] = row.user_id
            derived_trip["public_mode_label"] = row.mode
            derived_trip["derivation_note"] = (
                "GPS geometry and timestamps come from GeoLife. Truck-style fuel fields are derived "
                "using heavy-vehicle fuel reference ranges and public telemetry-informed startup jitter."
            )

            telemetry_groups.append(recompute_canonical_derivatives(derived_trip))
            selected_rows.append(
                {
                    "trip_id": trip_id,
                    "truck_id": truck_id,
                    "driver_id": driver_id,
                    "public_user_id": row.user_id,
                    "public_mode_label": row.mode,
                    "source_trajectory": row.trajectory_name,
                    "duration_min": round(float(row.duration_min), 3),
                    "distance_km_source": round(float(row.distance_km), 3),
                    "quality_score": round(float(row.quality_score), 6),
                    "duration_band": str(row.duration_band),
                    "median_gap_sec": round(float(row.median_gap_sec), 3),
                    "p95_gap_sec": round(float(row.p95_gap_sec), 3),
                    "gap_over_30_ratio": round(float(row.gap_over_30_ratio), 6),
                }
            )

    if not telemetry_groups:
        raise RuntimeError("GeoLife mapping produced no usable canonical trips.")

    geolife_routes = pd.concat(telemetry_groups, ignore_index=True)
    selected_df = pd.DataFrame(selected_rows)
    per_user_counts = selected_df["public_user_id"].value_counts(dropna=False).to_dict()
    summary = {
        "trip_count": int(geolife_routes["trip_id"].nunique()),
        "row_count": int(len(geolife_routes)),
        "mode_counts": selected_df["public_mode_label"].value_counts(dropna=False).to_dict(),
        "duration_band_counts": selected_df["duration_band"].value_counts(dropna=False).to_dict(),
        "user_count": int(selected_df["public_user_id"].nunique()),
        "max_trips_from_single_public_user": int(max(per_user_counts.values())) if per_user_counts else 0,
        "per_user_trip_count_top10": dict(list(per_user_counts.items())[:10]),
        "quality_constraints": {
            "median_gap_sec_max": GEOLIFE_MEDIAN_GAP_SEC_LIMIT,
            "p95_gap_sec_max": GEOLIFE_P95_GAP_SEC_LIMIT,
            "gap_over_30_ratio_max": GEOLIFE_GAP_OVER_30_RATIO_LIMIT,
            "max_trips_per_user": PUBLIC_MAX_TRIPS_PER_USER,
            "max_trips_per_user_per_mode": PUBLIC_MAX_TRIPS_PER_USER_PER_MODE,
        },
        "selected_quality_score_summary": selected_df["quality_score"].describe().round(6).to_dict(),
        "source": "GeoLife Trajectories 1.3",
        "license_note": "Microsoft Research GeoLife dataset is licensed for non-commercial academic use.",
    }
    return geolife_routes, summary


def recompute_canonical_derivatives(df: pd.DataFrame) -> pd.DataFrame:
    frame = df.copy()
    frame = frame.sort_values(["truck_id", "trip_id", "timestamp"]).reset_index(drop=True)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
    frame["fuel_level"] = pd.to_numeric(frame["fuel_level"], errors="coerce").clip(lower=0.0, upper=100.0)
    frame["speed"] = pd.to_numeric(frame["speed"], errors="coerce").fillna(0.0).clip(lower=0.0)
    frame["speed_kmph"] = frame["speed"]
    frame["odometer_km"] = pd.to_numeric(frame["odometer_km"], errors="coerce").fillna(0.0)
    frame["engine_status"] = np.where(frame["speed"] < 1.0, "idle", "on")

    prev_fuel = frame.groupby(["truck_id", "trip_id"], dropna=False)["fuel_level"].shift(1)
    prev_odo = frame.groupby(["truck_id", "trip_id"], dropna=False)["odometer_km"].shift(1)
    prev_ts = frame.groupby(["truck_id", "trip_id"], dropna=False)["timestamp"].shift(1)

    frame["delta_time_sec"] = (frame["timestamp"] - prev_ts).dt.total_seconds()
    frame["fuel_delta"] = frame["fuel_level"] - prev_fuel
    frame["odometer_delta"] = frame["odometer_km"] - prev_odo
    frame["fuel_used_pct"] = (-frame["fuel_delta"]).clip(lower=0.0)
    frame["fuel_per_km"] = np.where(frame["odometer_delta"] > 0, frame["fuel_used_pct"] / frame["odometer_delta"], 0.0)
    frame["fuel_rate_per_hour"] = np.where(
        frame["delta_time_sec"] > 0,
        frame["fuel_used_pct"] / (frame["delta_time_sec"] / 3600.0),
        0.0,
    )
    return frame.drop(columns=["fuel_used_pct"])


def select_controlled_injection_trip_keys(clean_df: pd.DataFrame) -> set[tuple[str, str]]:
    trip_keys = sorted(clean_df.groupby(["truck_id", "trip_id"], dropna=False).groups.keys())
    selected: set[tuple[str, str]] = set()
    for trip_number, (truck_id, trip_id) in enumerate(trip_keys):
        if trip_number % 2 == 0:
            continue
        group = clean_df[(clean_df["truck_id"] == truck_id) & (clean_df["trip_id"] == trip_id)]
        if len(group) < 8:
            continue
        selected.add((truck_id, trip_id))
    return selected


def derive_public_augmentation_profile(public_vehicle: pd.DataFrame, bus_reference: pd.DataFrame) -> dict[str, float]:
    vehicle = public_vehicle.sort_values(["trip_id", "timestamp"]).copy()
    startup_vehicle = vehicle.groupby("trip_id", dropna=False).head(8)
    startup_fuel_delta = startup_vehicle.groupby("trip_id", dropna=False)["fuel_level"].diff().abs().dropna()
    startup_speed_delta = startup_vehicle.groupby("trip_id", dropna=False)["speed"].diff().abs().dropna()
    bus_stop = pd.to_numeric(bus_reference["stop_ptime"], errors="coerce").dropna()
    bus_brake = pd.to_numeric(bus_reference["brake_usage"], errors="coerce").dropna()
    bus_accel = pd.to_numeric(bus_reference["accel"], errors="coerce").dropna()
    bus_fuel_rate = pd.to_numeric(bus_reference["fuel_rate_per_hour"], errors="coerce").dropna()

    startup_fuel_std = float(np.clip(startup_fuel_delta.quantile(0.60) if not startup_fuel_delta.empty else 0.02, 0.015, 0.05))
    startup_speed_std = float(np.clip(startup_speed_delta.quantile(0.50) if not startup_speed_delta.empty else 1.0, 0.6, 1.6))
    stop_multiplier_low = float(np.clip(1.0 - bus_stop.quantile(0.90) if not bus_stop.empty else 0.2, 0.15, 0.35))
    stop_multiplier_high = float(np.clip(1.0 - bus_stop.quantile(0.55) if not bus_stop.empty else 0.45, 0.35, 0.60))
    idle_fuel_draw_5s = (bus_fuel_rate * (5.0 / 3600.0)).clip(lower=0.0)
    idle_fuel_drop_min = float(np.clip(idle_fuel_draw_5s.quantile(0.35) if not idle_fuel_draw_5s.empty else 0.015, 0.01, 0.04))
    idle_fuel_drop_max = float(np.clip(idle_fuel_draw_5s.quantile(0.80) if not idle_fuel_draw_5s.empty else 0.06, 0.04, 0.12))
    stop_window_min = int(np.clip(round(bus_brake.quantile(0.35) * 10.0) if not bus_brake.empty else 3, 3, 4))
    stop_window_max = int(np.clip(round(bus_accel.quantile(0.80) * 10.0) if not bus_accel.empty else 6, 5, 8))

    return {
        "startup_window_min": 6,
        "startup_window_max": 6,
        "startup_fuel_jitter_std": float(np.clip(startup_fuel_std, 0.01, 0.015)),
        "startup_speed_noise_std": float(np.clip(startup_speed_std, 0.4, 0.7)),
        "startup_speed_ramp_low": -3.0,
        "startup_speed_ramp_high": 2.0,
        "whole_trip_fuel_jitter_std": float(np.clip(startup_fuel_std / 4.0, 0.005, 0.01)),
        "whole_trip_speed_noise_std": float(np.clip(startup_speed_std / 3.0, 0.3, 0.5)),
        "stop_multiplier_low": stop_multiplier_low,
        "stop_multiplier_high": stop_multiplier_high,
        "idle_fuel_drop_min": idle_fuel_drop_min,
        "idle_fuel_drop_max": idle_fuel_drop_max,
        "stop_window_min": stop_window_min,
        "stop_window_max": stop_window_max,
    }


def build_public_informed_normal_augments(
    clean_df: pd.DataFrame,
    excluded_trip_keys: set[tuple[str, str]],
    public_profile: dict[str, float],
    seed: int = 42,
) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    augmented_groups: list[pd.DataFrame] = []

    variant_configs = [
        ("startup_noise", "normal_startup_fluctuation"),
    ]

    for variant_name, augmentation_type in variant_configs:
        for trip_index, ((truck_id, trip_id), group) in enumerate(clean_df.groupby(["truck_id", "trip_id"], dropna=False)):
            if (truck_id, trip_id) in excluded_trip_keys:
                continue

            group = group.sort_values("timestamp").copy().reset_index(drop=True)
            if len(group) < 8:
                continue

            augmented = group.copy()
            augmented["trip_id"] = augmented["trip_id"].astype(str) + f"-{variant_name}-{trip_index}"
            augmented["id"] = [
                deterministic_uuid("evaluation_augmented", variant_name, trip_index, row_id, row_idx)
                for row_idx, row_id in enumerate(augmented["id"].tolist())
            ]
            augmented["record_origin"] = f"project_simulation_{variant_name}"
            augmented["source_dataset"] = "simulation_logs_public_informed_normal"
            augmented["label_source"] = "public_informed_clean_augmentation"
            augmented["is_injected"] = False
            augmented["anomaly_flag"] = False
            augmented["anomaly_type"] = "normal"
            augmented["difficulty_tier"] = "normal"
            augmented["anomaly_score"] = np.nan
            augmented["model_source"] = pd.NA
            augmented["augmentation_type"] = augmentation_type
            augmented["public_reference_source"] = "vehicle_telematics_public|bus_fuel_sensors_public"
            augmented["raw_trip_id"] = group["raw_trip_id"].astype(str) + f"-{variant_name}"
            augmented["trip_id_source"] = "derived_from_public_informed_normal_augmentation"

            if variant_name == "startup_noise":
                startup_len = min(
                    len(augmented),
                    int(rng.integers(public_profile["startup_window_min"], public_profile["startup_window_max"] + 1)),
                )
                augmented.loc[: startup_len - 1, "fuel_level"] += rng.normal(
                    0.0,
                    public_profile["startup_fuel_jitter_std"],
                    startup_len,
                )
                augmented.loc[: startup_len - 1, "speed"] = np.maximum(
                    0.0,
                    augmented.loc[: startup_len - 1, "speed"]
                    + np.linspace(public_profile["startup_speed_ramp_low"], public_profile["startup_speed_ramp_high"], startup_len)
                    + rng.normal(0.0, public_profile["startup_speed_noise_std"], startup_len),
                )
                idle_len = max(1, startup_len // 2)
                augmented.loc[: idle_len - 1, "engine_status"] = "idle"
                augmented.loc[: idle_len - 1, "odometer_km"] = augmented.loc[0, "odometer_km"] + np.linspace(0.0, 0.015, idle_len)
            augmented["fuel_level"] = (
                augmented["fuel_level"] + rng.normal(0.0, public_profile["whole_trip_fuel_jitter_std"], len(augmented))
            ).clip(lower=0.0, upper=100.0)
            augmented["speed"] = (
                augmented["speed"] + rng.normal(0.0, public_profile["whole_trip_speed_noise_std"], len(augmented))
            ).clip(lower=0.0)

            augmented_groups.append(recompute_canonical_derivatives(augmented))

    if not augmented_groups:
        return clean_df.iloc[0:0].copy()
    return pd.concat(augmented_groups, ignore_index=True)


def build_realistic_evaluation_dataset(
    project_clean_df: pd.DataFrame,
    public_clean_df: pd.DataFrame,
    injected_df: pd.DataFrame,
) -> tuple[pd.DataFrame, dict]:
    evaluation = pd.concat([injected_df.copy(), public_clean_df.copy()], ignore_index=True, sort=False)
    evaluation["augmentation_type"] = evaluation.get("augmentation_type", pd.Series(index=evaluation.index, dtype=object)).fillna("none")
    evaluation["public_reference_source"] = evaluation.get("public_reference_source", pd.Series(index=evaluation.index, dtype=object)).fillna("none")
    evaluation = evaluation.sort_values(["record_origin", "truck_id", "trip_id", "timestamp"]).reset_index(drop=True)

    summary = {
        "rows": int(len(evaluation)),
        "trip_count": int(evaluation["trip_id"].nunique()),
        "anomalous_trip_count": int(evaluation.groupby("trip_id", dropna=False)["anomaly_flag"].any().sum()),
        "record_origin_counts": evaluation["record_origin"].value_counts(dropna=False).to_dict(),
        "augmentation_type_counts": evaluation["augmentation_type"].value_counts(dropna=False).to_dict(),
        "project_native_trip_count": int(project_clean_df["trip_id"].nunique()),
        "public_clean_trip_count": int(public_clean_df["trip_id"].nunique()),
        "public_usage_policy": {
            "vehicle_telematics_public": "used as a telemetry-noise and startup-reference dataset; not inserted directly as evaluation ground truth",
            "bus_fuel_sensors_public": "used as a heavy-vehicle fuel-consumption reference for derived fuel traces; not inserted directly as route ground truth",
            "geolife_public_route": "inserted as clean route geometry and timestamp ground truth after schema mapping; fuel and truck identifiers remain derived for thesis simulation",
        },
    }
    return evaluation, summary


def build_seed_entities(clean_df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    truck_rows = list(TRUCKS)
    driver_rows = list(DRIVERS)
    base_truck_ids = {row["id"] for row in truck_rows}
    base_driver_ids = {row["id"] for row in driver_rows}

    public_rows = clean_df[clean_df["source_dataset"] == "geolife_public_route"].copy()
    public_trucks = (
        public_rows[["truck_id", "public_mode_label", "public_user_id"]]
        .drop_duplicates(subset=["truck_id"])
        .sort_values(["public_user_id", "truck_id"])
        .reset_index(drop=True)
    )
    for idx, row in public_trucks.iterrows():
        if row["truck_id"] in base_truck_ids:
            continue
        truck_rows.append(
            {
                "id": row["truck_id"],
                "truck_code": f"PUB-GL-{idx + 1:03d}",
                "plate_number": f"GLF-{idx + 1001:04d}",
                "model": f"GeoLife Route Demo Truck ({str(row['public_mode_label']).title()}-derived)",
                "status": "active",
            }
        )

    public_drivers = (
        public_rows[["driver_id", "truck_id", "public_user_id"]]
        .drop_duplicates(subset=["driver_id"])
        .sort_values(["public_user_id", "driver_id"])
        .reset_index(drop=True)
    )
    for idx, row in public_drivers.iterrows():
        if row["driver_id"] in base_driver_ids:
            continue
        driver_rows.append(
            {
                "id": row["driver_id"],
                "full_name": f"GeoLife Demo Driver {idx + 1:03d}",
                "username": f"geolife_driver_{idx + 1:03d}",
                "role": "driver",
                "assigned_truck_id": row["truck_id"],
                "is_active": True,
            }
        )

    return pd.DataFrame(truck_rows), pd.DataFrame(driver_rows)


def build_trip_pool_summary(clean_df: pd.DataFrame, evaluation_df: pd.DataFrame, geolife_summary: dict[str, object]) -> dict[str, object]:
    return {
        "cleaned_trip_count": int(clean_df["trip_id"].nunique()),
        "evaluation_trip_count": int(evaluation_df["trip_id"].nunique()),
        "project_native_trip_count": int(clean_df[clean_df["record_origin"] == "project_simulation_logs"]["trip_id"].nunique()),
        "public_source_trip_count": int(clean_df[clean_df["record_origin"] == "public_geolife_route_derived_fuel"]["trip_id"].nunique()),
        "anomaly_injected_trip_count": int(evaluation_df.groupby("trip_id", dropna=False)["anomaly_flag"].any().sum()),
        "clean_record_origin_counts": clean_df["record_origin"].value_counts(dropna=False).to_dict(),
        "evaluation_record_origin_counts": evaluation_df["record_origin"].value_counts(dropna=False).to_dict(),
        "geolife_summary": geolife_summary,
    }


def write_manifest(files_written: dict[str, str]) -> None:
    manifest = {
        "canonical_training_schema": [
            "id",
            "timestamp",
            "truck_id",
            "driver_id",
            "trip_id",
            "fuel_level",
            "lat",
            "lon",
            "speed",
            "speed_kmph",
            "odometer_km",
            "engine_status",
            "fuel_delta",
            "odometer_delta",
            "delta_time_sec",
            "fuel_per_km",
            "fuel_rate_per_hour",
            "anomaly_flag",
            "anomaly_score",
            "model_source",
        ],
        "selected_public_datasets": [
            {
                "name": "geolife_trajectories_1_3.zip",
                "role": "primary public route geometry source",
                "why": "Provides labeled, time-stamped GPS trajectories with dense 1-5 second sampling that can be mapped into trip-based route playback for simulation and dashboard realism.",
                "used_columns": ["latitude", "longitude", "date", "time", "labels.txt transportation mode"],
            },
            {
                "name": "vehicle_telematics.csv",
                "role": "public reference for startup/noise realism",
                "why": "Provides ordered trip IDs, speed, efficiency, and driver-behavior events that help bound realistic startup fluctuation and telemetry jitter when deriving truck-like fuel traces.",
                "used_columns": ["tripID", "deviceID", "timeStamp", "gps_speed", "speed", "kpl", "maf", "rpm", "hard_brake_event", "event"],
            },
            {
                "name": "bus_fuel_sensors.csv",
                "role": "heavy-vehicle stop-go and idle reference",
                "why": "Provides timestamped heavy-vehicle fuel_per_km, stop-time, brake, and acceleration behavior used to derive truck-style fuel traces on top of public route geometry.",
                "used_columns": ["Date-time", "VehicleID", "fuel_per_km", "stop_ptime", "avg_slope", "mass", "brake_usage", "accel"],
            },
        ],
        "not_integrated_to_avoid_noise": [
            {
                "name": "obd2_kit/*.csv",
                "reason": "Useful as a sensor reference but excluded from the main dataset pipeline because GPS, trip structure, and fuel level are incomplete for Supabase-aligned outputs.",
            },
            {
                "name": "fuel_consumption_canada.csv",
                "reason": "Useful for sanity checks only; not time-series telemetry and not directly suitable for trip-sequence training.",
            },
        ],
        "files_written": files_written,
    }
    (OUTPUT_DIR / "dataset_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def run_pipeline() -> dict[str, str]:
    ensure_output_dir()

    raw_project = load_project_simulation_logs()
    project = add_canonical_fields(assign_driver_ids(assign_trip_ids(standardize_project_telemetry(raw_project))), label_mode="clean")
    public_vehicle = build_public_vehicle_telematics()
    bus_reference = build_aux_fuel_reference()
    public_profile = derive_public_augmentation_profile(public_vehicle, bus_reference)
    public_geolife_routes, geolife_summary = build_public_geolife_routes(public_profile, bus_reference)
    cleaned = (
        pd.concat([project, public_geolife_routes], ignore_index=True, sort=False)
        .sort_values(["record_origin", "truck_id", "trip_id", "timestamp"])
        .reset_index(drop=True)
    )
    trip_sessions = build_trip_sessions(cleaned)
    evaluation_injected = inject_controlled_anomalies(project)
    evaluation, evaluation_summary = build_realistic_evaluation_dataset(
        project,
        public_geolife_routes,
        evaluation_injected,
    )
    alerts = build_alerts_seed(evaluation)
    trucks_seed, drivers_seed = build_seed_entities(cleaned)
    trip_pool_summary = build_trip_pool_summary(cleaned, evaluation, geolife_summary)

    outputs = {
        "trucks_seed_csv": str(OUTPUT_DIR / "trucks_seed.csv"),
        "drivers_seed_csv": str(OUTPUT_DIR / "drivers_seed.csv"),
        "cleaned_telemetry_csv": str(OUTPUT_DIR / "cleaned_telemetry.csv"),
        "trip_sessions_csv": str(OUTPUT_DIR / "trip_sessions.csv"),
        "evaluation_dataset_csv": str(OUTPUT_DIR / "evaluation_dataset.csv"),
        "evaluation_dataset_summary_json": str(OUTPUT_DIR / "evaluation_dataset_summary.json"),
        "trip_pool_summary_json": str(OUTPUT_DIR / "trip_pool_summary.json"),
        "public_geolife_quality_summary_json": str(OUTPUT_DIR / "public_geolife_quality_summary.json"),
        "alerts_seed_csv": str(OUTPUT_DIR / "alerts_seed.csv"),
        "public_primary_telematics_csv": str(OUTPUT_DIR / "public_primary_telematics.csv"),
        "aux_fuel_reference_csv": str(OUTPUT_DIR / "aux_fuel_reference.csv"),
        "public_geolife_routes_csv": str(OUTPUT_DIR / "public_geolife_routes.csv"),
    }

    trucks_seed.to_csv(outputs["trucks_seed_csv"], index=False)
    drivers_seed.to_csv(outputs["drivers_seed_csv"], index=False)
    cleaned.to_csv(outputs["cleaned_telemetry_csv"], index=False)
    trip_sessions.to_csv(outputs["trip_sessions_csv"], index=False)
    evaluation.to_csv(outputs["evaluation_dataset_csv"], index=False)
    Path(outputs["evaluation_dataset_summary_json"]).write_text(json.dumps(evaluation_summary, indent=2), encoding="utf-8")
    Path(outputs["trip_pool_summary_json"]).write_text(json.dumps(trip_pool_summary, indent=2), encoding="utf-8")
    Path(outputs["public_geolife_quality_summary_json"]).write_text(json.dumps(geolife_summary, indent=2), encoding="utf-8")
    alerts.to_csv(outputs["alerts_seed_csv"], index=False)
    public_vehicle.to_csv(outputs["public_primary_telematics_csv"], index=False)
    bus_reference.to_csv(outputs["aux_fuel_reference_csv"], index=False)
    public_geolife_routes.to_csv(outputs["public_geolife_routes_csv"], index=False)
    write_manifest(outputs)

    return outputs


def _cli() -> None:
    parser = argparse.ArgumentParser(description="Build canonical telemetry datasets for the thesis project")
    parser.parse_args()
    print(json.dumps(run_pipeline(), indent=2))


if __name__ == "__main__":
    _cli()
