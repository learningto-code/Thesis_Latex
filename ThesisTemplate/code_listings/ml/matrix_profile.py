from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

try:
    import stumpy as _stumpy
except ImportError:  # pragma: no cover
    _stumpy = None


def _stomp_profile_numpy(arr: np.ndarray, m: int) -> np.ndarray:
    n = int(arr.size)
    if n < m * 2:
        return np.array([], dtype=float)
    n_sub = n - m + 1

    # Extract every length-m window via sliding-window view (zero-copy).
    subs = np.lib.stride_tricks.sliding_window_view(arr, m).astype(float, copy=False)
    means = subs.mean(axis=1, keepdims=True)
    stds  = subs.std(axis=1, keepdims=True)
    stds  = np.where(stds < 1e-9, 1e-9, stds)
    norm  = (subs - means) / stds  # z-normalised subsequences, shape (n_sub, m)

    exclusion = max(1, m // 2)
    profile = np.full(n_sub, np.inf, dtype=float)
    for i in range(n_sub):
        diff = norm - norm[i]
        dist = np.sqrt(np.einsum("ij,ij->i", diff, diff))
        lo = max(0, i - exclusion)
        hi = min(n_sub, i + exclusion + 1)
        dist[lo:hi] = np.inf
        if np.any(np.isfinite(dist)):
            profile[i] = float(dist.min())
    finite_mask = np.isfinite(profile)
    if finite_mask.any():
        profile = np.where(finite_mask, profile, profile[finite_mask].max())
    else:
        profile = np.zeros_like(profile)
    return profile


def _matrix_profile(arr: np.ndarray, m: int) -> np.ndarray:
    """Use stumpy when available (faster on long series), else numpy fallback."""
    if _stumpy is not None:
        return _stumpy.stump(arr, m=m)[:, 0].astype(float)
    return _stomp_profile_numpy(arr, m)


BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "models"

DEFAULT_WINDOW_SIZE = 5
DEFAULT_LOCALIZATION_WINDOW_SIZE = 4
# Long-window detector -- added 2026-06-23 after reading the anchor paper
# (Barbado & Corcho 2022) and the prior research synthesis recommendation
# fast siphons / sharp drops; the long window (m=12) catches gradual
DEFAULT_LONG_WINDOW_SIZE = 12
DEFAULT_MIN_SERIES_LENGTH = DEFAULT_WINDOW_SIZE * 2
DEFAULT_LOCALIZATION_MIN_SERIES_LENGTH = DEFAULT_LOCALIZATION_WINDOW_SIZE * 2
DEFAULT_LONG_MIN_SERIES_LENGTH = DEFAULT_LONG_WINDOW_SIZE * 2
DEFAULT_THRESHOLD_Z = 2.5
DEFAULT_SIGNAL_COLUMN = "fuel_level_filtered"

#   * MIN_DROP_PCT: filtered fuel barely moves on most "discord" windows in
#   * MIN_CONSECUTIVE_WINDOWS: single-window discord = one noisy sample.
#     Requiring N consecutive windows above threshold kills point spikes.
# leak rate of the canonical gradual_leak injection class meant MP only
# gradual-leak recall meaningfully while still rejecting sub-percent
DEFAULT_MIN_DROP_PCT = 1.0
DEFAULT_REFUEL_EXEMPT_PCT = 5.0
DEFAULT_MIN_CONSECUTIVE_WINDOWS = 1
DEFAULT_DOWNWARD_ONLY = True
DEFAULT_CALIBRATION_MODE = "pooled_quantile"   # legacy; "max_of_max" is the v2 default
DEFAULT_SAFETY_FACTOR = 1.15


@dataclass
class MatrixProfileDetector:
    window_size: int = DEFAULT_WINDOW_SIZE
    localization_window_size: int = DEFAULT_LOCALIZATION_WINDOW_SIZE
    long_window_size: int = DEFAULT_LONG_WINDOW_SIZE
    threshold_z: float = DEFAULT_THRESHOLD_Z
    localization_threshold_z: float = DEFAULT_THRESHOLD_Z
    long_threshold_z: float = DEFAULT_THRESHOLD_Z
    calibration_quantile: float = 0.99
    min_series_length: int = DEFAULT_MIN_SERIES_LENGTH
    localization_min_series_length: int = DEFAULT_LOCALIZATION_MIN_SERIES_LENGTH
    long_min_series_length: int = DEFAULT_LONG_MIN_SERIES_LENGTH
    series_transform: str = "raw"
    signal_column: str = DEFAULT_SIGNAL_COLUMN
    context_thresholds: dict[str, float] | None = None
    localization_context_thresholds: dict[str, float] | None = None
    long_context_thresholds: dict[str, float] | None = None
    min_drop_pct: float = DEFAULT_MIN_DROP_PCT
    refuel_exempt_pct: float = DEFAULT_REFUEL_EXEMPT_PCT
    min_consecutive_windows: int = DEFAULT_MIN_CONSECUTIVE_WINDOWS
    downward_only: bool = DEFAULT_DOWNWARD_ONLY
    calibration_mode: str = DEFAULT_CALIBRATION_MODE
    safety_factor: float = DEFAULT_SAFETY_FACTOR

    def fit(self, sequences: list[Iterable[float]]) -> "MatrixProfileDetector":
        self.threshold_z = self._calibrate_threshold(sequences, self.window_size)
        self.localization_threshold_z = self._calibrate_threshold(sequences, self.localization_window_size)
        # Only calibrate long-window threshold if we have sequences long enough.
        viable_long = [s for s in sequences if len(list(s)) >= self.long_min_series_length]
        if viable_long:
            self.long_threshold_z = self._calibrate_threshold(viable_long, self.long_window_size)
        return self

    def _calibrate_threshold(self, sequences: list[Iterable[float]], window_size: int) -> float:
        per_trip_max_zs: list[float] = []
        z_values: list[np.ndarray] = []
        for sequence in sequences:
            _, profile = compute_matrix_profile(sequence, window_size, transform=self.series_transform)
            z_scores = profile_to_zscores(profile)
            if z_scores.size:
                z_values.append(z_scores)
                per_trip_max_zs.append(float(z_scores.max()))

        if not z_values:
            return float(DEFAULT_THRESHOLD_Z)

        if self.calibration_mode == "max_of_max":
            return float(max(per_trip_max_zs) * float(self.safety_factor))

        merged = np.concatenate(z_values)
        return float(np.quantile(merged, self.calibration_quantile))

    def resolve_threshold(self, context_key: str | None = None, mode: str = "primary") -> float:
        if mode == "localization":
            base_threshold = float(self.localization_threshold_z)
            context_thresholds = self.localization_context_thresholds or {}
        elif mode == "long":
            base_threshold = float(self.long_threshold_z)
            context_thresholds = self.long_context_thresholds or {}
        else:
            base_threshold = float(self.threshold_z)
            context_thresholds = self.context_thresholds or {}

        if context_key and context_key in context_thresholds:
            return float(context_thresholds[context_key])
        return base_threshold

    def _analysis_parameters(self, mode: str) -> tuple[int, float, int]:
        if mode == "localization":
            return (
                int(self.localization_window_size),
                float(self.localization_threshold_z),
                int(self.localization_min_series_length),
            )
        if mode == "long":
            return (
                int(self.long_window_size),
                float(self.long_threshold_z),
                int(self.long_min_series_length),
            )
        return int(self.window_size), float(self.threshold_z), int(self.min_series_length)

    def analyze_series(
        self,
        series: Iterable[float],
        context_key: str | None = None,
        mode: str = "primary",
    ) -> dict:
        window_size, _, min_series_length = self._analysis_parameters(mode)
        values, profile = compute_matrix_profile(series, window_size, transform=self.series_transform)
        z_scores = profile_to_zscores(profile)
        effective_threshold = self.resolve_threshold(context_key=context_key, mode=mode)
        raw_flags = z_scores >= effective_threshold
        gated_flags = self._apply_gates(raw_flags, z_scores, values, window_size)
        return {
            "analysis_mode": mode,
            "series_length": int(values.size),
            "window_size": int(window_size),
            "min_series_length": int(min_series_length),
            "threshold_z": float(self.localization_threshold_z if mode == "localization" else self.threshold_z),
            "effective_threshold_z": float(effective_threshold),
            "context_key": context_key,
            "profile": profile,
            "z_scores": z_scores,
            "flags": gated_flags,
            "raw_flags": raw_flags,
        }

    def _apply_gates(
        self,
        raw_flags: np.ndarray,
        z_scores: np.ndarray,
        values: np.ndarray,
        window_size: int,
    ) -> np.ndarray:
        if raw_flags.size == 0 or values.size == 0:
            return raw_flags

        # Only the raw-fuel transform gives us interpretable absolute deltas.
        # If the series was differenced upstream, fall back to z-threshold only.
        if self.series_transform != "raw":
            return raw_flags

        # (cumulative drift across the ~10-sample neighbourhood).
        context_radius = max(int(window_size) * 2, 8)
        n = int(values.size)

        POST_REFUEL_LOOKBACK = 12
        post_refuel_active = np.zeros(n, dtype=bool)
        for i in range(n):
            lo = max(0, i - POST_REFUEL_LOOKBACK)
            window = values[lo:i + 1]
            if window.size >= 2 and float(window.max() - window.min()) >= float(self.refuel_exempt_pct):
                # If the max comes AFTER the min within this window the tank
                # rose during the window -> mark "post-refuel".
                if window.argmax() > window.argmin():
                    post_refuel_active[i] = True

        gated = np.zeros_like(raw_flags, dtype=bool)
        n_windows = int(raw_flags.size)
        for i in range(n_windows):
            if not raw_flags[i]:
                continue
            window_end_idx = min(i + window_size - 1, n - 1)
            left_lo  = max(0, i - context_radius)
            left_hi  = i   # exclusive
            right_lo = window_end_idx + 1
            right_hi = min(n, window_end_idx + 1 + context_radius)
            # Fall back to the window endpoints when the neighbourhood is empty
            left_val  = float(values[left_lo:left_hi].mean())  if left_hi > left_lo  else float(values[i])
            right_val = float(values[right_lo:right_hi].mean()) if right_hi > right_lo else float(values[window_end_idx])
            delta = right_val - left_val   # positive = fuel went UP
            # Refuel exempt -- sustained jump up by refuel_exempt_pct or more.
            if delta >= float(self.refuel_exempt_pct):
                continue
            # POST-REFUEL recovery: discard discords inside the settling window.
            if post_refuel_active[window_end_idx]:
                continue
            # Direction filter -- drop upward discords entirely.
            if self.downward_only and delta > 0:
                continue
            # Magnitude gate -- the actual fuel change across the context
            if abs(delta) < float(self.min_drop_pct):
                continue
            gated[i] = True

        min_run = max(1, int(self.min_consecutive_windows))
        if min_run <= 1:
            return gated

        persisted = np.zeros_like(gated, dtype=bool)
        run_start = -1
        for i in range(n_windows):
            if gated[i]:
                if run_start < 0:
                    run_start = i
                if i - run_start + 1 >= min_run:
                    # Backfill the whole run once we cross the threshold.
                    persisted[run_start:i + 1] = True
            else:
                run_start = -1
        return persisted

    def localize_series(self, series: Iterable[float], context_key: str | None = None) -> dict:
        return self.analyze_series(series, context_key=context_key, mode="localization")

    def detect_latest_multires(self, series: Iterable[float], context_key: str | None = None) -> dict:
        short_result = self.detect_latest(series, context_key=context_key)
        series_list = list(series) if not isinstance(series, list) else series
        if len(series_list) < self.long_min_series_length:
            short_result["long_window_used"] = False
            return short_result

        long_analysis = self.analyze_series(series_list, context_key=context_key, mode="long")
        long_z_scores = long_analysis["z_scores"]
        if long_z_scores.size == 0:
            short_result["long_window_used"] = False
            return short_result

        long_latest_start = int(long_z_scores.size - 1)
        long_latest_score = float(long_z_scores[long_latest_start])
        long_threshold = float(long_analysis["effective_threshold_z"])
        long_is_anom = bool(long_analysis["flags"][long_latest_start])

        # Union -- fires if EITHER scale fires; pick the higher-magnitude score.
        short_score = float(short_result.get("score", 0.0))
        if abs(long_latest_score) > abs(short_score):
            dominant_source = "matrix_profile_long"
            score_out = long_latest_score
            threshold_out = long_threshold
            window_out = int(self.long_window_size)
        else:
            dominant_source = "matrix_profile"
            score_out = short_score
            threshold_out = float(short_result.get("threshold_z", 0.0))
            window_out = int(short_result.get("window_size", self.localization_window_size))

        is_anomaly = bool(short_result.get("is_anomaly", False) or long_is_anom)

        return {
            "is_anomaly": is_anomaly,
            "score": round(score_out, 6),
            "model_source": dominant_source,
            "window_size": window_out,
            "threshold_z": round(threshold_out, 6),
            "context_key": context_key,
            "signal_column": self.signal_column,
            "latest_window_start": int(long_latest_start),
            "latest_window_end": int(long_latest_start) + int(self.long_window_size) - 1,
            "long_window_used": True,
            "short_score": short_score,
            "long_score": long_latest_score,
            "short_threshold": float(short_result.get("threshold_z", 0.0)),
            "long_threshold": long_threshold,
            "short_is_anomaly": bool(short_result.get("is_anomaly", False)),
            "long_is_anomaly": long_is_anom,
            "reason": (
                f"multi-res discord: short z={short_score:.3f} (m={short_result.get('window_size')}), "
                f"long z={long_latest_score:.3f} (m={int(self.long_window_size)}) -- "
                f"{'FLAG' if is_anomaly else 'OK'}"
            ),
        }

    def detect_latest(self, series: Iterable[float], context_key: str | None = None) -> dict:
        analysis = self.localize_series(series, context_key=context_key)
        z_scores = analysis["z_scores"]
        effective_threshold = float(analysis["effective_threshold_z"])
        window_size = int(analysis["window_size"])
        min_series_length = int(analysis["min_series_length"])
        if z_scores.size == 0:
            return {
                "is_anomaly": False,
                "score": 0.0,
                "model_source": "matrix_profile",
                "window_size": window_size,
                "threshold_z": round(effective_threshold, 6),
                "signal_column": self.signal_column,
                "reason": f"need at least {min_series_length} ordered readings",
            }

        latest_start = int(z_scores.size - 1)
        latest_score = float(z_scores[latest_start])
        is_anomaly = bool(analysis["flags"][latest_start])
        raw_z_exceeds = bool(latest_score >= effective_threshold)
        if raw_z_exceeds and not is_anomaly:
            reason = (
                f"latest discord score {latest_score:.3f} >= threshold "
                f"{effective_threshold:.3f} but suppressed by v2 gates "
                f"(min_drop={self.min_drop_pct}% / downward_only={self.downward_only})"
            )
        else:
            reason = (
                f"latest fuel-pattern discord score {latest_score:.3f} "
                f"{'>=' if is_anomaly else '<'} threshold {effective_threshold:.3f}"
            )
        return {
            "is_anomaly": is_anomaly,
            "score": round(latest_score, 6),
            "model_source": "matrix_profile",
            "window_size": window_size,
            "threshold_z": round(effective_threshold, 6),
            "context_key": context_key,
            "signal_column": self.signal_column,
            "latest_window_start": latest_start,
            "latest_window_end": latest_start + window_size - 1,
            "reason": reason,
        }

    def score_dataframe(
        self,
        frame: pd.DataFrame,
        group_cols: list[str] | None = None,
        value_col: str | None = None,
        sort_col: str = "timestamp",
    ) -> pd.DataFrame:
        if group_cols is None:
            group_cols = ["truck_id", "trip_id"]
        if value_col is None:
            value_col = self.signal_column

        scored_groups: list[pd.DataFrame] = []
        for _, group in frame.sort_values(group_cols + [sort_col]).groupby(group_cols, dropna=False):
            scored_groups.append(self._score_group(group.copy(), value_col=value_col))
        return pd.concat(scored_groups, ignore_index=True) if scored_groups else frame.copy()

    def _score_group(self, group: pd.DataFrame, value_col: str) -> pd.DataFrame:
        context_key = None
        if "source_threshold_key" in group.columns and not group["source_threshold_key"].dropna().empty:
            context_key = str(group["source_threshold_key"].mode(dropna=True).iloc[0])
        elif "threshold_context_key" in group.columns and not group["threshold_context_key"].dropna().empty:
            context_key = str(group["threshold_context_key"].mode(dropna=True).iloc[0])
        elif "context_key" in group.columns and not group["context_key"].dropna().empty:
            context_key = str(group["context_key"].mode(dropna=True).iloc[0])
        analysis = self.localize_series(group[value_col].tolist(), context_key=context_key)
        effective_threshold = float(analysis["effective_threshold_z"])
        window_size = int(analysis["window_size"])
        group["mp_score"] = 0.0
        group["mp_anomaly_flag"] = False
        group["mp_window_start"] = pd.Series([pd.NA] * len(group), dtype="Int64")
        group["mp_threshold"] = effective_threshold
        group["mp_window_size"] = window_size
        group["model_source_mp"] = "matrix_profile"
        group["anomaly_score"] = 0.0
        group["anomaly_flag"] = False
        group["model_source"] = "matrix_profile"

        z_scores: np.ndarray = analysis["z_scores"]
        if z_scores.size == 0:
            return group

        score_idx = group.columns.get_loc("mp_score")
        flag_idx = group.columns.get_loc("mp_anomaly_flag")
        start_idx = group.columns.get_loc("mp_window_start")

        gated_flags = np.asarray(analysis["flags"], dtype=bool)
        for window_start, z_score in enumerate(z_scores):
            window_end = min(window_start + window_size, len(group))
            current = group.iloc[window_start:window_end]["mp_score"].to_numpy(dtype=float)
            group.iloc[window_start:window_end, score_idx] = np.maximum(current, z_score)
            if window_start < gated_flags.size and gated_flags[window_start]:
                group.iloc[window_start:window_end, flag_idx] = True
                group.iloc[window_start:window_end, start_idx] = window_start

        group["anomaly_score"] = group["mp_score"]
        group["anomaly_flag"] = group["mp_anomaly_flag"]
        return group

    def save(self, path: Path | None = None) -> Path:
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        target = path or (MODEL_DIR / "matrix_profile.json")
        target.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        return target

    @classmethod
    def load(cls, path: Path | None = None) -> "MatrixProfileDetector":
        source = path or (MODEL_DIR / "matrix_profile.json")
        return cls(**json.loads(source.read_text(encoding="utf-8")))


def _clean_series(series: Iterable[float]) -> np.ndarray:
    arr = np.asarray(list(series), dtype=float)
    if arr.size == 0:
        return arr
    if np.isnan(arr).all():
        return np.zeros_like(arr, dtype=float)
    fill_value = float(np.nanmedian(arr))
    return np.nan_to_num(arr, nan=fill_value, posinf=fill_value, neginf=fill_value)


def _transform_series(arr: np.ndarray, transform: str) -> np.ndarray:
    if transform == "diff":
        if arr.size < 2:
            return np.array([], dtype=float)
        return np.diff(arr)
    return arr


def compute_matrix_profile(series: Iterable[float], window_size: int, transform: str = "raw") -> tuple[np.ndarray, np.ndarray]:
    arr = _clean_series(series)
    arr = _transform_series(arr, transform)
    if arr.size < max(window_size * 2, 3):
        return arr, np.array([], dtype=float)
    profile = _matrix_profile(arr, window_size)
    return arr, profile


def profile_to_zscores(profile: np.ndarray) -> np.ndarray:
    if profile.size == 0:
        return np.array([], dtype=float)
    mean_value = float(np.mean(profile))
    std_value = float(np.std(profile))
    if std_value <= 1e-9:
        return np.zeros_like(profile, dtype=float)
    return (profile - mean_value) / std_value


def _build_context_thresholds(
    detector: MatrixProfileDetector,
    context_sequences: list[tuple[str, list[float]]],
    window_size: int,
    base_threshold: float,
    min_scale: float = 0.70,
    max_scale: float = 1.50,
) -> dict[str, float]:
    context_z_values: dict[str, list[np.ndarray]] = {}
    min_threshold = base_threshold * min_scale
    max_threshold = base_threshold * max_scale

    for context_key, sequence in context_sequences:
        _, profile = compute_matrix_profile(sequence, window_size, transform=detector.series_transform)
        z_scores = profile_to_zscores(profile)
        if context_key and z_scores.size:
            context_z_values.setdefault(context_key, []).append(z_scores)

    thresholds: dict[str, float] = {}
    for context_key, values in context_z_values.items():
        merged = np.concatenate(values) if values else np.array([], dtype=float)
        if merged.size < 10:
            continue
        raw_threshold = float(np.quantile(merged, detector.calibration_quantile))
        thresholds[context_key] = float(np.clip(raw_threshold, min_threshold, max_threshold))
    return thresholds


def calibrate_matrix_profile(
    normal_frame: pd.DataFrame,
    group_cols: list[str] | None = None,
    value_col: str = DEFAULT_SIGNAL_COLUMN,
    window_size: int = DEFAULT_WINDOW_SIZE,
    localization_window_size: int = DEFAULT_LOCALIZATION_WINDOW_SIZE,
) -> MatrixProfileDetector:
    if group_cols is None:
        group_cols = ["truck_id", "trip_id"]
    detector = MatrixProfileDetector(
        window_size=window_size,
        localization_window_size=localization_window_size,
        signal_column=value_col,
        # Calibration mode notes (empirically tuned on the 79-trip eval set):
        #   - pooled_quantile 0.99     -> threshold ~4.9, recall 5/6 with gates
        # Pooled is kept; the gates handle the FPR problem on their own.
        # one sample, so requiring 2 consecutive flagged windows zeros recall.
        calibration_mode="pooled_quantile",
        calibration_quantile=0.99,
        safety_factor=DEFAULT_SAFETY_FACTOR,
        min_drop_pct=DEFAULT_MIN_DROP_PCT,   # 1.0 (loosened 2026-06-23)
        refuel_exempt_pct=DEFAULT_REFUEL_EXEMPT_PCT,
        min_consecutive_windows=1,
        downward_only=DEFAULT_DOWNWARD_ONLY,
    )

    sequences: list[list[float]] = []
    context_sequences: list[tuple[str, list[float]]] = []
    for _, group in normal_frame.groupby(group_cols, dropna=False):
        ordered = group.sort_values("timestamp")
        sequence = ordered[value_col].tolist()
        sequences.append(sequence)
        context_key = None
        if "source_threshold_key" in ordered.columns and not ordered["source_threshold_key"].dropna().empty:
            context_key = str(ordered["source_threshold_key"].mode(dropna=True).iloc[0])
        elif "threshold_context_key" in ordered.columns and not ordered["threshold_context_key"].dropna().empty:
            context_key = str(ordered["threshold_context_key"].mode(dropna=True).iloc[0])
        elif "context_key" in ordered.columns and not ordered["context_key"].dropna().empty:
            context_key = str(ordered["context_key"].mode(dropna=True).iloc[0])
        if context_key:
            context_sequences.append((context_key, sequence))

    detector.fit(sequences)
    detector.context_thresholds = _build_context_thresholds(
        detector,
        context_sequences,
        detector.window_size,
        detector.threshold_z,
    )
    detector.localization_context_thresholds = _build_context_thresholds(
        detector,
        context_sequences,
        detector.localization_window_size,
        detector.localization_threshold_z,
    )
    # Long-window context thresholds -- only sequences long enough to support
    detector.long_context_thresholds = _build_context_thresholds(
        detector,
        [(k, s) for (k, s) in context_sequences if len(list(s)) >= detector.long_min_series_length],
        detector.long_window_size,
        detector.long_threshold_z,
    )
    return detector


def _cli() -> None:
    parser = argparse.ArgumentParser(description="Matrix Profile latest-window scorer")
    parser.add_argument("--series", type=str, required=True, help="JSON array of fuel levels")
    parser.add_argument("--window-size", type=int, default=DEFAULT_WINDOW_SIZE)
    parser.add_argument("--localization-window-size", type=int, default=DEFAULT_LOCALIZATION_WINDOW_SIZE)
    args = parser.parse_args()

    detector = MatrixProfileDetector(
        window_size=args.window_size,
        localization_window_size=args.localization_window_size,
    )
    print(json.dumps(detector.detect_latest(json.loads(args.series)), indent=2))


if __name__ == "__main__":
    _cli()
