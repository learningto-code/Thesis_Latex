"""Reusable inference helpers for backend and offline evaluation."""

from __future__ import annotations

import argparse
import json
import pickle
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from matrix_profile import MatrixProfileDetector
from preprocess import (
    ANCHOR_ALIGNED_COLUMNS,
    CONTEXT_AWARE_BASELINE_COLUMNS,
    DRIVING_ZONES_COLUMNS,
    EXTENDED_FEATURE_COLUMNS,
    FEATURE_COLUMNS,
    FULL_FEATURE_COLUMNS,
    MODEL_DIR,
    MODEL_VARIANT_NAMES,
    build_context_key,
    build_threshold_context_key,
    normalize_trip_source_category,
)


IFOREST_PATH = MODEL_DIR / "iforest.pkl"
IFOREST_MODEL_A_PATH = MODEL_DIR / "iforest_model_a.pkl"
IFOREST_MODEL_B_PATH = MODEL_DIR / "iforest_model_b.pkl"
IFOREST_MODEL_C_PATH = MODEL_DIR / "iforest_model_c.pkl"
MP_PATH = MODEL_DIR / "matrix_profile.json"
DISTANCE_MODEL_PATH = MODEL_DIR / "distance_corrector.pkl"


def load_iforest_variant(variant: str) -> dict:
    paths = {
        "A": IFOREST_MODEL_A_PATH,
        "B": IFOREST_MODEL_B_PATH,
        "C": IFOREST_MODEL_C_PATH,
    }
    path = paths.get(variant.upper(), IFOREST_PATH)
    if not path.exists():
        path = IFOREST_PATH  # fall back to default
    with path.open("rb") as handle:
        return pickle.load(handle)


def load_iforest_bundle(path: Path = IFOREST_PATH) -> dict:
    with path.open("rb") as handle:
        return pickle.load(handle)


def load_mp_detector(path: Path = MP_PATH) -> MatrixProfileDetector:
    return MatrixProfileDetector.load(path)


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return default if value is None else float(value)
    except (TypeError, ValueError):
        return default


def normalize_feature_payload(payload: dict) -> dict[str, float]:
    fuel_level = _to_float(payload.get("fuel_level"))
    speed_kmph = _to_float(payload.get("speed_kmph", payload.get("speed")))
    fuel_delta = _to_float(payload.get("fuel_delta"))
    odometer_delta = max(_to_float(payload.get("odometer_delta")), 0.0)

    if "fuel_per_km" in payload:
        fuel_per_km = max(_to_float(payload.get("fuel_per_km")), 0.0)
    else:
        fuel_used = max(-fuel_delta, 0.0)
        fuel_per_km = fuel_used / odometer_delta if odometer_delta > 0 else 0.0

    if "fuel_rate_per_hour" in payload:
        fuel_rate_per_hour = max(_to_float(payload.get("fuel_rate_per_hour")), 0.0)
    else:
        delta_time_sec = max(_to_float(payload.get("delta_time_sec")), 0.0)
        fuel_used = max(-fuel_delta, 0.0)
        fuel_rate_per_hour = fuel_used / (delta_time_sec / 3600.0) if delta_time_sec > 0 else 0.0

    if "distance_per_fuel" in payload:
        distance_per_fuel = max(_to_float(payload.get("distance_per_fuel")), 0.0)
    else:
        fuel_used = max(-fuel_delta, 0.0)
        distance_per_fuel = odometer_delta / fuel_used if fuel_used > 0 else 0.0

    route_segment_performance = max(
        _to_float(payload.get("route_segment_performance", payload.get("fuel_per_km", fuel_per_km))),
        0.0,
    )
    driver_behavior_score = max(_to_float(payload.get("driver_behavior_score")), 0.0)
    fuel_level_filtered = _to_float(payload.get("fuel_level_filtered", fuel_level))
    speed_filtered = _to_float(payload.get("speed_filtered", speed_kmph))

    route_segment_index = payload.get("route_segment_index")
    if route_segment_index is None and "route_progress" in payload:
        route_progress = _to_float(payload.get("route_progress"), default=0.5)
        route_segment_index = 0 if route_progress < 0.33 else 1 if route_progress < 0.66 else 2

    timestamp = payload.get("timestamp")
    if "context_key" in payload and payload.get("context_key"):
        context_key = str(payload["context_key"])
    else:
        hour_of_day = None
        if isinstance(timestamp, str) and timestamp:
            try:
                hour_of_day = int(pd.to_datetime(timestamp, utc=True, errors="coerce").hour)
            except Exception:
                hour_of_day = None
        context_key = build_context_key(hour_of_day, route_segment_index, driver_behavior_score)

    trip_source_category = payload.get("trip_source_category")
    if not trip_source_category:
        trip_source_category = normalize_trip_source_category(payload.get("source_dataset"), payload.get("record_origin"))
    trip_length_band = payload.get("trip_length_band", "unknown_length")
    source_threshold_key = f"{trip_source_category}|{trip_length_band}"
    threshold_context_key = build_threshold_context_key(trip_source_category, trip_length_band, context_key)

    # Extended OBD2 features
    rpm_raw = _to_float(payload.get("engine_rpm"))
    load_raw = _to_float(payload.get("engine_load_pct"))
    throttle_raw = _to_float(payload.get("throttle_pct"))
    engine_status = str(payload.get("engine_status", "on")).lower()
    speed_val = speed_filtered  # already computed above

    rpm_norm = min(max(rpm_raw / 4000.0, 0.0), 1.0)
    load_norm = min(max(load_raw / 100.0, 0.0), 1.0)
    throttle_norm = min(max(throttle_raw / 100.0, 0.0), 1.0)

    fuel_drop_stationary = max(-fuel_delta, 0.0) if speed_val < 5.0 else 0.0
    fuel_drop_engine_off = max(-fuel_delta, 0.0) if engine_status in ("idle", "off") else 0.0
    idle_duration_score = _to_float(payload.get("idle_duration_score"), default=0.0)
    fuel_drop_per_rpm  = fuel_per_km / (rpm_norm  + 1e-6)
    fuel_drop_per_load = fuel_per_km / (load_norm + 1e-6)

    # Model D context features
    if (speed_val < 1.0) and engine_status in ("idle", "off"):
        motion_state_code = 0.0   # PARKED
    elif speed_val < 5.0:
        motion_state_code = 1.0   # IDLE
    elif (load_norm >= 0.5) or (throttle_norm >= 0.25):
        motion_state_code = 3.0   # HIGH_LOAD
    else:
        motion_state_code = 2.0   # CRUISE

    time_since_refuel_sec = max(_to_float(payload.get("time_since_refuel_sec"), default=99999.0), 0.0)
    time_since_refuel_norm = min(time_since_refuel_sec / 600.0, 1.0)
    post_refuel_flag = 1.0 if time_since_refuel_sec <= 300.0 else 0.0

    # Deltaengine_load / Deltathrottle -- from previous row when caller supplies it.
    delta_load_norm = max(min(_to_float(payload.get("delta_engine_load_norm")), 1.0), -1.0)
    delta_throttle_norm_val = max(min(_to_float(payload.get("delta_throttle_norm")), 1.0), -1.0)

    speed_norm_for_ratio = min(max(speed_val / 80.0, 0.0), 1.5)
    load_per_speed_norm = min((load_norm / (speed_norm_for_ratio + 0.1)), 5.0)

    expected_consumption_residual = _to_float(payload.get("expected_consumption_residual"), default=0.0)

    return {
        "fuel_level_filtered": fuel_level_filtered,
        "speed_filtered": speed_filtered,
        "fuel_delta": fuel_delta,
        "odometer_delta": odometer_delta,
        "fuel_per_km": fuel_per_km,
        "fuel_rate_per_hour": fuel_rate_per_hour,
        "distance_per_fuel": distance_per_fuel,
        "route_segment_performance": route_segment_performance,
        "driver_behavior_score": driver_behavior_score,
        # Extended
        "engine_rpm_normalized": rpm_norm,
        "engine_load_pct_norm": load_norm,
        "throttle_pct_norm": throttle_norm,
        "fuel_drop_while_stationary": fuel_drop_stationary,
        "fuel_drop_with_engine_off": fuel_drop_engine_off,
        "idle_duration_score": idle_duration_score,
        "fuel_drop_per_rpm": fuel_drop_per_rpm,
        "fuel_drop_per_load": fuel_drop_per_load,
        # Distance fusion features (Model C) -- computed from payload when available
        "distance_obd_delta": _to_float(payload.get("distance_obd_delta",
            odometer_delta if odometer_delta > 0 else speed_kmph * max(_to_float(payload.get("delta_time_sec")), 0.0) / 3600.0)),
        "distance_gps_delta": _to_float(payload.get("distance_gps_delta", odometer_delta)),
        "distance_fused_delta": _to_float(payload.get("distance_fused_delta", odometer_delta)),
        "speed_variability": _to_float(payload.get("speed_variability")),
        "acceleration_kmph_per_sec": _to_float(payload.get("acceleration_kmph_per_sec")),
        # Model D context features
        "motion_state_code": motion_state_code,
        "time_since_refuel_norm": time_since_refuel_norm,
        "post_refuel_flag": post_refuel_flag,
        "delta_engine_load_norm": delta_load_norm,
        "delta_throttle_norm": delta_throttle_norm_val,
        "load_per_speed_norm": load_per_speed_norm,
        "expected_consumption_residual": expected_consumption_residual,
        # Model E features (Barbado driving zones + Habib KMPL deviation +
        # the backend SHOULD supply these via the new payload keys.
        "rpm_high_share":           _to_float(payload.get("rpm_high_share")),
        "rpm_red_share":            _to_float(payload.get("rpm_red_share")),
        "rpm_orange_share":         _to_float(payload.get("rpm_orange_share")),
        "rpm_yellow_share":         _to_float(payload.get("rpm_yellow_share")),
        "speed_over_90_share":      _to_float(payload.get("speed_over_90_share")),
        "speed_over_120_share":     _to_float(payload.get("speed_over_120_share")),
        "kmpl_deviation_pct":       max(min(_to_float(payload.get("kmpl_deviation_pct")), 2.0), -2.0),
        "driver_kmpl_deviation_pct": max(min(_to_float(payload.get("driver_kmpl_deviation_pct")), 2.0), -2.0),
        "route_type_code":          _to_float(payload.get("route_type_code"), default=1.0),
        "context_key": context_key,
        "trip_source_category": trip_source_category,
        "trip_length_band": trip_length_band,
        "source_threshold_key": source_threshold_key,
        "threshold_context_key": threshold_context_key,
    }


def _select_feature_columns(bundle: dict) -> list[str]:
    """Return the feature list stored in the bundle, with fallback detection by feature count."""
    if "features" in bundle and bundle["features"]:
        return list(bundle["features"])
    try:
        n = bundle["pipeline"].n_features_in_
        if n == len(ANCHOR_ALIGNED_COLUMNS):
            return ANCHOR_ALIGNED_COLUMNS
        if n == len(DRIVING_ZONES_COLUMNS):
            return DRIVING_ZONES_COLUMNS
        if n == len(CONTEXT_AWARE_BASELINE_COLUMNS):
            return CONTEXT_AWARE_BASELINE_COLUMNS
        if n == len(FULL_FEATURE_COLUMNS):
            return FULL_FEATURE_COLUMNS
        if n == len(EXTENDED_FEATURE_COLUMNS):
            return EXTENDED_FEATURE_COLUMNS
    except AttributeError:
        pass
    return FEATURE_COLUMNS


def run_iforest_inference(payload: dict, bundle: dict | None = None) -> dict:
    bundle = bundle or load_iforest_bundle()
    normalized = normalize_feature_payload(payload)
    feature_cols = _select_feature_columns(bundle)
    vector = np.array([[normalized.get(feature, 0.0) for feature in feature_cols]], dtype=float)
    score = float(-bundle["pipeline"].decision_function(vector)[0])
    threshold = float(
        bundle.get("context_thresholds", {}).get(
            normalized["source_threshold_key"],
            bundle.get("context_thresholds", {}).get(
                normalized["threshold_context_key"],
                bundle.get("context_thresholds", {}).get(normalized["context_key"], bundle["score_threshold"]),
            ),
        )
    )
    is_anomaly = bool(score >= threshold)
    model_variant = "isolation_forest_ext" if feature_cols is EXTENDED_FEATURE_COLUMNS else "isolation_forest"
    return {
        "anomaly_score": round(score, 6),
        "anomaly_flag": is_anomaly,
        "model_source": model_variant,
        "threshold": round(threshold, 6),
        "context_key": normalized["context_key"],
        "threshold_context_key": normalized["threshold_context_key"],
        "features": normalized,
    }


def run_mp_inference(
    fuel_series: list[float] | None,
    detector: MatrixProfileDetector | None = None,
    context_key: str | None = None,
) -> dict | None:
    if not fuel_series:
        return None
    detector = detector or load_mp_detector()
    result = detector.detect_latest(fuel_series, context_key=context_key)
    return {
        "anomaly_score": result["score"],
        "anomaly_flag": result["is_anomaly"],
        "model_source": "matrix_profile",
        "threshold": result.get("threshold_z"),
        "window_size": result.get("window_size"),
        "signal_column": result.get("signal_column"),
        "context_key": result.get("context_key"),
        "reason": result.get("reason"),
    }


_DASHBOARD_MIN_DROP_PCT = 0.75   # empirically tuned: 3/6 recall, 0/67 public FPR
_DASHBOARD_CONTEXT_WINDOW = 12    # number of trailing samples to compare against

# Precision-recall operating points (added 2026-06-23).
# Default operating mode for production = HIGH_PRECISION ("and_with_margin"):
#   * IF flag fires only when score >= threshold + IF_SCORE_MARGIN
#     refuel-exemption / persistence)
#   * Combined flag = IF AND MP (intersection, not union)
# available for the panel to demonstrate the precision-recall trade-off and
# that pushes IF precision above 0.85 without dropping recall below 0.85 on
# IFOREST_SCORE_MARGIN env var in production.
import os as _os
# Updated 2026-06-23 -- empirical sweep on the canonical evaluation set
# WITHOUT MP intersection, gives:
# available for audit-confirmation but is not part of the default flag.
COMBINE_MODE = _os.environ.get("ANOMALY_COMBINE_MODE", "if_with_margin")
IF_SCORE_MARGIN = float(_os.environ.get("IFOREST_SCORE_MARGIN", "0.005"))


def _recent_fuel_drop_pct(fuel_series: list[float] | None) -> float:
    if not fuel_series:
        return 0.0
    arr = np.asarray([v for v in fuel_series if v is not None], dtype=float)
    if arr.size < 4 or np.isnan(arr).all():
        return 0.0
    arr = arr[~np.isnan(arr)]
    if arr.size < 4:
        return 0.0
    tail = arr[-_DASHBOARD_CONTEXT_WINDOW:]
    head_n = max(2, tail.size // 3)
    left = float(tail[:head_n].mean())
    right = float(tail[-head_n:].mean())
    drop = left - right                # positive = fuel went DOWN
    return drop


def run_combined_inference(
    payload: dict,
    fuel_series: list[float] | None = None,
    iforest_bundle: dict | None = None,
    mp_detector: MatrixProfileDetector | None = None,
    combine_mode: str | None = None,
    if_score_margin: float | None = None,
) -> dict:
    mode    = (combine_mode or COMBINE_MODE).lower()
    margin  = IF_SCORE_MARGIN if if_score_margin is None else float(if_score_margin)

    if_result = run_iforest_inference(payload, bundle=iforest_bundle)
    mp_result = run_mp_inference(
        fuel_series,
        detector=mp_detector,
        context_key=if_result.get("source_threshold_key", if_result.get("threshold_context_key", if_result["context_key"])),
    )

    if_flag_raw   = bool(if_result["anomaly_flag"])
    mp_flag       = bool(mp_result["anomaly_flag"]) if mp_result else False
    if_score      = float(if_result["anomaly_score"])
    if_threshold  = float(if_result["threshold"])

    # Recent-drop gate (kept for both modes -- defends against fuel-flat FPs).
    recent_drop = _recent_fuel_drop_pct(fuel_series)
    if_flag_after_drop_gate = if_flag_raw and (recent_drop >= _DASHBOARD_MIN_DROP_PCT)

    # Margin gate -- applied in and_with_margin and if_with_margin modes.
    if mode == "and_with_margin":
        if_flag_after_margin = if_flag_after_drop_gate and (if_score >= if_threshold + margin)
        combined_flag = if_flag_after_margin and mp_flag
    elif mode == "if_with_margin":
        if_flag_after_margin = if_flag_after_drop_gate and (if_score >= if_threshold + margin)
        combined_flag = if_flag_after_margin
    else:  # "or" -- legacy union
        if_flag_after_margin = if_flag_after_drop_gate
        combined_flag = if_flag_after_margin or mp_flag

    # Decide model_source label
    if combined_flag and if_flag_after_margin and mp_flag:
        source = "combined"
    elif combined_flag and if_flag_after_margin:
        source = "isolation_forest"
    elif combined_flag and mp_flag:
        source = "matrix_profile"
    else:
        source = "none"

    if_result_out = dict(if_result)
    if_result_out["anomaly_flag"] = if_flag_after_margin
    if_result_out["anomaly_flag_raw"] = if_flag_raw
    if_result_out["context_fuel_drop_pct"] = round(float(recent_drop), 3)
    if_result_out["score_margin_applied"]  = margin if mode == "and_with_margin" else 0.0
    if if_flag_raw and not if_flag_after_margin:
        reasons = []
        if recent_drop < _DASHBOARD_MIN_DROP_PCT:
            reasons.append(f"recent_drop {recent_drop:.2f}%<{_DASHBOARD_MIN_DROP_PCT}")
        if mode == "and_with_margin" and if_score < if_threshold + margin:
            reasons.append(f"score {if_score:.4f}<threshold+{margin:.3f}")
        if reasons:
            if_result_out["suppression_reason"] = "; ".join(reasons)

    return {
        "anomaly_score": round(
            max(if_score, mp_result["anomaly_score"] if mp_result else 0.0),
            6,
        ),
        "anomaly_flag": bool(combined_flag),
        "model_source": source,
        "combine_mode": mode,
        "if_result": if_result_out,
        "mp_result": mp_result,
    }


def run_all_variants_inference(
    payload: dict,
    fuel_series: list[float] | None = None,
    mp_detector: MatrixProfileDetector | None = None,
) -> dict:
    variant_results: dict[str, dict] = {}
    best_bundle: dict | None = None

    for variant in ("C", "B", "A"):
        try:
            bundle = load_iforest_variant(variant)
            result = run_iforest_inference(payload, bundle=bundle)
            result["model_variant"] = variant
            result["model_variant_label"] = MODEL_VARIANT_NAMES.get(variant, variant)
            variant_results[variant] = result
            if best_bundle is None:
                best_bundle = bundle
        except Exception:
            continue

    mp_result = run_mp_inference(
        fuel_series,
        detector=mp_detector,
        context_key=(
            variant_results.get("C", variant_results.get("B", variant_results.get("A", {})))
            .get("source_threshold_key")
        ),
    )

    # Combined decision: best IF variant OR Matrix Profile
    best_if = variant_results.get("C", variant_results.get("B", variant_results.get("A")))
    if_flag = best_if["anomaly_flag"] if best_if else False
    mp_flag = mp_result["anomaly_flag"] if mp_result else False
    if if_flag and mp_flag:
        combined_source = "combined"
    elif if_flag:
        combined_source = f"isolation_forest_{(best_if or {}).get('model_variant', '').lower()}"
    elif mp_flag:
        combined_source = "matrix_profile"
    else:
        combined_source = "none"

    return {
        "anomaly_flag": bool(if_flag or mp_flag),
        "anomaly_score": round(max(
            (best_if or {}).get("anomaly_score", 0.0),
            mp_result["anomaly_score"] if mp_result else 0.0,
        ), 6),
        "model_source": combined_source,
        "variant_results": variant_results,
        "mp_result": mp_result,
    }


def _cli() -> None:
    parser = argparse.ArgumentParser(description="Run a single offline ML inference")
    parser.add_argument("--payload", required=True, help="JSON object containing telemetry fields")
    parser.add_argument("--fuel-series", default=None, help="Optional JSON list of fuel levels")
    parser.add_argument("--variant", default=None, choices=["A", "B", "C"],
                        help="Model variant to use (default: best available)")
    args = parser.parse_args()

    payload = json.loads(args.payload)
    series = json.loads(args.fuel_series) if args.fuel_series else None

    if args.variant:
        bundle = load_iforest_variant(args.variant)
        print(json.dumps(run_combined_inference(payload, series, iforest_bundle=bundle), indent=2))
    else:
        print(json.dumps(run_combined_inference(payload, series), indent=2))


if __name__ == "__main__":
    _cli()
