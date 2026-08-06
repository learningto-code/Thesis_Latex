from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pandas as pd


BASE_DIR = Path(__file__).resolve().parent
LIVE_DIR = BASE_DIR / "outputs" / "datasets" / "live_supabase"
DATASET_DIR = BASE_DIR / "outputs" / "datasets"

LIVE_TELEMETRY = LIVE_DIR / "live_telemetry_ml.csv"
LIVE_TRIPS     = LIVE_DIR / "trip_sessions.csv"

CLEANED_OUT    = DATASET_DIR / "cleaned_telemetry.csv"
EVAL_OUT       = DATASET_DIR / "evaluation_dataset.csv"
TRIPS_OUT      = DATASET_DIR / "trip_sessions.csv"


def load_and_clean_live() -> pd.DataFrame:
    if not LIVE_TELEMETRY.exists():
        raise FileNotFoundError(
            f"{LIVE_TELEMETRY} missing -- run `python pull_supabase_telemetry.py` first"
        )
    print(f"[load] {LIVE_TELEMETRY}")
    df = pd.read_csv(LIVE_TELEMETRY)
    print(f"[load] {len(df):,} live rows from Supabase")

    # {fuel_level, engine_rpm, engine_load_pct, throttle_pct} is non-null.
    keep_mask = (
        df["fuel_level"].notna()
        | df["engine_rpm"].notna()
        | df["engine_load_pct"].notna()
        | df["throttle_pct"].notna()
    )
    df = df.loc[keep_mask].copy()
    print(f"[clean] {len(df):,} rows with at least one informative signal")

    # Drop rows the live anomaly detector already flagged -- IsolationForest
    # additional positive labels alongside the injected synthetic ones.)
    flagged_mask = df["anomaly_flag"].fillna(False).astype(bool)
    flagged = df.loc[flagged_mask].copy()
    df = df.loc[~flagged_mask].copy()
    print(f"[clean] dropped {len(flagged):,} live-flagged rows -> training keeps {len(df):,} clean rows")

    # Sort by truck/trip/timestamp so groupby operations are stable.
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=["timestamp"]).copy()
    df = df.sort_values(["truck_id", "trip_id", "timestamp"]).reset_index(drop=True)

    def _enrich(g: pd.DataFrame) -> pd.DataFrame:
        g = g.copy()
        g["fuel_delta"]      = g["fuel_level"].diff().fillna(0.0)
        g["odometer_delta"]  = g["odometer_km"].diff().fillna(0.0).clip(lower=0.0)
        g["delta_time_sec"]  = g["timestamp"].diff().dt.total_seconds().fillna(0.0).clip(lower=0.0)
        used = (-g["fuel_delta"]).clip(lower=0.0)
        g["fuel_per_km"]        = np.where(g["odometer_delta"] > 0, used / g["odometer_delta"], 0.0)
        g["fuel_rate_per_hour"] = np.where(g["delta_time_sec"] > 0, used / (g["delta_time_sec"] / 3600.0), 0.0)
        return g

    df = df.groupby(["truck_id", "trip_id"], group_keys=False, sort=False).apply(_enrich, include_groups=True)

    # Canonical schema columns expected by the training pipeline.
    if "speed_kmph" not in df.columns and "speed" in df.columns:
        df["speed_kmph"] = df["speed"]

    df["is_injected"]    = False
    df["anomaly_label"]  = False
    df["anomaly_type"]   = "normal"
    df["label_source"]   = "clean"
    df["record_origin"]  = "live_supabase"
    df["source_dataset"] = "live_supabase"
    df["source_file"]    = "live_supabase/telemetry_logs"

    return df


def refresh_trip_sessions() -> int:
    if LIVE_TRIPS.exists():
        shutil.copy(LIVE_TRIPS, TRIPS_OUT)
        n = sum(1 for _ in open(TRIPS_OUT)) - 1
        print(f"[copy] {LIVE_TRIPS} -> {TRIPS_OUT} ({n} trips)")
        return n
    print(f"[skip] no live trip_sessions found at {LIVE_TRIPS}")
    return 0


def main() -> None:
    DATASET_DIR.mkdir(parents=True, exist_ok=True)

    #   Supabase live OBD-II (1,279 rows) -- real fleet OBD context
    #   (Kaggle Cephasax appended later via ingest_kaggle_obdii.py)
    # learn what "normal" looks like at the per-trip rolling-feature level.

    geolife_backup = DATASET_DIR / "cleaned_telemetry.geolife_pre_real_obd.csv"
    if geolife_backup.exists():
        geolife = pd.read_csv(geolife_backup, low_memory=False)
        print(f"[geolife] {geolife_backup.name}: {len(geolife):,} rows")
    else:
        geolife = pd.DataFrame()
        print(f"[geolife] backup not found -- training will be Supabase-only")

    supabase = load_and_clean_live()
    print(f"[supabase] cleaned : {len(supabase):,} rows")

    # Harmonise columns and concat
    all_cols = sorted(set(geolife.columns) | set(supabase.columns))
    if not geolife.empty:
        geolife = geolife.reindex(columns=all_cols)
    supabase = supabase.reindex(columns=all_cols)
    merged = pd.concat([geolife, supabase], ignore_index=True) if not geolife.empty else supabase
    print(f"[merge] training rows total: {len(merged):,}")

    merged.to_csv(CLEANED_OUT, index=False)
    print(f"[write] {CLEANED_OUT} ({len(merged):,} rows)")

    refresh_trip_sessions()

    # Evaluation set: GeoLife base with injections (the calibrated reference
    # GeoLife backup is missing fall back to injecting on the Supabase
    eval_backup = DATASET_DIR / "evaluation_dataset.geolife_pre_real_obd.csv"
    if eval_backup.exists():
        # Use the original evaluation CSV -- it already has the calibrated
        shutil.copy(eval_backup, EVAL_OUT)
        print(f"[copy] {eval_backup.name} -> evaluation_dataset.csv (preserves calibrated injections)")
    else:
        from inject_anomalies import inject_controlled_anomalies
        eval_df = inject_controlled_anomalies(merged, seed=42)
        eval_df.to_csv(EVAL_OUT, index=False)
        n_pos = int(eval_df["anomaly_label"].astype(bool).sum())
        print(f"[write] {EVAL_OUT} ({len(eval_df):,} rows, {n_pos} injected anomalies)")

    print()
    print("[done] Real-OBD canonical datasets refreshed.")
    print("       Next: python train_iforest.py && python evaluate.py")


if __name__ == "__main__":
    main()
