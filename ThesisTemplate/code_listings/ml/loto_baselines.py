from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.neighbors import LocalOutlierFactor
from sklearn.preprocessing import StandardScaler

from loto_evaluate import _repair_eval_frame
from preprocess import (
    EVALUATION_DATASET_PATH,
    MODEL_VARIANT_FEATURES,
    engineer_features,
    load_evaluation_dataset,
    load_trip_sessions,
)


REPORT_DIR = Path(__file__).resolve().parent / "reports"
OUT_CSV = REPORT_DIR / "baseline_comparison_loto.csv"
OUT_JSON = REPORT_DIR / "baseline_comparison_loto.json"


def _wilson_ci(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n <= 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1.0 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = (z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def _confusion(flags: np.ndarray, labels: np.ndarray) -> dict:
    flags = flags.astype(bool); labels = labels.astype(bool)
    tp = int((flags & labels).sum())
    fp = int((flags & ~labels).sum())
    fn = int((~flags & labels).sum())
    tn = int((~flags & ~labels).sum())
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    fpr = fp / (fp + tn) if (fp + tn) else 0.0
    f1 = (2 * p * r / (p + r)) if (p + r) else 0.0
    p_lo, p_hi = _wilson_ci(tp, tp + fp)
    r_lo, r_hi = _wilson_ci(tp, tp + fn)
    fpr_lo, fpr_hi = _wilson_ci(fp, fp + tn)
    return {
        "TP": tp, "FP": fp, "FN": fn, "TN": tn,
        "precision": round(p, 4),
        "precision_ci_95": [round(p_lo, 4), round(p_hi, 4)],
        "recall": round(r, 4),
        "recall_ci_95": [round(r_lo, 4), round(r_hi, 4)],
        "false_positive_rate": round(fpr, 6),
        "false_positive_rate_ci_95": [round(fpr_lo, 4), round(fpr_hi, 4)],
        "f1": round(f1, 4),
    }


def baseline_static_threshold(frame: pd.DataFrame, drop_pct: float = 1.0) -> np.ndarray:
    """Flag rows whose |fuel_delta| crosses an absolute drop threshold."""
    return (frame["fuel_delta"].abs() >= drop_pct).to_numpy(dtype=bool)


def baseline_iqr(
    train_clean: pd.DataFrame,
    held_out: pd.DataFrame,
    feature: str,
    group_col: str | None = "truck_id",
    multiplier: float = 1.5,
) -> np.ndarray:
    if group_col and group_col in train_clean.columns and group_col in held_out.columns:
        bounds: dict[str, tuple[float, float]] = {}
        for group_value, group in train_clean.groupby(group_col, dropna=False):
            vals = pd.to_numeric(group[feature], errors="coerce").dropna()
            if len(vals) < 10:
                continue
            q1, q3 = float(vals.quantile(0.25)), float(vals.quantile(0.75))
            iqr = q3 - q1
            bounds[str(group_value)] = (q1 - multiplier * iqr, q3 + multiplier * iqr)
        global_vals = pd.to_numeric(train_clean[feature], errors="coerce").dropna()
        if global_vals.empty:
            return np.zeros(len(held_out), dtype=bool)
        q1g, q3g = float(global_vals.quantile(0.25)), float(global_vals.quantile(0.75))
        iqr_g = q3g - q1g
        global_bound = (q1g - multiplier * iqr_g, q3g + multiplier * iqr_g)
        flags = np.zeros(len(held_out), dtype=bool)
        for i, (_, row) in enumerate(held_out.iterrows()):
            key = str(row.get(group_col, ""))
            lo, hi = bounds.get(key, global_bound)
            val = row.get(feature)
            if val is None or (isinstance(val, float) and np.isnan(val)):
                continue
            v = float(val)
            if v < lo or v > hi:
                flags[i] = True
        return flags
    vals = pd.to_numeric(train_clean[feature], errors="coerce").dropna()
    if vals.empty:
        return np.zeros(len(held_out), dtype=bool)
    q1, q3 = float(vals.quantile(0.25)), float(vals.quantile(0.75))
    iqr = q3 - q1
    lo, hi = q1 - multiplier * iqr, q3 + multiplier * iqr
    h = pd.to_numeric(held_out[feature], errors="coerce")
    return ((h < lo) | (h > hi)).fillna(False).to_numpy(dtype=bool)


def baseline_lof(
    train_clean: pd.DataFrame,
    held_out: pd.DataFrame,
    features: list[str],
    threshold_quantile: float = 0.985,
    n_neighbors: int = 20,
) -> np.ndarray:
    available = [c for c in features if c in train_clean.columns]
    X_tr = train_clean.reindex(columns=available, fill_value=0.0).fillna(0.0).to_numpy(dtype=float)
    X_he = held_out.reindex(columns=available, fill_value=0.0).fillna(0.0).to_numpy(dtype=float)
    if X_tr.shape[0] < n_neighbors + 1 or X_he.shape[0] == 0:
        return np.zeros(len(held_out), dtype=bool)
    scaler = StandardScaler().fit(X_tr)
    X_tr_s = scaler.transform(X_tr)
    X_he_s = scaler.transform(X_he)
    lof = LocalOutlierFactor(n_neighbors=min(n_neighbors, max(2, X_tr.shape[0] - 1)), novelty=True)
    lof.fit(X_tr_s)
    train_scores = -lof.decision_function(X_tr_s)
    threshold = float(np.quantile(train_scores, threshold_quantile))
    held_scores = -lof.decision_function(X_he_s)
    return (held_scores >= threshold).astype(bool)


def run_baselines(dataset_path: str | Path = EVALUATION_DATASET_PATH) -> dict:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    trip_sessions = load_trip_sessions()
    raw = _repair_eval_frame(load_evaluation_dataset(dataset_path))
    ev = engineer_features(raw, trip_sessions=trip_sessions)
    pn = ev[ev["trip_source_category"] == "project_native"].copy()
    pn_trips = sorted(pn["trip_id"].unique().tolist())

    feats_c = MODEL_VARIANT_FEATURES["C"]

    # Collect per-baseline flag arrays across all held-out trips.
    static_flags: list[np.ndarray] = []
    iqr_fpk_flags: list[np.ndarray] = []
    iqr_fd_flags: list[np.ndarray] = []
    lof_flags: list[np.ndarray] = []
    all_labels: list[np.ndarray] = []
    all_held_subsets: list[np.ndarray] = []
    all_trip_categories: list[np.ndarray] = []

    for trip in pn_trips:
        held = pn[pn["trip_id"] == trip].copy()
        rest_clean = pn[(pn["trip_id"] != trip) & (~pn["anomaly_label"].astype(bool))].copy()
        if rest_clean.empty:
            continue

        static_flags.append(baseline_static_threshold(held, drop_pct=1.0))
        iqr_fpk_flags.append(baseline_iqr(rest_clean, held, "fuel_per_km", group_col="truck_id"))
        iqr_fd_flags.append(baseline_iqr(rest_clean, held, "fuel_delta", group_col="truck_id"))
        lof_flags.append(baseline_lof(rest_clean, held, feats_c, threshold_quantile=0.985))
        all_labels.append(held["anomaly_label"].astype(bool).to_numpy())
        all_held_subsets.append(held["evaluation_subset"].astype(str).to_numpy())
        all_trip_categories.append(held["trip_source_category"].astype(str).to_numpy())

    static_arr = np.concatenate(static_flags)
    iqr_fpk_arr = np.concatenate(iqr_fpk_flags)
    iqr_fd_arr = np.concatenate(iqr_fd_flags)
    lof_arr = np.concatenate(lof_flags)
    labels_arr = np.concatenate(all_labels)
    subsets_arr = np.concatenate(all_held_subsets)
    categories_arr = np.concatenate(all_trip_categories)

    pn_mask = categories_arr == "project_native"

    rows = []
    for name, flags in [
        ("Static threshold (|fuel_delta| >= 1.0%)", static_arr),
        ("Per-truck IQR on fuel_per_km (Tukey 1.5x)", iqr_fpk_arr),
        ("Per-truck IQR on fuel_delta (Tukey 1.5x)", iqr_fd_arr),
        ("Local Outlier Factor (LOF, novelty, q985)", lof_arr),
    ]:
        for subset_name, mask in [
            ("project_native", pn_mask),
            ("project_native_injected", subsets_arr == "project_native_injected"),
            ("project_native_clean", subsets_arr == "project_native_clean"),
        ]:
            sub_flags = flags[mask]
            sub_labels = labels_arr[mask]
            metrics = _confusion(sub_flags, sub_labels)
            metrics.update({
                "baseline": name,
                "subset": subset_name,
                "n_rows": int(mask.sum()),
            })
            rows.append(metrics)
            if subset_name == "project_native":
                print(
                    f"{name:50s} {subset_name:25s} P={metrics['precision']*100:5.1f}% "
                    f"R={metrics['recall']*100:5.1f}% FPR={metrics['false_positive_rate']*100:5.2f}% "
                    f"TP={metrics['TP']:>3} FP={metrics['FP']:>3} FN={metrics['FN']:>3} TN={metrics['TN']:>3}",
                    flush=True,
                )

    pd.DataFrame(rows).to_csv(OUT_CSV, index=False)
    OUT_JSON.write_text(json.dumps(rows, indent=2, default=str), encoding="utf-8")
    print(f"\nWrote {OUT_CSV}\nWrote {OUT_JSON}")
    return {"rows": rows}


if __name__ == "__main__":
    run_baselines()
