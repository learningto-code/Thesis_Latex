from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from fuel_kalman import KalmanFuelFilter


HERE = Path(__file__).parent
DATA = HERE / "outputs" / "predictions" / "loto" / "evaluation_predictions_iforest_c_loto.csv"
REPORT_DIR = HERE / "reports"
FIG_DIR    = REPORT_DIR / "figures"

OUT_JSON = REPORT_DIR / "filter_comparison.json"
OUT_CSV  = REPORT_DIR / "filter_comparison.csv"
OUT_TEX  = REPORT_DIR / "filter_comparison_table.tex"


# Filter implementations
def moving_average(fuel: np.ndarray, window: int = 5) -> np.ndarray:
    """Match the deployed _moving_average in preprocess.py."""
    s = pd.Series(fuel).rolling(window=window, min_periods=1).mean()
    return s.to_numpy()


def kalman(fuel: np.ndarray,
           times: pd.Series,
           speed: np.ndarray,
           load: np.ndarray) -> np.ndarray:
    kf = KalmanFuelFilter()
    return kf.filter_trip(times, fuel, speed, load)


# Axis 1: noise reduction on stationary segments
def noise_rms(frame: pd.DataFrame, filter_col: str) -> float:
    stationary = (frame["speed_kmph"].fillna(0.0) < 1.0) & \
                 (frame["engine_status"].astype(str).str.lower().isin(
                     ["off", "idle"]))
    if stationary.sum() < 2:
        return float("nan")
    seg = frame[stationary].copy()
    diffs = seg.groupby("trip_id")[filter_col].diff().dropna()
    if diffs.empty:
        return float("nan")
    return float(np.sqrt(np.mean(diffs.to_numpy() ** 2)))


# Axis 2: signal preservation on injected anomalies
def signal_preservation(frame: pd.DataFrame, filter_col: str) -> float:
    ratios: list[float] = []
    for trip_id, trip_df in frame.groupby("trip_id", sort=False):
        anomaly_rows = trip_df.index[trip_df["anomaly_label"] == True]
        if len(anomaly_rows) == 0:
            continue
        raw = trip_df["fuel_level"].to_numpy()
        flt = trip_df[filter_col].to_numpy()
        # Map global index -> local index within trip
        local = {gi: li for li, gi in enumerate(trip_df.index)}
        for gi in anomaly_rows:
            li = local[gi]
            lo = max(0, li - 5); hi = min(len(raw) - 1, li + 5)
            raw_drop = raw[lo] - raw[hi]
            flt_drop = flt[lo] - flt[hi]
            if raw_drop > 0.5:   # only meaningful drops enter the ratio
                ratios.append(flt_drop / raw_drop)
    if not ratios:
        return float("nan")
    return float(np.median(ratios))


# Axis 3: responsiveness (settling time) on refuel step responses
def settling_time_sec(frame: pd.DataFrame, filter_col: str,
                      settle_frac: float = 0.9) -> float:
    times = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
    settle_secs: list[float] = []

    for trip_id, trip_df in frame.groupby("trip_id", sort=False):
        raw = trip_df["fuel_level"].to_numpy()
        flt = trip_df[filter_col].to_numpy()
        t   = pd.to_datetime(trip_df["timestamp"], utc=True, errors="coerce").to_numpy()
        deltas = np.diff(raw, prepend=raw[0])
        refuel_positions = np.flatnonzero(deltas > 10.0)
        for pos in refuel_positions:
            baseline = flt[pos - 1] if pos > 0 else flt[pos]
            target = raw[pos]
            step   = target - baseline
            if step <= 0:
                continue
            settle_target = baseline + settle_frac * step
            # Walk forward until the filter reaches settle_target
            reached = False
            for j in range(pos, min(pos + 60, len(flt))):
                if flt[j] >= settle_target:
                    dt = (pd.Timestamp(t[j]) - pd.Timestamp(t[pos])).total_seconds()
                    settle_secs.append(max(0.0, dt))
                    reached = True
                    break
            if not reached:
                settle_secs.append(300.0)

    if not settle_secs:
        return float("nan")
    return float(np.median(settle_secs))


# Axis 4: downstream IF-C detection when re-fed the filtered stream
def downstream_detection(frame: pd.DataFrame,
                          filter_col: str) -> dict:
    from loto_ablation import _apply_physics_tripwire
    # _apply_physics_tripwire expects a column named fuel_level; alias it
    aliased = frame.copy()
    aliased["fuel_level"] = aliased[filter_col]

    project_native = aliased[aliased["evaluation_subset"].isin(
        ("project_native_injected", "project_native_clean"))]

    flags = np.zeros(len(project_native), dtype=bool)
    for _, trip_df in project_native.groupby("trip_id", sort=False):
        pred = _apply_physics_tripwire(trip_df)
        for idx, val in pred.items():
            if idx in project_native.index:
                position = project_native.index.get_loc(idx)
                flags[position] = flags[position] or val

    labels = project_native["anomaly_label"].to_numpy().astype(bool)
    tp = int(np.sum(flags & labels))
    fp = int(np.sum(flags & ~labels))
    fn = int(np.sum(~flags & labels))
    tn = int(np.sum(~flags & ~labels))
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall    = tp / (tp + fn) if (tp + fn) else 0.0
    f1        = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    fpr       = fp / (fp + tn) if (fp + tn) else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": precision, "recall": recall,
            "f1": f1, "fpr": fpr}


# Overlay plots
def plot_overlays(frame: pd.DataFrame) -> None:
    FIG_DIR.mkdir(parents=True, exist_ok=True)

    plot_frame = frame[frame["evaluation_subset"].isin(
        ("project_native_injected", "project_native_clean"))].reset_index(drop=True)
    scenarios = []

    # (i) Steady-driving baseline: the calmest window in the project-native
    # smallest raw fuel first-difference variance so the plot shows a clean
    # subset has only twelve genuinely stationary (engine-idle) rows total,
    # so a strict "idle segment" scenario cannot be sampled from this
    # partition; a steady-driving baseline gives the reader the same "how
    # does the filter behave when nothing is going wrong" reference.
    WIN = 60
    best_win = None   # (variance, trip_id, start_idx)
    for tid, gdf in plot_frame.groupby("trip_id", sort=False):
        idx = gdf.index.to_numpy()
        if len(idx) < WIN:
            continue
        raw = plot_frame.loc[idx, "fuel_level"].to_numpy()
        diffs = np.diff(raw)
        # Iterate windows of size WIN over the diff array
        for start in range(0, len(diffs) - WIN + 1, 5):
            var = float(np.var(diffs[start:start + WIN]))
            if best_win is None or var < best_win[0]:
                best_win = (var, tid, idx[start])
    if best_win is not None:
        _, tid, lo = best_win
        hi = lo + WIN
        base_df = plot_frame.loc[lo:hi].copy()
        scenarios.append(("baseline", "Steady-driving baseline",
                          base_df))

    # (ii) Rapid siphon: pick an anomalous trip
    anom_trips = plot_frame[plot_frame["anomaly_label"] == True]["trip_id"].unique()
    if len(anom_trips) > 0:
        anom_df = plot_frame[plot_frame["trip_id"] == anom_trips[0]].copy()
        scenarios.append(("rapid_siphon", "Rapid injected fuel loss",
                          anom_df))

    # (iii) Gradual leak: another anomalous trip
    if len(anom_trips) > 2:
        grad_df = plot_frame[plot_frame["trip_id"] == anom_trips[2]].copy()
        scenarios.append(("gradual_leak", "Gradual injected leak",
                          grad_df))

    # (iv) Refuel step
    refuel_trip = None
    for tid, gdf in plot_frame.groupby("trip_id", sort=False):
        raw = gdf["fuel_level"].to_numpy()
        if np.any(np.diff(raw, prepend=raw[0]) > 10.0):
            refuel_trip = tid
            break
    if refuel_trip is not None:
        ref_df = plot_frame[plot_frame["trip_id"] == refuel_trip].copy()
        scenarios.append(("refuel_step", "Refuel step response",
                          ref_df))

    for key, title, df in scenarios:
        df = df.sort_values("timestamp").reset_index(drop=True)
        times = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
        t_min = (times - times.iloc[0]).dt.total_seconds() / 60.0

        fig, ax = plt.subplots(figsize=(9, 4.5))
        # Use markers alongside lines so nearly-flat traces still register visually
        ax.plot(t_min, df["fuel_level"], color="#B0B7C3",
                linewidth=1.0, marker="o", markersize=3,
                label="raw sender")
        ax.plot(t_min, df["fuel_ma"], color="#1F365D",
                linewidth=1.8, marker="s", markersize=3,
                label="moving average")
        ax.plot(t_min, df["fuel_kf"], color="#D9603D",
                linewidth=1.8, marker="^", markersize=3,
                label="Kalman filter")
        ax.set_xlabel("time within segment (min)")
        ax.set_ylabel("fuel level (%)")
        ax.set_title(f"Filter overlay --- {title}")
        ax.grid(True, alpha=0.3)
        ax.legend(loc="best", framealpha=0.9)
        y_all = pd.concat([df["fuel_level"], df["fuel_ma"], df["fuel_kf"]])
        y_min, y_max = float(y_all.min()), float(y_all.max())
        pad = max(0.5, (y_max - y_min) * 0.15)
        ax.set_ylim(y_min - pad, y_max + pad)
        fig.tight_layout()
        fig.savefig(FIG_DIR / f"filter_overlay_{key}.png", dpi=140)
        plt.close(fig)
        print(f"[filter] wrote figures/filter_overlay_{key}.png")


# Main driver
def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[filter] loading {DATA}")
    usecols = ["truck_id", "trip_id", "timestamp",
               "fuel_level", "speed_kmph", "engine_status",
               "engine_load_pct", "anomaly_label",
               "evaluation_subset", "trip_source_category"]
    frame = pd.read_csv(DATA, usecols=usecols)

    # Sort per trip so time-series operations are correct
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True,
                                         errors="coerce")
    frame = frame.sort_values(["trip_id", "timestamp"]).reset_index(drop=True)

    # Apply both filters per trip
    print("[filter] applying moving average + Kalman per trip ...")
    fuel_ma = np.empty(len(frame), dtype=float)
    fuel_kf = np.empty(len(frame), dtype=float)

    for trip_id, gdf in frame.groupby("trip_id", sort=False):
        idx = gdf.index.to_numpy()
        raw   = pd.to_numeric(gdf["fuel_level"], errors="coerce").to_numpy()
        speed = pd.to_numeric(gdf["speed_kmph"], errors="coerce").fillna(0.0).to_numpy()
        load  = pd.to_numeric(gdf["engine_load_pct"], errors="coerce").fillna(30.0).to_numpy()
        times = gdf["timestamp"]

        fuel_ma[idx] = moving_average(raw, window=5)
        fuel_kf[idx] = kalman(raw, times, speed, load)

    frame["fuel_ma"] = fuel_ma
    frame["fuel_kf"] = fuel_kf

    # Compute the four axes
    print("[filter] computing comparison axes ...")
    results = {}
    for name, col in (("moving_average", "fuel_ma"), ("kalman", "fuel_kf")):
        results[name] = {
            "noise_rms":            noise_rms(frame, col),
            "signal_preservation":  signal_preservation(frame, col),
            "settling_time_sec":    settling_time_sec(frame, col),
            "downstream":           downstream_detection(frame, col),
        }

    # Print summary
    print()
    print(f"{'Metric':<32s} {'Moving Avg':>14s} {'Kalman':>14s}")
    print("-" * 62)
    print(f"{'Noise RMS on stationary (%)':<32s} "
          f"{results['moving_average']['noise_rms']:>14.4f} "
          f"{results['kalman']['noise_rms']:>14.4f}")
    print(f"{'Signal preservation ratio':<32s} "
          f"{results['moving_average']['signal_preservation']:>14.4f} "
          f"{results['kalman']['signal_preservation']:>14.4f}")
    print(f"{'Refuel 90%-settling time (s)':<32s} "
          f"{results['moving_average']['settling_time_sec']:>14.2f} "
          f"{results['kalman']['settling_time_sec']:>14.2f}")
    for k in ("precision", "recall", "f1", "fpr"):
        print(f"{'Downstream ' + k:<32s} "
              f"{results['moving_average']['downstream'][k]*100:>13.1f}% "
              f"{results['kalman']['downstream'][k]*100:>13.1f}%")

    # Persist outputs
    with OUT_JSON.open("w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

    rows = []
    for name in ("moving_average", "kalman"):
        r = results[name]
        rows.append({
            "filter": name,
            "noise_rms":           r["noise_rms"],
            "signal_preservation": r["signal_preservation"],
            "settling_time_sec":   r["settling_time_sec"],
            "downstream_precision": r["downstream"]["precision"],
            "downstream_recall":    r["downstream"]["recall"],
            "downstream_f1":        r["downstream"]["f1"],
            "downstream_fpr":       r["downstream"]["fpr"],
        })
    pd.DataFrame(rows).to_csv(OUT_CSV, index=False)

    # LaTeX-ready table
    def _fmt(v, pct=False):
        if isinstance(v, float) and (np.isnan(v)):
            return "---"
        if pct:
            return f"{v*100:.1f}\\%"
        return f"{v:.4f}"

    ma = results["moving_average"]; kf = results["kalman"]
    latex = "\n".join([
        r"\begin{table}[!htbp]",
        r"\centering",
        r"\caption{Kalman Filter vs Moving Average \textemdash{} Four-Axis Comparison}",
        r"\label{tab:filter_comparison_four_axes}",
        r"\small",
        r"\begin{tabular}{|p{0.42\textwidth}|c|c|}",
        r"\hline",
        r"\textbf{Metric} & \textbf{Moving Average} & \textbf{Kalman Filter} \\",
        r"\hline",
        f"Noise RMS on stationary segments (\\%) & {_fmt(ma['noise_rms'])} & {_fmt(kf['noise_rms'])} \\\\",
        r"\hline",
        f"Signal preservation ratio (closer to 1 wins) & {_fmt(ma['signal_preservation'])} & {_fmt(kf['signal_preservation'])} \\\\",
        r"\hline",
        f"Refuel 90\\%-settling time (s) & {_fmt(ma['settling_time_sec'])} & {_fmt(kf['settling_time_sec'])} \\\\",
        r"\hline",
        f"Downstream precision & {_fmt(ma['downstream']['precision'], pct=True)} & {_fmt(kf['downstream']['precision'], pct=True)} \\\\",
        r"\hline",
        f"Downstream recall & {_fmt(ma['downstream']['recall'], pct=True)} & {_fmt(kf['downstream']['recall'], pct=True)} \\\\",
        r"\hline",
        f"Downstream F1 & {_fmt(ma['downstream']['f1'], pct=True)} & {_fmt(kf['downstream']['f1'], pct=True)} \\\\",
        r"\hline",
        f"Downstream FPR & {_fmt(ma['downstream']['fpr'], pct=True)} & {_fmt(kf['downstream']['fpr'], pct=True)} \\\\",
        r"\hline",
        r"\end{tabular}",
        r"\end{table}",
    ])
    OUT_TEX.write_text(latex, encoding="utf-8")

    # Overlay plots
    plot_overlays(frame)

    print()
    print(f"[filter] wrote {OUT_JSON}")
    print(f"[filter] wrote {OUT_CSV}")
    print(f"[filter] wrote {OUT_TEX}")


if __name__ == "__main__":
    main()
