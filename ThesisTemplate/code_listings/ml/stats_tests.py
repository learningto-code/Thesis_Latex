from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


HERE = Path(__file__).parent
REPORT_DIR = HERE / "reports"

ABLATION_PRED_CSV = REPORT_DIR / "ablation_predictions.csv"

OUT_JSON = REPORT_DIR / "stats_tests.json"
OUT_TEX  = REPORT_DIR / "stats_tests_table.tex"

CONFIG_FLAG_COLS = {
    "physics": "physics_flag",
    "iforest": "iforest_flag",
    "mp":      "mp_anomaly_flag",
    "hybrid":  "hybrid_union_flag",
}
CONFIG_LABEL = {
    "physics": "Physics tripwire",
    "iforest": "Isolation Forest",
    "mp":      "Matrix Profile",
    "hybrid":  "IF $+$ MP hybrid",
}


# McNemar's test
def mcnemar(pred_a: np.ndarray, pred_b: np.ndarray,
             label: np.ndarray) -> dict:
    corr_a = pred_a == label
    corr_b = pred_b == label
    b = int(np.sum(corr_a & ~corr_b))
    c = int(np.sum(~corr_a & corr_b))
    n_disagree = b + c
    if n_disagree == 0:
        return {"b": 0, "c": 0, "n_disagree": 0,
                "chi_square": 0.0, "p_value": 1.0, "method": "identical"}
    if n_disagree < 25:
        # Exact binomial: P(X <= min(b,c)) * 2 clipped at 1
        k = min(b, c)
        p = 2.0 * stats.binom.cdf(k, n_disagree, 0.5)
        p = float(min(1.0, p))
        return {"b": b, "c": c, "n_disagree": n_disagree,
                "chi_square": None, "p_value": p,
                "method": "exact_binomial"}
    chi2 = ((abs(b - c) - 1) ** 2) / n_disagree
    p = float(1.0 - stats.chi2.cdf(chi2, df=1))
    return {"b": b, "c": c, "n_disagree": n_disagree,
            "chi_square": chi2, "p_value": p,
            "method": "chi_square_yates"}


# Bootstrap CIs on precision / recall / F1
def bootstrap_prf(pred: np.ndarray, label: np.ndarray,
                   n_boot: int = 2000, alpha: float = 0.05,
                   seed: int = 42) -> dict:
    rng = np.random.default_rng(seed)
    n = len(pred)
    prec, rec, f1s = [], [], []
    for _ in range(n_boot):
        idx = rng.integers(0, n, size=n)
        p = pred[idx]; l = label[idx]
        tp = int(np.sum(p & l)); fp = int(np.sum(p & ~l)); fn = int(np.sum(~p & l))
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall    = tp / (tp + fn) if (tp + fn) else 0.0
        f = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        prec.append(precision); rec.append(recall); f1s.append(f)
    def _ci(v):
        lo = float(np.percentile(v, 100.0 * alpha / 2))
        hi = float(np.percentile(v, 100.0 * (1 - alpha / 2)))
        return {"lo": lo, "hi": hi, "mean": float(np.mean(v))}
    return {"precision": _ci(prec), "recall": _ci(rec), "f1": _ci(f1s),
            "n_boot": n_boot}


# Wilcoxon on per-trip F1 (MA vs KF)
def wilcoxon_per_trip_f1(ma_frame: pd.DataFrame,
                          kf_frame: pd.DataFrame) -> dict:
    trips = sorted(set(ma_frame["trip_id"].unique())
                   & set(kf_frame["trip_id"].unique()))
    ma_f1, kf_f1 = [], []

    def _f1(pred, label):
        tp = int(np.sum(pred & label)); fp = int(np.sum(pred & ~label))
        fn = int(np.sum(~pred & label))
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall    = tp / (tp + fn) if (tp + fn) else 0.0
        return 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0

    for t in trips:
        ma_t = ma_frame[ma_frame["trip_id"] == t]
        kf_t = kf_frame[kf_frame["trip_id"] == t]
        if len(ma_t) == 0 or len(kf_t) == 0:
            continue
        ma_pred = ma_t["pred"].to_numpy().astype(bool)
        kf_pred = kf_t["pred"].to_numpy().astype(bool)
        label   = ma_t["anomaly_label"].to_numpy().astype(bool)
        ma_f1.append(_f1(ma_pred, label))
        # KF pred aligns with same trip's rows; take its own labels
        kf_label = kf_t["anomaly_label"].to_numpy().astype(bool)
        kf_f1.append(_f1(kf_pred, kf_label))

    if len(ma_f1) < 3:
        return {"n_trips": len(ma_f1),
                "note": "insufficient trips for Wilcoxon signed-rank"}

    diffs = np.array(kf_f1) - np.array(ma_f1)
    if np.all(diffs == 0):
        return {"n_trips": int(len(ma_f1)),
                "median_ma_f1": float(np.median(ma_f1)),
                "median_kf_f1": float(np.median(kf_f1)),
                "median_diff": 0.0,
                "statistic": None, "p_value": 1.0,
                "note": "all per-trip F1 differences are zero"}
    stat = stats.wilcoxon(ma_f1, kf_f1, zero_method="wilcox")
    return {"n_trips": int(len(ma_f1)),
            "median_ma_f1":  float(np.median(ma_f1)),
            "median_kf_f1":  float(np.median(kf_f1)),
            "median_diff":   float(np.median(diffs)),
            "statistic":     float(stat.statistic),
            "p_value":       float(stat.pvalue)}


# Filter-comparison per-row predictions (rebuild for Wilcoxon input)
def build_filter_predictions() -> tuple[pd.DataFrame, pd.DataFrame]:
    from loto_ablation import _apply_physics_tripwire
    from filter_comparison import moving_average, kalman

    src = HERE / "outputs" / "predictions" / "loto" / "evaluation_predictions_iforest_c_loto.csv"
    df = pd.read_csv(src,
        usecols=["truck_id", "trip_id", "timestamp",
                 "fuel_level", "speed_kmph", "engine_load_pct",
                 "anomaly_label", "evaluation_subset"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.sort_values(["trip_id", "timestamp"]).reset_index(drop=True)

    fuel_ma = np.empty(len(df), dtype=float)
    fuel_kf = np.empty(len(df), dtype=float)
    for _, gdf in df.groupby("trip_id", sort=False):
        idx = gdf.index.to_numpy()
        raw   = pd.to_numeric(gdf["fuel_level"], errors="coerce").to_numpy()
        speed = pd.to_numeric(gdf["speed_kmph"], errors="coerce").fillna(0.0).to_numpy()
        load  = pd.to_numeric(gdf["engine_load_pct"], errors="coerce").fillna(30.0).to_numpy()
        times = gdf["timestamp"]
        fuel_ma[idx] = moving_average(raw, window=5)
        fuel_kf[idx] = kalman(raw, times, speed, load)

    df["fuel_ma"] = fuel_ma
    df["fuel_kf"] = fuel_kf

    ma_df = df.copy(); kf_df = df.copy()
    ma_df["fuel_level"] = ma_df["fuel_ma"]
    kf_df["fuel_level"] = kf_df["fuel_kf"]

    ma_flags = np.zeros(len(ma_df), dtype=bool)
    kf_flags = np.zeros(len(kf_df), dtype=bool)
    for tid, gdf in ma_df.groupby("trip_id", sort=False):
        pred = _apply_physics_tripwire(gdf)
        for i, v in pred.items():
            ma_flags[i] = v
    for tid, gdf in kf_df.groupby("trip_id", sort=False):
        pred = _apply_physics_tripwire(gdf)
        for i, v in pred.items():
            kf_flags[i] = v

    ma_df["pred"] = ma_flags
    kf_df["pred"] = kf_flags

    project_native = ("project_native_injected", "project_native_clean")
    ma_df = ma_df[ma_df["evaluation_subset"].isin(project_native)]
    kf_df = kf_df[kf_df["evaluation_subset"].isin(project_native)]
    return ma_df, kf_df


# Main driver
def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[stats] loading {ABLATION_PRED_CSV}")
    pred = pd.read_csv(ABLATION_PRED_CSV)
    project_native = pred[pred["evaluation_subset"].isin(
        ("project_native_injected", "project_native_clean"))].copy()
    label = project_native["anomaly_label"].to_numpy().astype(bool)

    # McNemar for every ordered detector pair
    print("[stats] McNemar pairs ...")
    mcnemar_results = {}
    keys = list(CONFIG_FLAG_COLS.keys())
    for i, a in enumerate(keys):
        for b in keys[i+1:]:
            pa = project_native[CONFIG_FLAG_COLS[a]].to_numpy().astype(bool)
            pb = project_native[CONFIG_FLAG_COLS[b]].to_numpy().astype(bool)
            mcnemar_results[f"{a}_vs_{b}"] = mcnemar(pa, pb, label)

    # Bootstrap CIs per detector
    print("[stats] bootstrap CIs ...")
    boot_results = {}
    for k, col in CONFIG_FLAG_COLS.items():
        p = project_native[col].to_numpy().astype(bool)
        boot_results[k] = bootstrap_prf(p, label)

    # Wilcoxon on per-trip F1 (MA vs KF)
    print("[stats] Wilcoxon on per-trip F1 (MA vs KF) ...")
    ma_df, kf_df = build_filter_predictions()
    wilcoxon_result = wilcoxon_per_trip_f1(ma_df, kf_df)

    # Persist
    out = {
        "mcnemar": mcnemar_results,
        "bootstrap_ci": boot_results,
        "wilcoxon_ma_vs_kf": wilcoxon_result,
    }
    with OUT_JSON.open("w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    # Print concise summary
    print()
    print("?? McNemar (p-values) ??")
    for pair, r in mcnemar_results.items():
        chi = f"chi2={r['chi_square']:.2f} " if r["chi_square"] is not None else ""
        print(f"  {pair:>18s}  b={r['b']:>3d} c={r['c']:>3d}  {chi}p={r['p_value']:.4f} ({r['method']})")
    print()
    print("?? Bootstrap 95% CIs ??")
    for k, r in boot_results.items():
        print(f"  {k:>10s}  P={r['precision']['mean']*100:5.1f}% [{r['precision']['lo']*100:5.1f}, {r['precision']['hi']*100:5.1f}]  "
              f"R={r['recall']['mean']*100:5.1f}% [{r['recall']['lo']*100:5.1f}, {r['recall']['hi']*100:5.1f}]  "
              f"F1={r['f1']['mean']*100:5.1f}% [{r['f1']['lo']*100:5.1f}, {r['f1']['hi']*100:5.1f}]")
    print()
    print("?? Wilcoxon (MA vs KF, per-trip F1) ??")
    for k, v in wilcoxon_result.items():
        print(f"  {k:>16s}: {v}")

    # LaTeX table
    def _fmt_p(p):
        if p is None:
            return "---"
        if p < 0.001:
            return "$<$0.001"
        return f"{p:.3f}"

    latex_lines = [
        r"\begin{table}[!htbp]",
        r"\centering",
        r"\caption{Statistical Tests on the Detector Ablation and Filter Comparison}",
        r"\label{tab:stats_tests}",
        r"\small",
        r"\begin{tabular}{|p{0.38\textwidth}|c|c|c|}",
        r"\hline",
        r"\multicolumn{4}{|l|}{\textbf{McNemar $\chi^2$ on paired predictions (project-native rows)}} \\",
        r"\hline",
        r"\textbf{Pair} & \textbf{$b$} & \textbf{$c$} & \textbf{$p$-value} \\",
        r"\hline",
    ]
    for pair, r in mcnemar_results.items():
        a, b_ = pair.split("_vs_")
        pair_str = f"{CONFIG_LABEL[a]} vs {CONFIG_LABEL[b_]}"
        latex_lines.append(f"{pair_str} & {r['b']} & {r['c']} & {_fmt_p(r['p_value'])} \\\\")
        latex_lines.append(r"\hline")

    latex_lines.extend([
        r"\multicolumn{4}{|l|}{\textbf{Bootstrap 95\% CIs (2000 resamples, project-native rows)}} \\",
        r"\hline",
        r"\textbf{Configuration} & \textbf{Precision (95\% CI)} & \textbf{Recall (95\% CI)} & \textbf{F1 (95\% CI)} \\",
        r"\hline",
    ])
    for k, r in boot_results.items():
        p = r["precision"]; rc = r["recall"]; f1 = r["f1"]
        latex_lines.append(
            f"{CONFIG_LABEL[k]} & "
            f"{p['mean']*100:.1f}\\% [{p['lo']*100:.1f}, {p['hi']*100:.1f}] & "
            f"{rc['mean']*100:.1f}\\% [{rc['lo']*100:.1f}, {rc['hi']*100:.1f}] & "
            f"{f1['mean']*100:.1f}\\% [{f1['lo']*100:.1f}, {f1['hi']*100:.1f}] \\\\"
        )
        latex_lines.append(r"\hline")

    latex_lines.extend([
        r"\multicolumn{4}{|l|}{\textbf{Wilcoxon signed-rank on per-trip F1 (MA vs KF filter)}} \\",
        r"\hline",
        r"\textbf{Metric} & \multicolumn{3}{c|}{\textbf{Value}} \\",
        r"\hline",
    ])
    w = wilcoxon_result
    if "note" in w and "insufficient" in w["note"]:
        latex_lines.append(f"n\\_trips & \\multicolumn{{3}}{{c|}}{{{w.get('n_trips', 0)} ({w['note']})}} \\\\")
    else:
        latex_lines.append(f"Trips paired & \\multicolumn{{3}}{{c|}}{{{w['n_trips']}}} \\\\")
        latex_lines.append(r"\hline")
        latex_lines.append(f"Median F1 (MA) & \\multicolumn{{3}}{{c|}}{{{w['median_ma_f1']*100:.1f}\\%}} \\\\")
        latex_lines.append(r"\hline")
        latex_lines.append(f"Median F1 (KF) & \\multicolumn{{3}}{{c|}}{{{w['median_kf_f1']*100:.1f}\\%}} \\\\")
        latex_lines.append(r"\hline")
        latex_lines.append(f"Median per-trip diff (KF $-$ MA) & \\multicolumn{{3}}{{c|}}{{{w['median_diff']*100:.1f} pp}} \\\\")
        latex_lines.append(r"\hline")
        if w.get('statistic') is not None:
            latex_lines.append(f"Wilcoxon $W$ statistic & \\multicolumn{{3}}{{c|}}{{{w['statistic']:.2f}}} \\\\")
            latex_lines.append(r"\hline")
        latex_lines.append(f"$p$-value & \\multicolumn{{3}}{{c|}}{{{_fmt_p(w['p_value'])}}} \\\\")
    latex_lines.append(r"\hline")

    latex_lines.extend([r"\end{tabular}", r"\end{table}"])
    OUT_TEX.write_text("\n".join(latex_lines), encoding="utf-8")

    print()
    print(f"[stats] wrote {OUT_JSON}")
    print(f"[stats] wrote {OUT_TEX}")


if __name__ == "__main__":
    main()
