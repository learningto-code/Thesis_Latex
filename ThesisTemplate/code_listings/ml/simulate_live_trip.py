from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import signal
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import requests


BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR.parent / "backend" / ".env"
PH_OFFSET = dt.timedelta(hours=8)

TRUCK_ID  = "11111111-0000-0000-0000-000000000002"
TRUCK_CODE = "TRCK-02"
PLATE_NUMBER = "DEF-5678"
DRIVER_ID = "f98fa55e-3d6a-4f80-aadc-daee569231bf"
DRIVER_NAME = "Driver 2"

# Para?aque (Hino dealership area) -> Batangas City Port
ORIGIN_LAT, ORIGIN_LON = 14.4795, 121.0198
DEST_LAT, DEST_LON     = 13.7565, 121.0583
DEST_LABEL = "Batangas City Port"

OSRM_HOST = "https://router.project-osrm.org"

_run = True


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def _fetch_osrm_route() -> list[tuple[float, float]]:
    """Returns a list of (lat, lon) points along the real road geometry."""
    url = (
        f"{OSRM_HOST}/route/v1/driving/"
        f"{ORIGIN_LON},{ORIGIN_LAT};{DEST_LON},{DEST_LAT}"
        "?overview=full&geometries=geojson"
    )
    r = requests.get(url, timeout=15)
    r.raise_for_status()
    data = r.json()
    coords = data["routes"][0]["geometry"]["coordinates"]  # [[lon,lat], ...]
    return [(lat, lon) for lon, lat in coords]


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    R = 6371.0
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dphi = lat2 - lat1
    dlmb = lon2 - lon1
    h = math.sin(dphi / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def _resample_route(
    waypoints: list[tuple[float, float]], n: int
) -> tuple[list[tuple[float, float]], float]:
    if len(waypoints) < 2:
        return [waypoints[0]] * n, 0.0
    segs = [_haversine_km(waypoints[i], waypoints[i + 1]) for i in range(len(waypoints) - 1)]
    total = sum(segs)
    cumlen = [0.0]
    for s in segs:
        cumlen.append(cumlen[-1] + s)
    out: list[tuple[float, float]] = []
    for i in range(n):
        target = total * i / max(1, n - 1)
        seg_idx = 0
        while seg_idx < len(segs) - 1 and cumlen[seg_idx + 1] < target:
            seg_idx += 1
        seg_start = cumlen[seg_idx]
        seg_end = cumlen[seg_idx + 1]
        if seg_end <= seg_start:
            out.append(waypoints[seg_idx])
            continue
        f = (target - seg_start) / (seg_end - seg_start)
        a = waypoints[seg_idx]
        b = waypoints[seg_idx + 1]
        out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return out, total


def _speed_at_index(i: int, n: int, rest_start: int, rest_end: int) -> float:
    if rest_start <= i < rest_end:
        return 0.0
    frac = i / max(1, n - 1)
    if frac < 0.04:
        return 25 + frac * 1000          # ramp 25 -> 65
    if frac < 0.32:
        return 70 + 8 * math.sin(frac * 18)    # SLEX cruise 62-78
    if 0.32 <= frac < 0.34:
        return 82                              # overspeed burst 1
    if frac < 0.50:
        return 68 + 10 * math.sin(frac * 22)
    if frac < 0.72:
        return 72 + 5 * math.sin(frac * 25)    # STAR cruise
    if 0.72 <= frac < 0.74:
        return 85                              # overspeed burst 2
    if frac < 0.92:
        return max(20, 60 - (frac - 0.74) * 200)  # decel
    return 18                                  # arrival city


def _build_row(
    trip_id: str,
    ts: dt.datetime,
    i: int,
    n: int,
    positions: list[tuple[float, float]],
    total_km: float,
    rest_start: int,
    rest_end: int,
) -> dict[str, Any]:
    lat, lon = positions[i]
    frac = i / max(1, n - 1)
    spd = _speed_at_index(i, n, rest_start, rest_end)
    fuel = 82.0 - 26.0 * frac            # 82% -> 56%
    is_resting = rest_start <= i < rest_end
    rpm = 0 if is_resting else int(800 + spd * 22)
    return {
        "id": str(uuid.uuid4()),
        "trip_id": trip_id,
        "truck_id": TRUCK_ID,
        "driver_id": DRIVER_ID,
        "timestamp": ts.isoformat().replace("+00:00", "Z"),
        "sent_at":   ts.isoformat().replace("+00:00", "Z"),
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "speed": round(spd, 1),
        "fuel_level": round(fuel, 1),
        "odometer_km": round(total_km * frac, 2),
        "engine_status": "off" if is_resting else ("idle" if spd < 1 else "on"),
        "engine_rpm": rpm,
        "engine_load_pct": round(0.0 if is_resting else (35 + spd * 0.5), 2),
        "throttle_pct":    round(0.0 if is_resting else (15 + spd * 0.4), 2),
        "fuel_valid": True, "fuel_source": "obd2", "fuel_confidence": 1,
        "gps_valid": True, "gps_source": "embedded_gps", "gps_accuracy_m": 2.5,
        "anomaly_flag": False, "anomaly_score": 0.005, "anomaly_type": "normal",
        "model_source": "live_deployment",
        "comm_channel": "wifi",
        "delta_time_sec": 5,
        "hmi_driving_sec": i * 5,
        "hmi_rest_sec": 900 if i >= rest_end else 0,
        "hmi_trip_status": "paused" if is_resting else "active",
        "source_device": "hmi",
    }


def _handle_sigint(signum, frame):  # noqa: ARG001
    global _run
    _run = False
    print("\n[live] Ctrl+C received -- ending trip cleanly...")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration-min", type=int, default=150,
                        help="Total trip duration in minutes (default 150 = 2h30m)")
    parser.add_argument("--cadence-sec", type=int, default=5,
                        help="Telemetry cadence in seconds (default 5)")
    parser.add_argument("--backfill-min", type=int, default=5,
                        help="How many minutes of past telemetry to backfill so the dashboard has history immediately (default 5)")
    parser.add_argument("--rest-at-min", type=int, default=75,
                        help="Trigger rest break at this minute mark (default 75)")
    parser.add_argument("--rest-duration-min", type=int, default=15)
    args = parser.parse_args()

    env = _load_env()
    base = env["SUPABASE_URL"].rstrip("/")
    svc  = env["SUPABASE_SERVICE_KEY"]
    headers = {
        "apikey": svc, "Authorization": f"Bearer {svc}",
        "Content-Type": "application/json", "Prefer": "return=minimal",
    }

    print(f"[live] Fetching OSRM road geometry: Paranaque -> {DEST_LABEL}...")
    raw_waypoints = _fetch_osrm_route()
    n_rows = (args.duration_min * 60) // args.cadence_sec
    positions, total_km = _resample_route(raw_waypoints, n_rows)
    print(f"[live] Route fetched: {len(raw_waypoints)} polyline points, "
          f"resampled to {n_rows} telemetry rows, total {total_km:.1f} km.")

    trip_id = str(uuid.uuid4())
    start_utc = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=args.backfill_min)
    end_utc   = start_utc + dt.timedelta(minutes=args.duration_min)
    rest_start_idx = (args.rest_at_min * 60) // args.cadence_sec
    rest_end_idx   = rest_start_idx + (args.rest_duration_min * 60) // args.cadence_sec

    # 1) Create trip_session as ACTIVE
    session = {
        "id": trip_id, "truck_id": TRUCK_ID, "driver_id": DRIVER_ID,
        "start_time": start_utc.isoformat().replace("+00:00", "Z"),
        "trip_status": "active",
        "assigned_destination": DEST_LABEL,
        "dest_lat": DEST_LAT, "dest_lon": DEST_LON,
        "route_dist_m": int(total_km * 1000),
        "route_dur_s": args.duration_min * 60,
    }
    r = requests.post(f"{base}/rest/v1/trip_sessions", headers=headers, json=[session], timeout=20)
    if r.status_code not in (200, 201, 204):
        print(f"[error] session insert failed: {r.status_code} {r.text[:200]}")
        return
    print(f"[live] Trip created: id={trip_id[:8]}  status=active  start={session['start_time']}")

    # 2) trip_started event + summary placeholder
    requests.post(f"{base}/rest/v1/trip_events", headers=headers, json=[{
        "trip_id": trip_id, "truck_id": TRUCK_ID, "driver_id": DRIVER_ID,
        "event_type": "trip_started",
        "timestamp": session["start_time"],
    }], timeout=10)
    rh = {**headers, "Prefer": "resolution=merge-duplicates"}
    requests.post(f"{base}/rest/v1/trip_summaries", headers=rh, json=[{
        "trip_id": trip_id, "truck_id": TRUCK_ID, "driver_id": DRIVER_ID,
        "truck_code": TRUCK_CODE, "plate_number": PLATE_NUMBER, "driver_name": DRIVER_NAME,
        "trip_status": "active",
        "start_time": session["start_time"],
        "total_distance_km": 0, "total_operating_hours": 0,
        "total_anomalies": 0, "total_alerts": 0, "log_count": 0,
        "start_fuel_level": 82.0,
    }], timeout=10)

    # 3) Backfill the past few minutes so the dashboard has history immediately
    print(f"[live] Backfilling {args.backfill_min} min of history...")
    backfill_rows = []
    for i in range((args.backfill_min * 60) // args.cadence_sec):
        ts = start_utc + dt.timedelta(seconds=i * args.cadence_sec)
        backfill_rows.append(_build_row(trip_id, ts, i, n_rows, positions, total_km, rest_start_idx, rest_end_idx))
    for chunk in range(0, len(backfill_rows), 200):
        requests.post(f"{base}/rest/v1/telemetry_logs", headers=headers,
                      json=backfill_rows[chunk:chunk + 200], timeout=30)
    print(f"[live] Backfilled {len(backfill_rows)} rows.")

    signal.signal(signal.SIGINT, _handle_sigint)
    next_idx = len(backfill_rows)
    overspeed1_idx = int(n_rows * 0.33)   # ~minute 50
    overspeed2_idx = int(n_rows * 0.73)   # ~minute 110
    rest_alert_idx = rest_start_idx - 6   # ~30 sec before rest
    snooze_idx     = rest_start_idx - 5
    rest_event_idx = rest_start_idx
    resume_event_idx = rest_end_idx

    fired = set()
    print(f"[live] Entering real-time loop -- Ctrl+C to end trip cleanly.\n")
    while _run and next_idx < n_rows:
        # Where should we be NOW vs trip-start
        elapsed_s = (dt.datetime.now(dt.timezone.utc) - start_utc).total_seconds()
        target_idx = int(elapsed_s // args.cadence_sec)
        # Emit any rows that wall-time has caught up to
        while next_idx <= target_idx and next_idx < n_rows:
            ts = start_utc + dt.timedelta(seconds=next_idx * args.cadence_sec)
            row = _build_row(trip_id, ts, next_idx, n_rows, positions, total_km, rest_start_idx, rest_end_idx)
            requests.post(f"{base}/rest/v1/telemetry_logs", headers=headers, json=[row], timeout=10)
            if next_idx % 12 == 0:
                pos = positions[next_idx]
                print(f"  i={next_idx:4d}  t={ts.strftime('%H:%M:%S')}  spd={row['speed']:.0f} km/h  "
                      f"fuel={row['fuel_level']:.0f}%  pos=({pos[0]:.4f},{pos[1]:.4f})  "
                      f"status={row['hmi_trip_status']}")

            # Trigger events at their indices
            if next_idx == overspeed1_idx and "ov1" not in fired:
                fired.add("ov1")
                requests.post(f"{base}/rest/v1/alerts", headers=headers, json=[{
                    "truck_id": TRUCK_ID, "driver_id": DRIVER_ID, "trip_id": trip_id,
                    "alert_type": "overspeed", "severity": "medium",
                    "message": "Overspeed: 82 km/h (limit 80 km/h)",
                    "timestamp": ts.isoformat().replace("+00:00", "Z"),
                    "is_resolved": False,
                }], timeout=10)
                print(f"  [alert] overspeed #1 @ {ts.strftime('%H:%M:%S')}")
            if next_idx == overspeed2_idx and "ov2" not in fired:
                fired.add("ov2")
                requests.post(f"{base}/rest/v1/alerts", headers=headers, json=[{
                    "truck_id": TRUCK_ID, "driver_id": DRIVER_ID, "trip_id": trip_id,
                    "alert_type": "overspeed", "severity": "medium",
                    "message": "Overspeed: 85 km/h (limit 80 km/h)",
                    "timestamp": ts.isoformat().replace("+00:00", "Z"),
                    "is_resolved": False,
                }], timeout=10)
                print(f"  [alert] overspeed #2 @ {ts.strftime('%H:%M:%S')}")
            if next_idx == rest_alert_idx and "ra" not in fired:
                fired.add("ra")
                requests.post(f"{base}/rest/v1/alerts", headers=headers, json=[{
                    "truck_id": TRUCK_ID, "driver_id": DRIVER_ID, "trip_id": trip_id,
                    "alert_type": "rest_alert", "severity": "high",
                    "message": "Rest break required -- 75 min continuous driving exceeded threshold",
                    "timestamp": ts.isoformat().replace("+00:00", "Z"),
                    "is_resolved": False,
                }], timeout=10)
                print(f"  [alert] rest_alert @ {ts.strftime('%H:%M:%S')}")
            if next_idx == snooze_idx and "sn" not in fired:
                fired.add("sn")
                requests.post(f"{base}/rest/v1/trip_events", headers=headers, json=[{
                    "trip_id": trip_id, "truck_id": TRUCK_ID, "driver_id": DRIVER_ID,
                    "event_type": "rest_snoozed",
                    "timestamp": ts.isoformat().replace("+00:00", "Z"),
                }], timeout=10)
                print(f"  [event] rest_snoozed @ {ts.strftime('%H:%M:%S')}")
            if next_idx == rest_event_idx and "rest" not in fired:
                fired.add("rest")
                requests.post(f"{base}/rest/v1/trip_events", headers=headers, json=[{
                    "trip_id": trip_id, "truck_id": TRUCK_ID, "driver_id": DRIVER_ID,
                    "event_type": "rest_started",
                    "timestamp": ts.isoformat().replace("+00:00", "Z"),
                }], timeout=10)
                # Flip session to paused
                requests.patch(
                    f"{base}/rest/v1/trip_sessions?id=eq.{trip_id}",
                    headers=headers,
                    json={"trip_status": "paused",
                          "paused_at": ts.isoformat().replace("+00:00", "Z")},
                    timeout=10,
                )
                print(f"  [event] rest_started @ {ts.strftime('%H:%M:%S')}  (trip -> paused)")
            if next_idx == resume_event_idx and "resume" not in fired:
                fired.add("resume")
                requests.post(f"{base}/rest/v1/trip_events", headers=headers, json=[{
                    "trip_id": trip_id, "truck_id": TRUCK_ID, "driver_id": DRIVER_ID,
                    "event_type": "trip_resumed",
                    "timestamp": ts.isoformat().replace("+00:00", "Z"),
                }], timeout=10)
                requests.patch(
                    f"{base}/rest/v1/trip_sessions?id=eq.{trip_id}",
                    headers=headers,
                    json={"trip_status": "active", "paused_at": None,
                          "total_rest_seconds": args.rest_duration_min * 60},
                    timeout=10,
                )
                print(f"  [event] trip_resumed @ {ts.strftime('%H:%M:%S')}  (trip -> active)")

            next_idx += 1
        # Keep trip_sessions.distance_km in sync with reality every loop pass.
        # The dashboard reads that column directly; without this it would
        if next_idx > 0:
            live_km = round(total_km * (next_idx - 1) / max(1, n_rows - 1), 2)
            requests.patch(
                f"{base}/rest/v1/trip_sessions?id=eq.{trip_id}",
                headers=headers,
                json={"distance_km": live_km},
                timeout=10,
            )
            requests.patch(
                f"{base}/rest/v1/trip_summaries?trip_id=eq.{trip_id}",
                headers=headers,
                json={"total_distance_km": live_km, "log_count": next_idx},
                timeout=10,
            )
        time.sleep(min(args.cadence_sec, 2))

    # 5) End trip
    end_ts = dt.datetime.now(dt.timezone.utc)
    end_iso = end_ts.isoformat().replace("+00:00", "Z")
    requests.patch(
        f"{base}/rest/v1/trip_sessions?id=eq.{trip_id}",
        headers=headers,
        json={"trip_status": "ended", "end_time": end_iso,
              "distance_km": round(total_km, 2)},
        timeout=10,
    )
    requests.post(f"{base}/rest/v1/trip_events", headers=headers, json=[{
        "trip_id": trip_id, "truck_id": TRUCK_ID, "driver_id": DRIVER_ID,
        "event_type": "trip_ended", "timestamp": end_iso,
    }], timeout=10)
    # Final summary update
    requests.patch(
        f"{base}/rest/v1/trip_summaries?trip_id=eq.{trip_id}",
        headers=headers,
        json={"trip_status": "ended", "end_time": end_iso,
              "total_distance_km": round(total_km, 2),
              "total_operating_hours": round(args.duration_min / 60.0, 2),
              "log_count": next_idx, "final_fuel_level": 56.0,
              "average_fuel_level": 69.0,
              "total_alerts": len([k for k in fired if k.startswith("ov")]) + (1 if "ra" in fired else 0)},
        timeout=10,
    )
    # Recompute truck mileage
    print(f"\n[live] Trip ended. id={trip_id[:8]}  rows emitted={next_idx}/{n_rows}")
    print(f"[live] Dashboard URL: open the Trips tab and select today's TRCK-02 trip.")


if __name__ == "__main__":
    main()
