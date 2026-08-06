from __future__ import annotations

import argparse
import csv
import datetime as dt
import signal
import sys
import time
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

# Kalman filter reuses the same 1-D implementation used elsewhere in this
# study so on-laptop, on-HMI, and offline outputs are byte-comparable.
from fuel_kalman import KalmanFuelFilter


# Constants shared across modes
SAMPLE_INTERVAL_S = 5.0
MA_WINDOW         = 5      # same as _moving_average window in preprocess.py

CSV_COLUMNS = [
    "timestamp", "raw_fuel_pct", "fuel_ma", "fuel_kf",
    "speed_kmph", "engine_load_pct", "engine_rpm", "engine_status",
    "scenario_tag",
]

# The ESP32 firmware in embedded/filter_field_test/ writes an alternative
FIRMWARE_CSV_COLUMNS = [
    "timestamp_ms", "raw_fuel_pct", "fuel_ma", "fuel_kf",
    "speed_kmph", "engine_load_pct", "engine_rpm", "engine_status",
    "gps_lat", "gps_lon", "scenario_tag",
]


def _load_csv_any_schema(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    if "timestamp_ms" in df.columns and "timestamp" not in df.columns:
        anchor = pd.Timestamp.now(tz="UTC") - pd.Timedelta(
            milliseconds=int(df["timestamp_ms"].iloc[-1]))
        df["timestamp"] = anchor + pd.to_timedelta(df["timestamp_ms"], unit="ms")
    else:
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    # Firmware writes -1.0 for missing PID reads; treat as NaN
    for col in ("raw_fuel_pct", "fuel_ma", "fuel_kf",
                "speed_kmph", "engine_load_pct", "engine_rpm"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
            df.loc[df[col] < 0, col] = np.nan
    return df.sort_values("timestamp").reset_index(drop=True)


# Filter helpers (mirror preprocess.py and fuel_kalman.py)
def moving_average_series(fuel: np.ndarray, window: int = MA_WINDOW) -> np.ndarray:
    return pd.Series(fuel).rolling(window=window, min_periods=1).mean().to_numpy()


def kalman_series(fuel: np.ndarray, times: pd.Series,
                  speed: np.ndarray, load: np.ndarray) -> np.ndarray:
    kf = KalmanFuelFilter()
    return kf.filter_trip(times, fuel, speed, load)


# COLLECT MODE
def _run_collect(args: argparse.Namespace) -> int:
    try:
        import obd
    except ImportError:
        print("[collect] python-obd is not installed. Run:")
        print("          pip install obd")
        print("Alternatively, capture the raw fuel stream some other way")
        print("and run 'replay' mode on the resulting CSV.")
        return 2

    print(f"[collect] connecting to ELM327 on {args.port} ...")
    conn = obd.OBD(portstr=args.port, baudrate=args.baud, fast=False)
    if not conn.is_connected():
        print(f"[collect] ELM327 connection failed on {args.port}. Check")
        print("          pairing, cable, and that the ignition is on.")
        return 3
    print(f"[collect] connected. Protocol: {conn.protocol_name()}")

    # Toyota Mode 22 PID 21/29 fuel-level custom command
    # PID 21 (0x15) returns tank percentage on the partner-fleet Hilux
    # via Mode 22; the exact decode may need adjustment per unit.
    fuel_cmd = obd.OBDCommand(
        name="TOYOTA_FUEL_LEVEL",
        desc="Toyota fuel level (Mode 22 PID 21)",
        command=b"2221",           # Mode 22, PID 0x21
        bytes=4,
        decoder=lambda msgs: obd.utils.bytes_to_int(msgs[0].data[3:]) * 0.4,
        ecu=obd.ECU.ENGINE,
        fast=False,
    )
    conn.supported_commands.add(fuel_cmd)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"[collect] writing to {out_path}")

    # KF state carried across samples; MA state is the rolling buffer
    kf = KalmanFuelFilter()
    kf_x = None; kf_P = 4.0
    ma_buf: list[float] = []

    running = {"go": True}
    def _stop(_sig, _frm): running["go"] = False; print("\n[collect] stopping ...")
    signal.signal(signal.SIGINT, _stop)

    print("[collect] running. Press Ctrl+C to stop.")
    print("[collect] To tag a scenario, type the tag and press Enter.")
    print("[collect] Suggested tags: idle | highway | city | climb | refuel | park")
    print()

    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()

        pending_tag = ""
        next_sample = time.time()
        while running["go"]:
            now = time.time()
            if now < next_sample:
                # Give the user a small window to type a tag
                try:
                    import msvcrt   # Windows
                    if msvcrt.kbhit():
                        pending_tag = input("[tag] ").strip()
                except ImportError:
                    pass
                time.sleep(0.05)
                continue
            next_sample = now + SAMPLE_INTERVAL_S

            # Read the four PIDs we need
            def _val(cmd, default=np.nan):
                r = conn.query(cmd)
                return float(r.value.magnitude) if (r and r.value is not None) else default

            raw   = _val(fuel_cmd)
            speed = _val(obd.commands.SPEED, 0.0)
            load  = _val(obd.commands.ENGINE_LOAD, 30.0)
            rpm   = _val(obd.commands.RPM, 0.0)
            eng   = "on" if rpm > 400 else ("idle" if rpm > 0 else "off")
            ts    = dt.datetime.now(dt.timezone.utc).isoformat()

            ma_buf.append(raw)
            if len(ma_buf) > MA_WINDOW:
                ma_buf.pop(0)
            fuel_ma = float(np.mean(ma_buf))

            if kf_x is None:
                kf_x = float(raw) if not np.isnan(raw) else 0.0
            # Reuse KalmanFuelFilter for physics + Q schedule
            filtered = kf.filter_trip(
                pd.Series([pd.Timestamp(ts)]),
                np.array([raw]),
                np.array([speed]),
                np.array([load]),
            )
            fuel_kf = float(filtered[0]) if len(filtered) else float(raw)

            writer.writerow({
                "timestamp":       ts,
                "raw_fuel_pct":    raw,
                "fuel_ma":         fuel_ma,
                "fuel_kf":         fuel_kf,
                "speed_kmph":      speed,
                "engine_load_pct": load,
                "engine_rpm":      rpm,
                "engine_status":   eng,
                "scenario_tag":    pending_tag,
            })
            f.flush()
            print(f"  t+{now - next_sample + SAMPLE_INTERVAL_S:5.1f}s  "
                  f"raw={raw:5.1f}%  MA={fuel_ma:5.1f}%  KF={fuel_kf:5.1f}%  "
                  f"spd={speed:4.0f}km/h  load={load:4.0f}%  {eng}  "
                  f"{'[' + pending_tag + ']' if pending_tag else ''}")
            pending_tag = ""

    print(f"[collect] done. {out_path}")
    return 0


# REPLAY MODE
def _run_replay(args: argparse.Namespace) -> int:
    src = Path(args.input)
    df = _load_csv_any_schema(src)

    raw   = df["raw_fuel_pct"].to_numpy()
    speed = df["speed_kmph"].fillna(0.0).to_numpy()
    load  = df["engine_load_pct"].fillna(30.0).to_numpy()

    df["fuel_ma"] = moving_average_series(raw, MA_WINDOW)
    df["fuel_kf"] = kalman_series(raw, df["timestamp"], speed, load)

    out = Path(args.out or src.with_suffix(".replayed.csv"))
    df.to_csv(out, index=False)
    print(f"[replay] re-filtered {len(df)} rows -> {out}")
    return 0


# ANALYZE MODE
def _rms_first_diff(series: np.ndarray) -> float:
    d = np.diff(series)
    d = d[np.isfinite(d)]
    return float(np.sqrt(np.mean(d ** 2))) if len(d) else float("nan")


def _run_analyze(args: argparse.Namespace) -> int:
    src = Path(args.input)
    df = _load_csv_any_schema(src)
    times = df["timestamp"].to_numpy()
    raw   = df["raw_fuel_pct"].to_numpy()
    ma    = df["fuel_ma"].to_numpy()
    kf    = df["fuel_kf"].to_numpy()
    speed = df["speed_kmph"].fillna(0.0).to_numpy()

    # Axis 1: noise reduction on longest stationary run
    stationary = speed < 5.0
    ma_noise = _rms_first_diff(ma[stationary])
    kf_noise = _rms_first_diff(kf[stationary])

    # Axis 2: signal preservation on any labelled step drop
    def _preservation_ratio(filt):
        ratios = []
        for i in range(5, len(raw) - 5):
            raw_drop = raw[i - 5] - raw[i + 5]
            flt_drop = filt[i - 5] - filt[i + 5]
            if raw_drop > 1.0:
                ratios.append(flt_drop / raw_drop)
        return float(np.median(ratios)) if ratios else float("nan")

    ma_pres = _preservation_ratio(ma)
    kf_pres = _preservation_ratio(kf)

    # Axis 3: how often the filter diverges from the deployed MA
    # (Only meaningful axis for a live test without labels: we count rows
    # the model-aware filter would have flagged differently from the
    # deployed one.)
    divergence_rows = int(np.sum(np.abs(kf - ma) >= 1.0))
    divergence_pct  = 100.0 * divergence_rows / len(df) if len(df) else 0.0

    # Per-scenario noise reduction (if scenario_tag present)
    per_scenario: dict[str, dict[str, float]] = {}
    if "scenario_tag" in df.columns:
        for tag, sub in df.groupby("scenario_tag"):
            tag = str(tag)
            if not tag or tag == "nan":
                continue
            sub_raw = sub["raw_fuel_pct"].to_numpy()
            sub_ma  = sub["fuel_ma"].to_numpy()
            sub_kf  = sub["fuel_kf"].to_numpy()
            per_scenario[tag] = {
                "n_rows":          int(len(sub)),
                "raw_rms_pct":     _rms_first_diff(sub_raw),
                "ma_rms_pct":      _rms_first_diff(sub_ma),
                "kf_rms_pct":      _rms_first_diff(sub_kf),
                "ma_reduction_x":  (_rms_first_diff(sub_raw) / _rms_first_diff(sub_ma)) if _rms_first_diff(sub_ma) > 0 else float("nan"),
                "kf_reduction_x":  (_rms_first_diff(sub_raw) / _rms_first_diff(sub_kf)) if _rms_first_diff(sub_kf) > 0 else float("nan"),
            }

    # Emit results
    outdir = Path(args.outdir or src.parent / (src.stem + "_analysis"))
    outdir.mkdir(parents=True, exist_ok=True)

    summary = {
        "trip_file":                 str(src),
        "n_rows":                    int(len(df)),
        "duration_min":              float((pd.Timestamp(times[-1]) - pd.Timestamp(times[0])).total_seconds() / 60.0) if len(df) > 1 else 0.0,
        "stationary_rows":           int(stationary.sum()),
        "noise_rms_raw_pct":         _rms_first_diff(raw),
        "noise_rms_ma_pct":          ma_noise,
        "noise_rms_kf_pct":          kf_noise,
        "signal_preservation_ma":    ma_pres,
        "signal_preservation_kf":    kf_pres,
        "divergence_rows_gt_1pct":   divergence_rows,
        "divergence_pct":            divergence_pct,
        "per_scenario":              per_scenario,
    }

    import json
    (outdir / "summary.json").write_text(json.dumps(summary, indent=2))

    # LaTeX-ready table
    def _fmt(v, pct=False, sfx=""):
        if isinstance(v, float) and np.isnan(v):
            return "---"
        return (f"{v:.4f}" if not pct else f"{v:.2f}\\%") + sfx

    tex_lines = [
        r"\begin{table}[!htbp]",
        r"\centering",
        r"\caption{Live Filter Comparison on Field Trip}",
        r"\label{tab:live_filter_comparison}",
        r"\small",
        r"\begin{tabular}{|p{0.42\textwidth}|c|c|}",
        r"\hline",
        r"\textbf{Metric} & \textbf{Moving Average} & \textbf{Kalman Filter} \\",
        r"\hline",
        f"Noise RMS on stationary rows (\\%) & {_fmt(ma_noise)} & {_fmt(kf_noise)} \\\\",
        r"\hline",
        f"Signal preservation ratio & {_fmt(ma_pres)} & {_fmt(kf_pres)} \\\\",
        r"\hline",
        f"Rows with |KF-MA| $\\geq$ 1\\% of tank & \\multicolumn{{2}}{{c|}}{{{divergence_rows} of {len(df)} ({divergence_pct:.1f}\\%)}} \\\\",
        r"\hline",
        r"\end{tabular}",
        r"\end{table}",
    ]
    if per_scenario:
        tex_lines += [
            "",
            r"\begin{table}[!htbp]",
            r"\centering",
            r"\caption{Per-Scenario Noise Reduction (RMS of consecutive-sample differences, \\% of tank)}",
            r"\label{tab:live_filter_per_scenario}",
            r"\small",
            r"\begin{tabular}{|l|r|r|r|r|r|r|}",
            r"\hline",
            r"\textbf{Scenario} & \textbf{n} & \textbf{Raw} & \textbf{MA} & \textbf{KF} & \textbf{MA red.} & \textbf{KF red.} \\",
            r"\hline",
        ]
        for tag in sorted(per_scenario.keys()):
            s = per_scenario[tag]
            tex_lines.append(
                f"{tag} & {s['n_rows']} & {_fmt(s['raw_rms_pct'])} & "
                f"{_fmt(s['ma_rms_pct'])} & {_fmt(s['kf_rms_pct'])} & "
                f"{_fmt(s['ma_reduction_x'])}$\\times$ & {_fmt(s['kf_reduction_x'])}$\\times$ \\\\"
            )
            tex_lines.append(r"\hline")
        tex_lines += [r"\end{tabular}", r"\end{table}"]
    (outdir / "table.tex").write_text("\n".join(tex_lines))

    # Overlay plot for whole trip
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        t_min = (pd.to_datetime(times, utc=True) - pd.to_datetime(times[0], utc=True)).total_seconds() / 60.0
        fig, ax = plt.subplots(figsize=(10, 4.5))
        ax.plot(t_min, raw, color="#B0B7C3", linewidth=0.9, label="raw sender")
        ax.plot(t_min, ma,  color="#1F365D", linewidth=1.5, label="moving average")
        ax.plot(t_min, kf,  color="#D9603D", linewidth=1.5, label="Kalman filter")
        ax.set_xlabel("time within trip (min)")
        ax.set_ylabel("fuel level (%)")
        ax.set_title(f"Live filter overlay --- {src.stem}")
        ax.grid(True, alpha=0.3)
        ax.legend(loc="best", framealpha=0.9)
        fig.tight_layout()
        fig.savefig(outdir / "overlay_full_trip.png", dpi=140)
        plt.close(fig)
    except ImportError:
        print("[analyze] matplotlib not available; skipping plots")

    print()
    print(f"[analyze] wrote {outdir}/summary.json")
    print(f"[analyze] wrote {outdir}/table.tex")
    print(f"[analyze] wrote {outdir}/overlay_full_trip.png")
    print()
    print(f"{'Metric':<38s} {'Moving Avg':>12s} {'Kalman':>12s}")
    print("-" * 66)
    print(f"{'Noise RMS on stationary (%)':<38s} {ma_noise:>12.4f} {kf_noise:>12.4f}")
    print(f"{'Signal preservation ratio':<38s} {ma_pres:>12.4f} {kf_pres:>12.4f}")
    print(f"{'Rows with |KF-MA| >= 1%':<38s} {divergence_rows:>12d} / {len(df)}")
    if per_scenario:
        print()
        print(f"{'Scenario':<10s} {'n':>4s} {'Raw':>8s} {'MA':>8s} {'KF':>8s} {'MA red.':>9s} {'KF red.':>9s}")
        print("-" * 62)
        for tag in sorted(per_scenario.keys()):
            s = per_scenario[tag]
            print(f"{tag:<10s} {s['n_rows']:>4d} {s['raw_rms_pct']:>8.3f} "
                  f"{s['ma_rms_pct']:>8.3f} {s['kf_rms_pct']:>8.3f} "
                  f"{s['ma_reduction_x']:>8.2f}x {s['kf_reduction_x']:>8.2f}x")
    return 0


# Entry point
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)

    p_col = sub.add_parser("collect", help="Live ELM327 capture with dual filtering")
    p_col.add_argument("--port", required=True, help="ELM327 serial port (e.g., COM7, /dev/rfcomm0)")
    p_col.add_argument("--baud", type=int, default=38400, help="ELM327 baud rate (default 38400)")
    p_col.add_argument("--out",  required=True, help="Output CSV path")

    p_rep = sub.add_parser("replay", help="Re-filter an existing CSV with the current KF/MA configs")
    p_rep.add_argument("--input", required=True, help="Input CSV (must have raw_fuel_pct, speed_kmph, engine_load_pct, timestamp)")
    p_rep.add_argument("--out",   default=None, help="Output CSV path (default: <input>.replayed.csv)")

    p_ana = sub.add_parser("analyze", help="Post-trip comparison table + plots")
    p_ana.add_argument("--input",  required=True, help="Input CSV (from collect or replay)")
    p_ana.add_argument("--outdir", default=None, help="Output directory (default: <input>_analysis/)")

    args = ap.parse_args()
    if args.mode == "collect":  return _run_collect(args)
    if args.mode == "replay":   return _run_replay(args)
    if args.mode == "analyze":  return _run_analyze(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
