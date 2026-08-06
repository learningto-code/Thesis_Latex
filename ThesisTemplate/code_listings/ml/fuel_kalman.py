from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np
import pandas as pd


# Physics envelope (mirrors _burn_envelope_pct_per_min in loto_ablation
# and checkPhysicsTripwire in server.js)
def _expected_burn_pct_per_min(speed_kmph: float, load_pct: float) -> float:
    if speed_kmph < 5.0:
        return 0.03
    load = max(0.0, min(100.0, load_pct))
    return 0.03 + (load / 100.0) * 0.15


@dataclass
class KalmanFuelFilter:
    r_meas:            float = 0.25
    q_idle:            float = 0.001
    q_moving:          float = 0.01
    q_burst:           float = 5.0
    burst_delta_pct:   float = 1.0

    def filter_trip(self,
                    times:  Iterable,
                    fuel:   Iterable[float],
                    speed:  Iterable[float] | None = None,
                    load:   Iterable[float] | None = None) -> np.ndarray:
        times = pd.to_datetime(pd.Series(list(times)), utc=True, errors="coerce")
        fuel  = pd.to_numeric(pd.Series(list(fuel)),  errors="coerce").to_numpy()
        n = len(fuel)
        if n == 0:
            return np.array([])

        speed_arr = (pd.to_numeric(pd.Series(list(speed)), errors="coerce")
                     .fillna(0.0).to_numpy()
                     if speed is not None else np.zeros(n))
        load_arr  = (pd.to_numeric(pd.Series(list(load)), errors="coerce")
                     .fillna(30.0).to_numpy()
                     if load is not None else np.full(n, 30.0))

        # Initialise state at the first valid measurement with a wide
        x = float(fuel[0]) if not np.isnan(fuel[0]) else 0.0
        p = 4.0    # 2% initial 1-sigma uncertainty on fuel level

        out = np.empty(n, dtype=float)
        prev_t = None
        for i in range(n):
            zi = fuel[i]
            ti = times.iloc[i]

            # Interval length (seconds); default to 5 s if timestamp missing
            if prev_t is None or pd.isna(ti) or pd.isna(prev_t):
                dt_sec = 5.0
            else:
                dt_sec = max(0.001, (ti - prev_t).total_seconds())
            prev_t = ti if not pd.isna(ti) else prev_t

            # Predict
            # Expected consumption over the interval
            u = _expected_burn_pct_per_min(speed_arr[i], load_arr[i]) * (dt_sec / 60.0)
            x_pred = x - u  # process: F=1, B=1 (subtracting expected burn)

            # Context-aware process noise
            if speed_arr[i] < 5.0:
                q = self.q_idle
            else:
                q = self.q_moving
            # Burst mode when the incoming measurement is far from prediction
            if not np.isnan(zi) and abs(zi - x_pred) >= self.burst_delta_pct:
                q = self.q_burst

            p_pred = p + q

            # Update
            if np.isnan(zi):
                # No measurement: state = prediction, covariance grows
                x = x_pred
                p = p_pred
            else:
                k_gain = p_pred / (p_pred + self.r_meas)
                x = x_pred + k_gain * (zi - x_pred)
                p = (1.0 - k_gain) * p_pred

            out[i] = x

        return out


# Convenience wrapper mirroring _moving_average's signature
def kalman_filter_series(series: pd.Series,
                          speed: pd.Series | None = None,
                          load: pd.Series | None = None,
                          times: pd.Series | None = None,
                          filter_kwargs: dict | None = None) -> pd.Series:
    kf_kwargs = filter_kwargs or {}
    kf = KalmanFuelFilter(**kf_kwargs)
    if times is None:
        times = pd.Series(pd.date_range(start="2024-01-01",
                                        periods=len(series), freq="5s"),
                          index=series.index)
    filtered = kf.filter_trip(times, series, speed, load)
    return pd.Series(filtered, index=series.index)
