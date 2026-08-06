from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from evaluate import (
    REPORT_DIR,
    _build_subset_rows,
)
from matrix_profile import calibrate_matrix_profile, MatrixProfileDetector
from preprocess import (
    EVALUATION_DATASET_PATH,
    MODEL_DIR,
    MODEL_VARIANT_FEATURES,
    MODEL_VARIANT_NAMES,
    PREDICTION_DIR,
    engineer_features,
    ensure_directories,
    load_evaluation_dataset,
    load_trip_sessions,
)
from train_iforest import score_iforest


LOTO_BREAKDOWN_JSON = REPORT_DIR / "metrics_breakdown_loto.json"
LOTO_BREAKDOWN_CSV = REPORT_DIR / "metrics_breakdown_loto.csv"
LOTO_SUMMARY_JSON = REPORT_DIR / "loto_summary.json"
LOTO_PRED_DIR = PREDICTION_DIR / "loto"

# Fold-local IF hyperparameters -- same as VARIANT_HYPERPARAMS in train_iforest
# but pulled in-file so the LOTO entrypoint is self-contained.
_HP = {"contamination": 0.015, "n_estimators": 300, "max_features": 1.0, "max_samples": 256}


# Threshold quantile is internally consistent with the IF contamination prior:
# the 98.5-percentile of clean-only training scores is the boundary above
_THRESHOLD_QUANTILE = 0.985


def _fit_if_fold(train_frame: pd.DataFrame, feature_cols: list[str], variant: str) -> dict:
    available = [c for c in feature_cols if c in train_frame.columns]
    X = train_frame.reindex(columns=available, fill_value=0.0).fillna(0.0).to_numpy(dtype=float)
    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("model", IsolationForest(
            n_estimators=_HP["n_estimators"],
            contamination=_HP["contamination"],
            max_features=_HP["max_features"],
            max_samples=min(_HP["max_samples"], max(2, len(X))),
            random_state=42,
            n_jobs=-1,
        )),
    ])
    pipeline.fit(X)
    train_scores = -pipeline.decision_function(X)
    threshold = float(np.quantile(train_scores, _THRESHOLD_QUANTILE))
    return {
        "pipeline": pipeline,
        "features": list(available),
        "model_variant": variant,
        "model_variant_label": MODEL_VARIANT_NAMES.get(variant, variant),
        "score_threshold": threshold,
        "base_score_threshold": threshold,
        "training_score_threshold": threshold,
        "training_threshold_quantile": _THRESHOLD_QUANTILE,
        "threshold_quantile": _THRESHOLD_QUANTILE,
        "threshold_source": f"loto_quantile_{_THRESHOLD_QUANTILE}_no_margin",
        "context_thresholds": {},
    }


def _ctx_key_from_group(grp: pd.DataFrame) -> str | None:
    for col in ("source_threshold_key", "threshold_context_key", "context_key"):
        if col in grp.columns and not grp[col].dropna().empty:
            return str(grp[col].mode(dropna=True).iloc[0])
    return None


def _score_mp_trip(detector: MatrixProfileDetector, grp: pd.DataFrame) -> dict:
    grp = grp.sort_values("timestamp")
    ctx_key = _ctx_key_from_group(grp)
    analysis = detector.analyze_series(grp["fuel_level_filtered"].tolist(), context_key=ctx_key)
    z_scores = analysis["z_scores"]
    mp_score = float(z_scores.max()) if len(z_scores) else 0.0
    effective_threshold = float(analysis["effective_threshold_z"])
    # Use the gated flag (same definition the production detector uses) --
    gated_any = bool(np.any(analysis["flags"])) if len(analysis["flags"]) else False
    is_pn = str(grp["trip_source_category"].iloc[0]) == "project_native"
    is_injected = bool(grp["is_injected"].any()) if "is_injected" in grp.columns else False
    if not is_pn:
        sequence_subset = "public_clean"
    elif is_injected:
        sequence_subset = "project_native_injected"
    else:
        sequence_subset = "project_native_clean"
    anomaly_types = "|".join(sorted(set(
        grp.loc[grp["anomaly_label"].astype(bool), "anomaly_type"].astype(str)
    ))) or "normal"
    return {
        "truck_id": str(grp["truck_id"].iloc[0]),
        "trip_id": str(grp["trip_id"].iloc[0]),
        "context_key": ctx_key,
        "mp_score": mp_score,
        "mp_threshold": effective_threshold,
        "mp_signal_column": detector.signal_column,
        "mp_window_size": int(analysis["window_size"]),
        "mp_localization_window_size": int(detector.localization_window_size),
        "mp_anomaly_flag": gated_any,
        "anomaly_score": mp_score,
        "anomaly_flag": gated_any,
        "model_source": "matrix_profile",
        "anomaly_label": bool(grp["anomaly_label"].any()),
        "anomaly_type": anomaly_types,
        "sequence_length": int(len(grp)),
        "record_origin": str(grp["record_origin"].iloc[0]) if "record_origin" in grp.columns else "unknown",
        "source_dataset": str(grp["source_dataset"].iloc[0]) if "source_dataset" in grp.columns else "unknown",
        "trip_source_category": str(grp["trip_source_category"].iloc[0]),
        "evaluation_subset": sequence_subset,
        "trip_length_band": str(grp["trip_length_band"].iloc[0]) if "trip_length_band" in grp.columns else "unknown",
        "label_source": str(grp["label_source"].iloc[0]) if "label_source" in grp.columns else "unknown",
        "is_injected": is_injected,
    }


def _make_if_subsets(frame: pd.DataFrame) -> list[tuple[str, str, pd.DataFrame]]:
    return [
        ("overall", "all_rows", frame),
        ("project_native", "source_subset", frame[frame["trip_source_category"] == "project_native"].copy()),
        ("public_source", "source_subset", frame[frame["trip_source_category"] == "public_route"].copy()),
        ("project_native_clean", "benchmark_partition", frame[frame["evaluation_subset"] == "project_native_clean"].copy()),
        ("project_native_injected", "benchmark_partition", frame[frame["evaluation_subset"] == "project_native_injected"].copy()),
        ("public_clean", "benchmark_partition", frame[frame["evaluation_subset"] == "public_clean"].copy()),
    ]


def _make_mp_subsets(frame: pd.DataFrame) -> list[tuple[str, str, pd.DataFrame]]:
    return [
        ("overall", "all_trips", frame),
        ("project_native", "source_subset", frame[frame["trip_source_category"] == "project_native"].copy()),
        ("public_source", "source_subset", frame[frame["trip_source_category"] == "public_route"].copy()),
        ("project_native_clean", "benchmark_partition", frame[frame["evaluation_subset"] == "project_native_clean"].copy()),
        ("project_native_injected", "benchmark_partition", frame[frame["evaluation_subset"] == "project_native_injected"].copy()),
        ("public_clean", "benchmark_partition", frame[frame["evaluation_subset"] == "public_clean"].copy()),
    ]


def _make_hybrid_subsets(frame: pd.DataFrame) -> list[tuple[str, str, pd.DataFrame]]:
    _es = frame.get("evaluation_subset", pd.Series("unknown", index=frame.index))
    _ts = frame.get("trip_source_category", pd.Series("unknown", index=frame.index))
    return [
        ("overall", "all_rows", frame),
        ("project_native", "source_subset", frame[_ts == "project_native"].copy()),
        ("public_source", "source_subset", frame[_ts == "public_route"].copy()),
        ("project_native_clean", "benchmark_partition", frame[_es == "project_native_clean"].copy()),
        ("project_native_injected", "benchmark_partition", frame[_es == "project_native_injected"].copy()),
        ("public_clean", "benchmark_partition", frame[_es == "public_clean"].copy()),
    ]


def _wilson_ci(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n <= 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1.0 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = (z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def _summarise_partition(rows: list[dict], model: str, subset: str) -> dict:
    row = next((r for r in rows if r["model"] == model and r["subset_name"] == subset), {})
    tp = int(row.get("TP", 0)); fp = int(row.get("FP", 0))
    fn = int(row.get("FN", 0)); tn = int(row.get("TN", 0))
    prec_lo, prec_hi = _wilson_ci(tp, tp + fp)
    rec_lo, rec_hi = _wilson_ci(tp, tp + fn)
    fpr_lo, fpr_hi = _wilson_ci(fp, fp + tn)
    return {
        "TP": tp, "FP": fp, "FN": fn, "TN": tn,
        "precision": row.get("precision"),
        "precision_ci_95": [round(prec_lo, 4), round(prec_hi, 4)],
        "recall": row.get("recall"),
        "recall_ci_95": [round(rec_lo, 4), round(rec_hi, 4)],
        "false_positive_rate": row.get("false_positive_rate"),
        "false_positive_rate_ci_95": [round(fpr_lo, 4), round(fpr_hi, 4)],
        "f1": (
            2 * row["precision"] * row["recall"] / (row["precision"] + row["recall"])
            if row.get("precision") and row.get("recall") else None
        ),
        "roc_auc": row.get("roc_auc"),
        "pr_auc": row.get("pr_auc"),
    }


_ANOMALY_TYPES = {"sudden_fuel_drop", "gradual_leak", "abnormal_rapid_decrease"}


def _repair_eval_frame(raw: pd.DataFrame) -> pd.DataFrame:
    df = raw.copy()
    if "anomaly_type" in df.columns:
        derived = df["anomaly_type"].astype(str).str.lower().isin(_ANOMALY_TYPES)
        if "anomaly_label" in df.columns:
            df["anomaly_label"] = df["anomaly_label"].fillna(False).astype(bool) | derived
        else:
            df["anomaly_label"] = derived
    if "timestamp" in df.columns and "trip_id" in df.columns and "truck_id" in df.columns:
        missing_ts = df["timestamp"].isna()
        if missing_ts.any():
            base = pd.Timestamp("2026-01-01", tz="UTC")
            synth = pd.Series(pd.NaT, index=df.index, dtype="datetime64[ns, UTC]")
            for (_, _), idx in df[missing_ts].groupby(["truck_id", "trip_id"], dropna=False).groups.items():
                synth.loc[idx] = base + pd.to_timedelta(np.arange(len(idx)) * 5, unit="s")
            df.loc[missing_ts, "timestamp"] = synth.loc[missing_ts]
    return df


def loto_evaluate(dataset_path: str | Path = EVALUATION_DATASET_PATH) -> dict:
    ensure_directories()
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    LOTO_PRED_DIR.mkdir(parents=True, exist_ok=True)

    trip_sessions = load_trip_sessions()
    raw_eval = _repair_eval_frame(load_evaluation_dataset(dataset_path))
    eval_frame = engineer_features(raw_eval, trip_sessions=trip_sessions)
    if eval_frame.empty:
        raise ValueError("Evaluation dataset produced no usable rows.")

    pn_mask = eval_frame["trip_source_category"] == "project_native"
    pn_frame = eval_frame[pn_mask].copy()
    public_frame = eval_frame[~pn_mask].copy()

    pn_trip_ids = sorted(pn_frame["trip_id"].unique().tolist())
    print(f"[LOTO] project_native trips: {len(pn_trip_ids)}  public trips: {public_frame['trip_id'].nunique()}", flush=True)

    if_pred_chunks: dict[str, list[pd.DataFrame]] = {"A": [], "B": [], "C": []}
    mp_row_pred_chunks: list[pd.DataFrame] = []
    mp_seq_pred_chunks: list[dict] = []

    for trip_id in pn_trip_ids:
        held = pn_frame[pn_frame["trip_id"] == trip_id].copy()
        rest = pn_frame[pn_frame["trip_id"] != trip_id].copy()
        rest_clean = rest[~rest["anomaly_label"].astype(bool)].copy()
        if rest_clean.empty:
            print(f"[LOTO] skip {trip_id} -- no clean training data left", flush=True)
            continue

        for variant in ("A", "B", "C"):
            bundle = _fit_if_fold(rest_clean, MODEL_VARIANT_FEATURES[variant], variant)
            scored = score_iforest(bundle, held)
            if_pred_chunks[variant].append(scored)

        mp_det = calibrate_matrix_profile(rest_clean)
        mp_row_pred = mp_det.score_dataframe(held)
        mp_row_pred_chunks.append(mp_row_pred)
        mp_seq_pred_chunks.append(_score_mp_trip(mp_det, held))

        print(
            f"[LOTO] trip={trip_id[:8]} held={len(held):>4} train_clean={len(rest_clean):>4}  done",
            flush=True,
        )

    # Public route trips: fit one 'final' model on ALL project_native clean
    # positives, so this only contributes to OOD-FPR characterisation.
    all_pn_clean = pn_frame[~pn_frame["anomaly_label"].astype(bool)].copy()
    for variant in ("A", "B", "C"):
        bundle = _fit_if_fold(all_pn_clean, MODEL_VARIANT_FEATURES[variant], variant)
        if not public_frame.empty:
            scored_public = score_iforest(bundle, public_frame)
            if_pred_chunks[variant].append(scored_public)

    final_mp = calibrate_matrix_profile(all_pn_clean)
    if not public_frame.empty:
        mp_row_pred_chunks.append(final_mp.score_dataframe(public_frame))
        for (_, _), grp in public_frame.groupby(["truck_id", "trip_id"], dropna=False):
            mp_seq_pred_chunks.append(_score_mp_trip(final_mp, grp))

    if_predictions = {v: pd.concat(if_pred_chunks[v], ignore_index=True) for v in ("A", "B", "C")}
    mp_row_predictions = pd.concat(mp_row_pred_chunks, ignore_index=True)
    mp_sequence_predictions = pd.DataFrame(mp_seq_pred_chunks)

    # Hybrid uses Model C (production) for the IF channel, matching the
    # configuration documented in ?6.4.3 of Chapter 6.
    # Two fusion strategies are evaluated:
    #                          fuel-shape discord), and the strict row-
    #                          level AND would collapse recall to ~5 %
    #                          principled production definition is to
    #                          USE MP AS A TRIP-LEVEL GATE OVER IF ROWS:
    #                          a row is flagged iff (a) the IF Model C
    #                          flagged it AND (b) the trip's overall MP
    #                          decision was "anomalous shape detected".
    #                          This matches operational reading -- MP
    #                          confirms the trip contains an anomalous
    #                          shape, IF identifies the specific rows.
    if_c = if_predictions["C"]
    _merge_keys = ["truck_id", "trip_id", "timestamp"]
    _if_cols = [c for c in _merge_keys + [
        "iforest_flag", "iforest_score", "anomaly_label",
        "evaluation_subset", "trip_source_category",
    ] if c in if_c.columns]
    _mp_cols = [c for c in _merge_keys + ["mp_anomaly_flag", "mp_score"] if c in mp_row_predictions.columns]
    hybrid_frame = if_c[_if_cols].merge(mp_row_predictions[_mp_cols], on=_merge_keys, how="inner")
    _if_range = max(float(hybrid_frame["iforest_score"].max() - hybrid_frame["iforest_score"].min()), 1e-9)
    _mp_range = max(float(hybrid_frame["mp_score"].max() - hybrid_frame["mp_score"].min()), 1e-9)
    hybrid_frame["iforest_score_norm"] = (hybrid_frame["iforest_score"] - hybrid_frame["iforest_score"].min()) / _if_range
    hybrid_frame["mp_score_norm"] = (hybrid_frame["mp_score"] - hybrid_frame["mp_score"].min()) / _mp_range

    # Trip-level MP decision map for the gated intersection.
    _mp_trip_flag_map = dict(zip(
        mp_sequence_predictions["trip_id"].astype(str),
        mp_sequence_predictions["mp_anomaly_flag"].astype(bool),
    ))
    hybrid_frame["mp_trip_flag"] = (
        hybrid_frame["trip_id"].astype(str).map(_mp_trip_flag_map).fillna(False).astype(bool)
    )

    hybrid_frame["hybrid_union_flag"] = hybrid_frame["iforest_flag"] | hybrid_frame["mp_anomaly_flag"]
    hybrid_frame["hybrid_intersect_flag"] = hybrid_frame["iforest_flag"] & hybrid_frame["mp_trip_flag"]
    hybrid_frame["hybrid_union_score"] = hybrid_frame[["iforest_score_norm", "mp_score_norm"]].max(axis=1)
    hybrid_frame["hybrid_intersect_score"] = hybrid_frame[["iforest_score_norm", "mp_score_norm"]].min(axis=1)

    breakdown_rows: list[dict] = []
    for variant in ("A", "B", "C"):
        breakdown_rows.extend(_build_subset_rows(
            f"Isolation Forest (LOTO, Model {variant})",
            if_predictions[variant],
            "iforest_flag",
            "iforest_score",
            _make_if_subsets(if_predictions[variant]),
            granularity="row",
            data_source=str(Path(dataset_path)),
        ))
    breakdown_rows.extend(_build_subset_rows(
        "Matrix Profile (LOTO)",
        mp_sequence_predictions,
        "mp_anomaly_flag",
        "mp_score",
        _make_mp_subsets(mp_sequence_predictions),
        latency_source=mp_row_predictions,
        granularity="trip_subsequence",
        data_source=str(Path(dataset_path)),
    ))
    breakdown_rows.extend(_build_subset_rows(
        "Hybrid (IF U MP, union, LOTO)",
        hybrid_frame,
        "hybrid_union_flag",
        "hybrid_union_score",
        _make_hybrid_subsets(hybrid_frame),
        granularity="row",
        data_source=str(Path(dataset_path)),
    ))
    breakdown_rows.extend(_build_subset_rows(
        "Hybrid (IF n MP, intersection, LOTO)",
        hybrid_frame,
        "hybrid_intersect_flag",
        "hybrid_intersect_score",
        _make_hybrid_subsets(hybrid_frame),
        granularity="row",
        data_source=str(Path(dataset_path)),
    ))

    for v in ("A", "B", "C"):
        if_predictions[v].to_csv(LOTO_PRED_DIR / f"evaluation_predictions_iforest_{v.lower()}_loto.csv", index=False)
    mp_row_predictions.to_csv(LOTO_PRED_DIR / "evaluation_predictions_matrix_profile_rows_loto.csv", index=False)
    mp_sequence_predictions.to_csv(LOTO_PRED_DIR / "evaluation_predictions_matrix_profile_loto.csv", index=False)
    hybrid_frame.to_csv(LOTO_PRED_DIR / "evaluation_predictions_hybrid_loto.csv", index=False)

    LOTO_BREAKDOWN_JSON.write_text(json.dumps(breakdown_rows, indent=2, default=str), encoding="utf-8")
    pd.DataFrame(breakdown_rows).to_csv(LOTO_BREAKDOWN_CSV, index=False)

    HEADLINE = "project_native_injected"
    PUBLIC_FAR = "public_clean"

    def _model_block(label: str) -> dict:
        return {
            HEADLINE: _summarise_partition(breakdown_rows, label, HEADLINE),
            PUBLIC_FAR: _summarise_partition(breakdown_rows, label, PUBLIC_FAR),
            "project_native": _summarise_partition(breakdown_rows, label, "project_native"),
            "overall": _summarise_partition(breakdown_rows, label, "overall"),
        }

    summary = {
        "policy": "leave-one-trip-out (LOTO) across project_native trips",
        "rationale": (
            "For each project_native trip in the evaluation set, IF (Models A/B/C) "
            "and MP are refit and recalibrated on the CLEAN rows of the remaining "
            "project_native trips only; the held-out trip is then scored with that "
            "fold's models. Threshold for every IF variant is the 0.995 quantile of "
            "the fold's training scores with NO additional precision margin. Public-"
            "route trips are scored once with a 'final' model trained on all "
            "project_native clean rows (no positives are present in the public set)."
        ),
        "project_native_trips_in_eval": len(pn_trip_ids),
        "public_route_trips_in_eval": int(public_frame["trip_id"].nunique()),
        "headline_partition": HEADLINE,
        "results": {
            "Isolation Forest Model A (LOTO)": _model_block("Isolation Forest (LOTO, Model A)"),
            "Isolation Forest Model B (LOTO)": _model_block("Isolation Forest (LOTO, Model B)"),
            "Isolation Forest Model C (LOTO)": _model_block("Isolation Forest (LOTO, Model C)"),
            "Matrix Profile (LOTO)": _model_block("Matrix Profile (LOTO)"),
            "Hybrid Union (LOTO)": _model_block("Hybrid (IF U MP, union, LOTO)"),
            "Hybrid Intersection (LOTO)": _model_block("Hybrid (IF n MP, intersection, LOTO)"),
        },
    }
    LOTO_SUMMARY_JSON.write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    print(json.dumps(summary["results"], indent=2, default=str))
    return summary


if __name__ == "__main__":
    loto_evaluate()
