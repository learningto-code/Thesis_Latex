from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd


HERE = Path(__file__).parent
PRED_DIR = HERE / "outputs" / "predictions" / "loto"
REPORT_DIR = HERE / "reports"

IF_PRED_CSV       = PRED_DIR / "evaluation_predictions_iforest_c_loto.csv"
MP_PRED_CSV       = PRED_DIR / "evaluation_predictions_matrix_profile_rows_loto.csv"
HYBRID_PRED_CSV   = PRED_DIR / "evaluation_predictions_hybrid_loto.csv"

OUT_JSON = REPORT_DIR / "metrics_ablation.json"
OUT_CSV  = REPORT_DIR / "metrics_ablation.csv"
OUT_PRED = REPORT_DIR / "ablation_predictions.csv"

# Physics tripwire constants (mirror backend/server.js)
PHYSICS_WINDOW_SEC    = 60.0
PHYSICS_EXCESS_FACTOR = 5.0
PHYSICS_MIN_DROP_PCT  = 1.5
PHYSICS_DEDUP_SEC     = 45.0   # per-trip dedup, matches 2026-07-15 fix


# Configurations enumerated for the ablation
@dataclass(frozen=True)
class Config:
    key:    str
    label:  str
    flag_col: str


CONFIGS = (
    Config("physics",  "Physics tripwire only",  "physics_flag"),
    Config("iforest",  "Isolation Forest only",  "iforest_flag"),
    Config("mp",       "Matrix Profile only",    "mp_anomaly_flag"),
    Config("hybrid",   "IF $+$ MP (hybrid union)", "hybrid_union_flag"),
)


# Physics tripwire port (backend/server.js:213 checkPhysicsTripwire)
def _burn_envelope_pct_per_min(mean_speed: float, mean_load: float) -> float:
    if mean_speed < 5.0:
        return 0.03
    load = max(0.0, min(100.0, mean_load))
    return 0.03 + (load / 100.0) * 0.15


def _apply_physics_tripwire(trip_df: pd.DataFrame) -> pd.Series:
    frame = trip_df.sort_values("timestamp").reset_index()
    flags = np.zeros(len(frame), dtype=bool)

    if frame.empty:
        return pd.Series(flags, index=frame["index"])

    times = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
    fuel  = pd.to_numeric(frame.get("fuel_level"), errors="coerce")
    speed = pd.to_numeric(frame.get("speed_kmph", frame.get("speed")),
                          errors="coerce").fillna(0.0)
    load  = pd.to_numeric(frame.get("engine_load_pct"),
                          errors="coerce").fillna(30.0)

    last_alert_ts = None
    for i in range(len(frame)):
        ti = times.iloc[i]
        fi = fuel.iloc[i]
        if pd.isna(ti) or pd.isna(fi):
            continue

        window_lo = ti - pd.Timedelta(seconds=PHYSICS_WINDOW_SEC)
        mask = (times >= window_lo) & (times <= ti) & fuel.notna()
        if mask.sum() < 2:
            continue

        w_fuel  = fuel[mask].to_numpy()
        w_time  = times[mask].to_numpy()
        w_speed = speed[mask].to_numpy()
        w_load  = load[mask].to_numpy()

        first_fuel = float(w_fuel[0])
        cumulative_drop = first_fuel - float(fi)
        if cumulative_drop < PHYSICS_MIN_DROP_PCT:
            continue

        duration_sec = max(5.0, (pd.Timestamp(w_time[-1]) -
                                 pd.Timestamp(w_time[0])).total_seconds())
        burn_per_min = _burn_envelope_pct_per_min(
            float(np.mean(w_speed)), float(np.mean(w_load))
        )
        max_expected_drop = burn_per_min * (duration_sec / 60.0)
        if cumulative_drop < max_expected_drop * PHYSICS_EXCESS_FACTOR:
            continue

        # Per-trip 45-s dedup
        if last_alert_ts is not None and \
           (ti - last_alert_ts).total_seconds() < PHYSICS_DEDUP_SEC:
            # Still back-prop drop rows in the current window
            pass
        else:
            last_alert_ts = ti

        # Back-prop: flag rows in the window whose fuel is materially below
        # the window max (matches the physics-tripwire back-prop in
        # server.js after commit 8e7d244)
        max_fuel_win = float(np.nanmax(w_fuel))
        win_positions = np.flatnonzero(mask.to_numpy())
        for pos in win_positions:
            if float(fuel.iloc[pos]) <= max_fuel_win - PHYSICS_MIN_DROP_PCT:
                flags[pos] = True

    return pd.Series(flags, index=frame["index"])


# Metrics helpers
def _confusion(pred: np.ndarray, label: np.ndarray) -> dict:
    tp = int(np.sum(pred & label))
    fp = int(np.sum(pred & ~label))
    fn = int(np.sum(~pred & label))
    tn = int(np.sum(~pred & ~label))
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn}


def _prf(conf: dict) -> dict:
    tp, fp, fn, tn = conf["tp"], conf["fp"], conf["fn"], conf["tn"]
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall    = tp / (tp + fn) if (tp + fn) else 0.0
    f1        = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    fpr       = fp / (fp + tn) if (fp + tn) else 0.0
    return {
        "precision": precision,
        "recall":    recall,
        "f1":        f1,
        "fpr":       fpr,
    }


# Main driver
def build_ablation_frame() -> pd.DataFrame:
    if_df = pd.read_csv(IF_PRED_CSV,
        usecols=["truck_id", "trip_id", "timestamp",
                 "fuel_level", "speed_kmph", "engine_load_pct",
                 "iforest_flag", "anomaly_label", "evaluation_subset"])

    # MP row-level flags -- bring in only the needed columns
    mp_df = pd.read_csv(MP_PRED_CSV,
        usecols=["truck_id", "trip_id", "timestamp", "mp_anomaly_flag"])

    # Hybrid predictions (already IF | MP union at the row level)
    hy_df = pd.read_csv(HYBRID_PRED_CSV,
        usecols=["truck_id", "trip_id", "timestamp",
                 "hybrid_union_flag"])

    key = ["truck_id", "trip_id", "timestamp"]
    merged = (if_df
              .merge(mp_df, on=key, how="left")
              .merge(hy_df, on=key, how="left"))

    merged["iforest_flag"]      = merged["iforest_flag"].fillna(False).astype(bool)
    merged["mp_anomaly_flag"]   = merged["mp_anomaly_flag"].fillna(False).astype(bool)
    merged["hybrid_union_flag"] = merged["hybrid_union_flag"].fillna(False).astype(bool)
    merged["anomaly_label"]     = merged["anomaly_label"].fillna(False).astype(bool)

    # Physics tripwire -- port of backend logic, applied per trip
    print("[ablation] computing physics-tripwire predictions per trip ...")
    phys_flags = np.zeros(len(merged), dtype=bool)
    for trip_id, trip_df in merged.groupby("trip_id", sort=False):
        trip_pred = _apply_physics_tripwire(trip_df)
        phys_flags[trip_pred.index] = trip_pred.values
    merged["physics_flag"] = phys_flags

    return merged


def evaluate_configs(frame: pd.DataFrame) -> dict:
    project_native = frame[frame["evaluation_subset"].isin(
        ("project_native_injected", "project_native_clean"))].copy()

    label = project_native["anomaly_label"].to_numpy().astype(bool)

    results = {"n_rows_project_native": int(len(project_native))}
    for cfg in CONFIGS:
        pred = project_native[cfg.flag_col].to_numpy().astype(bool)
        conf = _confusion(pred, label)
        prf  = _prf(conf)
        results[cfg.key] = {"label": cfg.label, **conf, **prf}
    return results


def emit_latex_table(results: dict) -> str:
    """Emit a LaTeX table body matching the thesis's table style."""
    lines = [
        r"\begin{table}[!htbp]",
        r"\centering",
        r"\caption{Ablation of Detector Configurations on LOTO Project-Native Partition}",
        r"\label{tab:ablation_detector_configs}",
        r"\small",
        r"\begin{tabular}{|p{0.34\textwidth}|c|c|c|c|c|c|c|c|}",
        r"\hline",
        r"\textbf{Configuration} & \textbf{TP} & \textbf{FP} & \textbf{FN} & "
        r"\textbf{TN} & \textbf{P} & \textbf{R} & \textbf{F1} & \textbf{FPR} \\",
        r"\hline",
    ]
    for cfg in CONFIGS:
        r = results[cfg.key]
        lines.append(
            f"{cfg.label} & {r['tp']} & {r['fp']} & {r['fn']} & {r['tn']} & "
            f"{r['precision']*100:.1f}\\% & {r['recall']*100:.1f}\\% & "
            f"{r['f1']*100:.1f}\\% & {r['fpr']*100:.2f}\\% \\\\"
        )
        lines.append(r"\hline")
    lines.append(r"\end{tabular}")
    lines.append(r"\end{table}")
    return "\n".join(lines)


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[ablation] reading LOTO predictions from {PRED_DIR}")
    frame = build_ablation_frame()

    print(f"[ablation] rows in merged frame: {len(frame):,}")
    results = evaluate_configs(frame)

    print()
    print(f"{'Config':<30s} {'TP':>4s} {'FP':>4s} {'FN':>4s} {'TN':>5s}  "
          f"{'P':>7s} {'R':>7s} {'F1':>7s} {'FPR':>7s}")
    print("-" * 90)
    for cfg in CONFIGS:
        r = results[cfg.key]
        print(f"{cfg.label:<30s} {r['tp']:>4d} {r['fp']:>4d} {r['fn']:>4d} "
              f"{r['tn']:>5d}  {r['precision']*100:>6.1f}% "
              f"{r['recall']*100:>6.1f}% {r['f1']*100:>6.1f}% "
              f"{r['fpr']*100:>6.2f}%")

    with OUT_JSON.open("w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

    csv_rows = []
    for cfg in CONFIGS:
        r = results[cfg.key]
        csv_rows.append({"config": cfg.key, "label": cfg.label,
                         **{k: v for k, v in r.items() if k != "label"}})
    pd.DataFrame(csv_rows).to_csv(OUT_CSV, index=False)

    frame.to_csv(OUT_PRED, index=False)

    latex = emit_latex_table(results)
    (REPORT_DIR / "metrics_ablation_table.tex").write_text(latex, encoding="utf-8")

    print()
    print(f"[ablation] wrote {OUT_JSON}")
    print(f"[ablation] wrote {OUT_CSV}")
    print(f"[ablation] wrote {OUT_PRED} ({len(frame):,} rows)")
    print(f"[ablation] wrote {REPORT_DIR / 'metrics_ablation_table.tex'}")


if __name__ == "__main__":
    main()
