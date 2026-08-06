"""Supplemental controlled anomaly injector for canonical telemetry CSVs."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from preprocess import CLEANED_TELEMETRY_PATH, DATASET_DIR, load_cleaned_telemetry, standardize_telemetry_schema


def _select_injection_start(group: pd.DataFrame, rng: np.random.Generator) -> int:
    lower = max(2, int(len(group) * 0.35))
    upper = max(lower + 1, int(len(group) * 0.7))
    return int(rng.integers(lower, upper))


def _apply_sudden_drop(group: pd.DataFrame, start_idx: int, magnitude: float) -> None:
    group.loc[group.index[start_idx:], "fuel_level"] = (
        group.loc[group.index[start_idx:], "fuel_level"] - magnitude
    ).clip(lower=0.0)
    label_end = min(start_idx + 3, len(group))
    group.loc[group.index[start_idx:label_end], "anomaly_label"] = True
    group.loc[group.index[start_idx:label_end], "anomaly_type"] = "sudden_fuel_drop"
    group.loc[group.index[start_idx:], "is_injected"] = True


def _apply_gradual_leak(group: pd.DataFrame, start_idx: int, leak_per_step: float,
                         label_window: int = 8) -> None:
    steps = np.arange(len(group) - start_idx, dtype=float) + 1.0
    group.loc[group.index[start_idx:], "fuel_level"] = (
        group.loc[group.index[start_idx:], "fuel_level"] - steps * leak_per_step
    ).clip(lower=0.0)
    label_end = min(start_idx + label_window, len(group))
    group.loc[group.index[start_idx:label_end], "anomaly_label"] = True
    group.loc[group.index[start_idx:label_end], "anomaly_type"] = "gradual_leak"
    group.loc[group.index[start_idx:], "is_injected"] = True


def _apply_idle_theft(group: pd.DataFrame, start_idx: int, magnitude: float) -> None:
    group.loc[group.index[start_idx:], "fuel_level"] = (
        group.loc[group.index[start_idx:], "fuel_level"] - magnitude
    ).clip(lower=0.0)
    label_end = min(start_idx + 3, len(group))
    group.loc[group.index[start_idx:label_end], "anomaly_label"] = True
    group.loc[group.index[start_idx:label_end], "anomaly_type"] = "idle_theft"
    group.loc[group.index[start_idx:], "is_injected"] = True


def _apply_refuel_during_drive(group: pd.DataFrame, start_idx: int, magnitude: float) -> None:
    group.loc[group.index[start_idx:], "fuel_level"] = (
        group.loc[group.index[start_idx:], "fuel_level"] + magnitude
    ).clip(upper=100.0)
    label_end = min(start_idx + 3, len(group))
    group.loc[group.index[start_idx:label_end], "anomaly_label"] = True
    group.loc[group.index[start_idx:label_end], "anomaly_type"] = "refuel_during_drive"
    group.loc[group.index[start_idx:], "is_injected"] = True


def _apply_rapid_decrease(group: pd.DataFrame, start_idx: int, per_step: float, duration: int) -> None:
    affected = min(duration, len(group) - start_idx)
    steps = np.arange(affected, dtype=float) + 1.0
    indices = group.index[start_idx : start_idx + affected]
    group.loc[indices, "fuel_level"] = (
        group.loc[indices, "fuel_level"] - steps * per_step
    ).clip(lower=0.0)
    if start_idx + affected < len(group):
        group.loc[group.index[start_idx + affected :], "fuel_level"] = (
            group.loc[group.index[start_idx + affected :], "fuel_level"] - steps[-1] * per_step
        ).clip(lower=0.0)
    group.loc[indices, "anomaly_label"] = True
    group.loc[indices, "anomaly_type"] = "abnormal_rapid_decrease"
    group.loc[group.index[start_idx:], "is_injected"] = True


def inject_controlled_anomalies(raw_frame: pd.DataFrame, seed: int = 42,
                                 injections_per_trip: int = 1) -> pd.DataFrame:
    df = standardize_telemetry_schema(raw_frame)
    df["anomaly_label"] = False
    df["anomaly_type"] = "normal"
    df["is_injected"] = False
    df["label_source"] = "controlled_injection"

    rng = np.random.default_rng(seed)
    injected_groups: list[pd.DataFrame] = []
    # Five-class injection (added idle_theft + refuel_during_drive on
    # 2026-06-23 for richer per-class evaluation breakdown).
    anomaly_cycle = [
        "sudden_fuel_drop", "gradual_leak", "abnormal_rapid_decrease",
        "idle_theft", "refuel_during_drive",
    ]
    cycle_pos = 0

    for _, group in df.groupby(["truck_id", "trip_id"], sort=False, dropna=False):
        group = group.sort_values("timestamp").copy()
        if len(group) < 12:
            injected_groups.append(group)
            continue

        trip_len = len(group)
        # Space the injections so they don't collide.
        n = max(1, min(injections_per_trip, trip_len // 6))
        window_size = trip_len // (n + 1)

        for k in range(n):
            anomaly_name = anomaly_cycle[cycle_pos % len(anomaly_cycle)]
            cycle_pos += 1
            lo = max(2, (k + 1) * window_size - 2)
            hi = min(trip_len - 2, (k + 1) * window_size + 2)
            if hi <= lo:
                continue
            start_idx = int(rng.integers(lo, hi))

            if anomaly_name == "sudden_fuel_drop":
                _apply_sudden_drop(group, start_idx, magnitude=float(rng.uniform(10.0, 18.0)))
            elif anomaly_name == "gradual_leak":
                # Bumped to 0.5-1.0 %/step so the labelled 8-row window
                # covers a cumulative 4-8 % drop that's detectable per-row.
                _apply_gradual_leak(group, start_idx, leak_per_step=float(rng.uniform(0.5, 1.0)))
            elif anomaly_name == "abnormal_rapid_decrease":
                _apply_rapid_decrease(
                    group, start_idx,
                    per_step=float(rng.uniform(1.0, 2.0)),
                    duration=int(rng.integers(3, 6)),
                )
            elif anomaly_name == "idle_theft":
                _apply_idle_theft(group, start_idx, magnitude=float(rng.uniform(5.0, 12.0)))
            elif anomaly_name == "refuel_during_drive":
                _apply_refuel_during_drive(group, start_idx, magnitude=float(rng.uniform(4.0, 10.0)))

        injected_groups.append(group)

    return pd.concat(injected_groups, ignore_index=True).sort_values(["truck_id", "trip_id", "timestamp"]).reset_index(drop=True)


def _cli() -> None:
    parser = argparse.ArgumentParser(description="Inject controlled anomalies into canonical cleaned telemetry")
    parser.add_argument("--input", default=str(CLEANED_TELEMETRY_PATH), help="Canonical cleaned telemetry dataset path")
    parser.add_argument("--output", default=str(DATASET_DIR / "evaluation_dataset_preview.csv"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    injected = inject_controlled_anomalies(load_cleaned_telemetry(args.input), seed=args.seed)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    injected.to_csv(output_path, index=False)
    print(output_path)


if __name__ == "__main__":
    _cli()
