from __future__ import annotations

import datetime as dt
import json
import math
import time
import uuid
from pathlib import Path
from typing import Iterable

import requests


BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR.parent / "backend" / ".env"
PH_OFFSET = dt.timedelta(hours=8)  # Asia/Manila

# Fleet IDs
# deployment vehicle / driver -- their data must remain real-world only.
TRUCK_01_RESERVED  = "3b9403f0-d3e7-4b4d-baf1-151074c7e7dd"  # NEVER inject into this truck
DRIVER_1_RESERVED  = "407b1d2f-1553-4633-b237-8bdcae54b3cf"  # NEVER inject for this driver

TRUCK_02 = "11111111-0000-0000-0000-000000000002"  # DEF-5678
TRUCK_03 = "11111111-0000-0000-0000-000000000003"  # GHI-9012
TRUCK_04 = "11111111-0000-0000-0000-000000000004"  # JKL-3456
DRIVER_2 = "f98fa55e-3d6a-4f80-aadc-daee569231bf"
DRIVER_3 = "7bdcf669-14fe-4e5f-ab99-0584573dab96"
DRIVER_4 = "f59cdba7-513d-42af-8249-954a08f7e9cd"

_RESERVED_TRUCKS  = {TRUCK_01_RESERVED}
_RESERVED_DRIVERS = {DRIVER_1_RESERVED}


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def _ph(year: int, month: int, day: int, hh: int, mm: int = 0) -> dt.datetime:
    """Construct a PHT (UTC+8) timestamp returned in UTC."""
    return dt.datetime(year, month, day, hh, mm, tzinfo=dt.timezone(PH_OFFSET)).astimezone(dt.timezone.utc)


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    R = 6371.0
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dphi = lat2 - lat1
    dlmb = lon2 - lon1
    h = math.sin(dphi / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def _interpolate_route(waypoints: list[tuple[float, float]], n: int) -> list[tuple[float, float]]:
    if len(waypoints) < 2:
        return [waypoints[0]] * n
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
        a = waypoints[seg_idx]; b = waypoints[seg_idx + 1]
        seg_len = segs[seg_idx] if segs[seg_idx] > 1e-9 else 1e-9
        frac = (target - cumlen[seg_idx]) / seg_len
        lat = a[0] + frac * (b[0] - a[0])
        lon = a[1] + frac * (b[1] - a[1])
        out.append((lat, lon))
    return out


def _speed_profile(n: int, peak_kmh: float, parked_indices: Iterable[int] = ()) -> list[float]:
    parked = set(parked_indices)
    speeds: list[float] = []
    ramp = max(3, n // 12)
    for i in range(n):
        if i in parked:
            speeds.append(0.0); continue
        if i < ramp:
            v = peak_kmh * (i + 1) / ramp
        elif i > n - ramp - 1:
            v = peak_kmh * (n - i) / ramp
        else:
            v = peak_kmh * (0.85 + 0.15 * math.sin(i * 0.3))
        speeds.append(max(0.0, v))
    return speeds


def _obd_from_speed(speed_kmh: float) -> tuple[int, float, float]:
    """Return (rpm, engine_load_pct, throttle_pct) crudely correlated with speed."""
    if speed_kmh < 1:
        return 720, 18.0 + 5 * math.sin(time.time()), 12.0
    if speed_kmh < 25:
        return int(900 + speed_kmh * 18), 35.0 + speed_kmh * 0.6, 18.0 + speed_kmh * 0.25
    if speed_kmh < 70:
        return int(1100 + speed_kmh * 11), 45.0 + min(40, speed_kmh * 0.4), 22.0 + min(30, speed_kmh * 0.3)
    return int(1500 + (speed_kmh - 70) * 9), 70.0 + min(15, (speed_kmh - 70) * 0.3), 28.0 + min(10, (speed_kmh - 70) * 0.2)


def _gen_trip(
    *,
    trip_id: str,
    truck_id: str,
    driver_id: str,
    start_utc: dt.datetime,
    duration_min: int,
    waypoints: list[tuple[float, float]],
    fuel_start_pct: float,
    fuel_end_pct: float,
    anomaly_window: tuple[int, int] | None = None,  # (start_idx, end_idx) inclusive
    anomaly_type: str = "normal",
    anomaly_fuel_path: list[float] | None = None,    # overrides fuel within window
    parked_indices: Iterable[int] = (),
    peak_kmh: float = 55.0,
    odometer_start_km: float = 0.0,
    tank_capacity_l: float = 80.0,
) -> tuple[dict, list[dict]]:
    """Build one (trip_session, [telemetry_rows]) pair."""
    cadence_sec = 5
    n_rows = max(2, (duration_min * 60) // cadence_sec)
    end_utc = start_utc + dt.timedelta(minutes=duration_min)
    positions = _interpolate_route(waypoints, n_rows)
    speeds = _speed_profile(n_rows, peak_kmh, parked_indices=parked_indices)

    # Fuel trajectory -- baseline linear decrement, then overlay anomaly
    fuel = [fuel_start_pct + (fuel_end_pct - fuel_start_pct) * (i / max(1, n_rows - 1)) for i in range(n_rows)]
    if anomaly_window and anomaly_fuel_path:
        lo, hi = anomaly_window
        path = list(anomaly_fuel_path)
        path = (path + [path[-1]] * (hi - lo + 1))[: hi - lo + 1]
        for k, idx in enumerate(range(lo, hi + 1)):
            fuel[idx] = path[k]
        # After anomaly window, hold the last anomaly value as the new baseline
        if hi + 1 < n_rows:
            tail = [fuel[hi]] * (n_rows - hi - 1)
            fuel[hi + 1:] = tail

    # Build telemetry rows
    odo = odometer_start_km
    prev_pos = positions[0]
    rows: list[dict] = []
    anomaly_rows = set(range(*anomaly_window)) if anomaly_window else set()
    if anomaly_window:
        anomaly_rows = set(range(anomaly_window[0], anomaly_window[1] + 1))

    cumulative_km = 0.0
    for i in range(n_rows):
        ts = start_utc + dt.timedelta(seconds=i * cadence_sec)
        lat, lon = positions[i]
        speed = speeds[i]
        if i > 0:
            step_km = _haversine_km(prev_pos, positions[i])
            cumulative_km += step_km
            odo += step_km
        prev_pos = positions[i]
        rpm, load, throttle = _obd_from_speed(speed)
        is_anom_row = i in anomaly_rows
        # Score: low normally, high in anomaly window
        if is_anom_row:
            anomaly_score = round(0.060 + 0.015 * (i - min(anomaly_rows)) / max(1, len(anomaly_rows)), 4)
            anom_flag = True
            type_tag = anomaly_type
        else:
            anomaly_score = round(0.005 + 0.012 * math.sin(i * 0.2), 4)
            anom_flag = False
            type_tag = "normal"
        rows.append({
            "id": str(uuid.uuid4()),
            "trip_id": trip_id,
            "truck_id": truck_id,
            "driver_id": driver_id,
            "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "sent_at": ts.isoformat().replace("+00:00", "Z"),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "speed": round(speed, 1),
            "fuel_level": round(fuel[i], 1),
            "odometer_km": round(odo, 2),
            "engine_status": "idle" if speed < 1.0 else "on",
            "engine_rpm": rpm,
            "engine_load_pct": round(load, 2),
            "throttle_pct": round(throttle, 2),
            "fuel_valid": True,
            "fuel_source": "obd2",
            "fuel_confidence": 1,
            "gps_valid": True,
            "gps_source": "embedded_gps",
            "gps_accuracy_m": 2.5,
            "anomaly_flag": anom_flag,
            "anomaly_score": anomaly_score,
            "anomaly_type": type_tag,
            "model_source": "simulated_test_trip" if not anom_flag else "simulated_planted_anomaly",
            "comm_channel": "lora",
            "delta_time_sec": cadence_sec,
            "distance_gps_delta_km": round(step_km if i > 0 else 0.0, 4),
            "distance_obd_delta_km": round(step_km if i > 0 else 0.0, 4),
            "distance_fused_delta_km": round(step_km if i > 0 else 0.0, 4),
            "hmi_driving_sec": int(i * cadence_sec),
            "hmi_rest_sec": 0,
            "hmi_trip_status": "active",
            "source_device": "hmi",
        })

    op_hours = round(n_rows * cadence_sec / 3600.0, 2)
    session = {
        "id": trip_id,
        "truck_id": truck_id,
        "driver_id": driver_id,
        "start_time": start_utc.isoformat().replace("+00:00", "Z"),
        "end_time": end_utc.isoformat().replace("+00:00", "Z"),
        "trip_status": "ended",
        "distance_km": round(cumulative_km, 2),
        "operating_hours": op_hours,
    }
    return session, rows


# 8 trip definitions (PHT timestamps converted to UTC)
TRIPS = [
    # 1 -- Makati -> Batangas Port, gradual siphon at rest stop
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_02, driver_id=DRIVER_2,
        start_utc=_ph(2026, 6, 10, 6, 0),
        duration_min=150,
        waypoints=[(14.5547, 121.0244), (14.45, 121.05), (14.30, 121.07),
                   (14.10, 121.05), (13.84, 121.05), (13.76, 121.06)],
        fuel_start_pct=92.0, fuel_end_pct=63.0,
        anomaly_window=(540, 720),
        anomaly_type="gradual_leak",
        anomaly_fuel_path=[76.0 - 0.04 * i for i in range(181)],
        parked_indices=range(540, 720),
        peak_kmh=78.0,
    ),
    # 2 -- QC -> Bulacan NLEX, sudden 12% drop
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_03, driver_id=DRIVER_4,
        start_utc=_ph(2026, 6, 11, 8, 0),
        duration_min=90,
        waypoints=[(14.6760, 121.0437), (14.75, 121.02), (14.85, 121.04), (14.95, 121.07)],
        fuel_start_pct=85.0, fuel_end_pct=72.0,
        anomaly_window=(504, 505),  # row at ~42min
        anomaly_type="sudden_fuel_drop",
        anomaly_fuel_path=[78.0, 66.0],
        peak_kmh=85.0,
    ),
    # 3 -- Makati -> Tagaytay (uphill, CONTROL, no anomaly)
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_02, driver_id=DRIVER_3,
        start_utc=_ph(2026, 6, 12, 9, 0),
        duration_min=90,
        waypoints=[(14.5547, 121.0244), (14.40, 120.99), (14.27, 120.97), (14.115, 120.962)],
        fuel_start_pct=88.0, fuel_end_pct=72.0,  # heavier consumption from uphill load
        anomaly_window=None, anomaly_type="normal", anomaly_fuel_path=None,
        peak_kmh=62.0,
    ),
    # 4 -- Cavite -> Makati, abnormal rapid drain in traffic
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_04, driver_id=DRIVER_2,
        start_utc=_ph(2026, 6, 13, 6, 30),
        duration_min=90,
        waypoints=[(14.40, 120.94), (14.44, 120.97), (14.48, 121.00), (14.5547, 121.0244)],
        fuel_start_pct=65.0, fuel_end_pct=53.0,
        anomaly_window=(540, 660),  # 10 min window mid-trip in traffic
        anomaly_type="abnormal_rapid_decrease",
        anomaly_fuel_path=[60.0 - 0.10 * i for i in range(121)],  # ~12% drain
        peak_kmh=42.0,
    ),
    # 5 -- Antipolo -> Pasig depot, refuel-disguised siphoning
    # Class: siphoning_refuel_masked -- thief stops at a shadow location, takes
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_03, driver_id=DRIVER_4,
        start_utc=_ph(2026, 6, 14, 14, 0),
        duration_min=60,
        waypoints=[(14.5832, 121.1764), (14.58, 121.13), (14.58, 121.10), (14.5764, 121.0851)],
        fuel_start_pct=45.0, fuel_end_pct=27.0,
        anomaly_window=(300, 420),  # 10 min window @ depot stop
        anomaly_type="siphoning",
        # Linear drain of ~18% over the parked 10-min window
        anomaly_fuel_path=[45.0 - (i * 18 / 119) for i in range(120)],
        parked_indices=range(300, 420),
        peak_kmh=35.0,
    ),
    # 6 -- Laguna Tech Park overnight, slow siphoning at parked depot
    # Class: siphoning_overnight -- engine off, fuel slowly drops 0.1-0.2 L/min
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_02, driver_id=DRIVER_3,
        start_utc=_ph(2026, 6, 15, 18, 0),
        duration_min=360,  # 6 hours
        waypoints=[(14.3105, 121.0860), (14.3105, 121.0860)],  # parked
        fuel_start_pct=72.0, fuel_end_pct=58.0,
        anomaly_window=(720, 840),  # 10-min detection window mid-trip
        anomaly_type="siphoning",
        anomaly_fuel_path=[72.0 - 14.0 * (i / 119) for i in range(120)],
        parked_indices=range(0, 4320),
        peak_kmh=0.0,
    ),
    # 7 -- Makati -> Alabang, CONTROL
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_04, driver_id=DRIVER_2,
        start_utc=_ph(2026, 6, 16, 11, 0),
        duration_min=60,
        waypoints=[(14.5547, 121.0244), (14.52, 121.03), (14.48, 121.03), (14.4253, 121.0397)],
        fuel_start_pct=60.0, fuel_end_pct=56.0,
        anomaly_window=None, anomaly_type="normal", anomaly_fuel_path=None,
        peak_kmh=48.0,
    ),
    # 8 -- Manila -> Antipolo, CONTROL
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_03, driver_id=DRIVER_4,
        start_utc=_ph(2026, 6, 17, 15, 30),
        duration_min=75,
        waypoints=[(14.5995, 120.9842), (14.62, 121.03), (14.60, 121.10), (14.5832, 121.1764)],
        fuel_start_pct=50.0, fuel_end_pct=45.0,
        anomaly_window=None, anomaly_type="normal", anomaly_fuel_path=None,
        peak_kmh=45.0,
    ),
    # 9 -- Pasig warehouse, mid-day siphoning at loading bay
    # Class: siphoning -- 12L over 8 minutes while truck is parked at a
    # combined with the slosh-suppression baseline saying "no consumption
    # explained by engine work."
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_04, driver_id=DRIVER_2,
        start_utc=_ph(2026, 6, 18, 11, 0),
        duration_min=70,
        waypoints=[(14.5764, 121.0851), (14.58, 121.08), (14.58, 121.08), (14.5764, 121.0851)],
        fuel_start_pct=55.0, fuel_end_pct=40.0,
        anomaly_window=(360, 456),  # 8-min siphoning window at minute 30
        anomaly_type="siphoning",
        anomaly_fuel_path=[55.0 - (i * 15 / 95) for i in range(96)],
        parked_indices=range(360, 456),
        peak_kmh=18.0,
    ),
    # This is the high-severity instant-theft signature.
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_03, driver_id=DRIVER_3,
        start_utc=_ph(2026, 6, 19, 9, 30),
        duration_min=80,
        waypoints=[(14.6760, 121.0437), (14.75, 121.03), (14.85, 121.05), (14.95, 121.07)],
        fuel_start_pct=80.0, fuel_end_pct=58.0,
        anomaly_window=(420, 456),  # 3-min fuel-theft burst at minute 35
        anomaly_type="fuel_theft",
        anomaly_fuel_path=[80.0 - (i * 22 / 35) for i in range(37)],
        parked_indices=range(420, 456),
        peak_kmh=72.0,
    ),
    # 11 -- Cavite depot overnight, attempted small theft (3L = 4%)
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_04, driver_id=DRIVER_4,
        start_utc=_ph(2026, 6, 20, 22, 0),
        duration_min=300,  # 5h overnight
        waypoints=[(14.40, 120.94), (14.40, 120.94)],
        fuel_start_pct=65.0, fuel_end_pct=61.0,
        anomaly_window=(1800, 1830),  # 2.5-min theft burst 2.5h into parking
        anomaly_type="fuel_theft",
        anomaly_fuel_path=[65.0 - (i * 4 / 29) for i in range(31)],
        parked_indices=range(0, 3600),
        peak_kmh=0.0,
    ),
    # 12 -- Quezon City -> Marikina, repeated micro-siphoning during multiple stops
    # Class: siphoning_repeated -- three small 4-5L extractions across the trip
    dict(
        trip_id=str(uuid.uuid4()),
        truck_id=TRUCK_02, driver_id=DRIVER_4,
        start_utc=_ph(2026, 6, 21, 7, 0),
        duration_min=120,
        waypoints=[(14.6760, 121.0437), (14.65, 121.08), (14.64, 121.10), (14.6500, 121.1029)],
        fuel_start_pct=88.0, fuel_end_pct=66.0,
        anomaly_window=(300, 1200),  # broad window covering 3 sub-events
        anomaly_type="siphoning",
        anomaly_fuel_path=(
            [85.0 - (i * 5 / 59)  for i in range(60)] +   # event 1: 5L over 5min
            [80.0] * 300 +                                  # gap
            [80.0 - (i * 4 / 59)  for i in range(60)] +   # event 2: 4L over 5min
            [76.0] * 300 +                                  # gap
            [76.0 - (i * 5 / 119) for i in range(120)]    # event 3: 5L over 10min
        ),
        parked_indices=list(range(300, 360)) + list(range(660, 720)) + list(range(1080, 1200)),
        peak_kmh=42.0,
    ),
]


def _post_batch(url: str, headers: dict, payload: list[dict], chunk: int = 500) -> int:
    inserted = 0
    for i in range(0, len(payload), chunk):
        r = requests.post(url, headers=headers, json=payload[i:i + chunk], timeout=60)
        if r.status_code in (200, 201, 204):
            inserted += len(payload[i:i + chunk])
        else:
            print(f"  [warn] POST {url} batch {i}: {r.status_code} {r.text[:200]}")
            break
    return inserted


def inject_all(dry_run: bool = False) -> None:
    env = _load_env()
    base = env["SUPABASE_URL"].rstrip("/")
    headers = {
        "apikey": env["SUPABASE_SERVICE_KEY"],
        "Authorization": "Bearer " + env["SUPABASE_SERVICE_KEY"],
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    summary = []
    for i, t in enumerate(TRIPS, start=1):
        # Hard guard -- refuse to inject if any trip definition targets the
        if t["truck_id"] in _RESERVED_TRUCKS or t["driver_id"] in _RESERVED_DRIVERS:
            raise SystemExit(
                f"[abort] Trip {i} targets reserved live-deployment IDs "
                f"(truck={t['truck_id']}, driver={t['driver_id']}). "
                f"Edit TRIPS to use TRUCK_02-04 / DRIVER_2-4 only."
            )
        session, rows = _gen_trip(**t)
        print(f"Trip {i}: {session['id'][:8]}  truck={t['truck_id'][:8]}  "
              f"start={session['start_time']}  rows={len(rows)}  dist={session['distance_km']} km  "
              f"anomaly={t['anomaly_type']}")
        summary.append({
            "trip_id": session["id"],
            "truck_id": session["truck_id"],
            "start_time": session["start_time"],
            "anomaly_type": t["anomaly_type"],
            "n_rows": len(rows),
            "distance_km": session["distance_km"],
            "anomaly_window": t.get("anomaly_window"),
        })
        if dry_run:
            continue
        # Insert session
        rs = requests.post(f"{base}/rest/v1/trip_sessions", headers=headers, json=[session], timeout=30)
        if rs.status_code not in (200, 201, 204):
            print(f"  [error] session insert failed: {rs.status_code} {rs.text[:200]}"); continue
        # Insert telemetry
        n = _post_batch(f"{base}/rest/v1/telemetry_logs", headers, rows)
        print(f"  inserted {n}/{len(rows)} telemetry rows")
        rg = {"apikey": env["SUPABASE_SERVICE_KEY"],
              "Authorization": "Bearer " + env["SUPABASE_SERVICE_KEY"]}
        truck_meta = requests.get(
            f"{base}/rest/v1/trucks?id=eq.{session['truck_id']}&select=truck_code,plate_number",
            headers=rg, timeout=15,
        ).json() or [{}]
        driver_meta = requests.get(
            f"{base}/rest/v1/drivers?id=eq.{session['driver_id']}&select=full_name",
            headers=rg, timeout=15,
        ).json() or [{}]
        tk_code = truck_meta[0].get("truck_code")
        tk_plate = truck_meta[0].get("plate_number")
        drv_name = driver_meta[0].get("full_name")

        # Build trip_summary (no RPC dependency -- we already know the canonical distance)
        anomaly_count = sum(1 for r in rows if r["anomaly_flag"])
        tsum = {
            "trip_id": session["id"], "truck_id": session["truck_id"], "driver_id": session["driver_id"],
            "truck_code": tk_code, "plate_number": tk_plate, "driver_name": drv_name,
            "trip_status": "ended", "start_time": session["start_time"], "end_time": session["end_time"],
            "total_distance_km": session["distance_km"], "total_operating_hours": session["operating_hours"],
            "total_anomalies": anomaly_count, "total_alerts": 0,
            "log_count": len(rows),
            "average_fuel_level": round(sum(r["fuel_level"] for r in rows) / len(rows), 2),
            "start_fuel_level": rows[0]["fuel_level"], "final_fuel_level": rows[-1]["fuel_level"],
        }
        rh = {**headers, "Prefer": "resolution=merge-duplicates"}
        requests.post(f"{base}/rest/v1/trip_summaries", headers=rh, json=[tsum], timeout=30)

        start_dt = dt.datetime.fromisoformat(session["start_time"].replace("Z", "+00:00"))
        end_dt   = dt.datetime.fromisoformat(session["end_time"].replace("Z", "+00:00"))
        dur_s    = (end_dt - start_dt).total_seconds()
        events = [{
            "trip_id": session["id"], "truck_id": session["truck_id"], "driver_id": session["driver_id"],
            "event_type": "trip_started", "timestamp": session["start_time"],
        }]
        if dur_s > 5400:  # >90 min -> include a rest break
            mid_rest  = (start_dt + dt.timedelta(seconds=dur_s / 2)).isoformat().replace("+00:00", "Z")
            mid_resume = (start_dt + dt.timedelta(seconds=dur_s / 2 + 300)).isoformat().replace("+00:00", "Z")
            events.append({"trip_id": session["id"], "truck_id": session["truck_id"], "driver_id": session["driver_id"],
                           "event_type": "rest_started", "timestamp": mid_rest})
            events.append({"trip_id": session["id"], "truck_id": session["truck_id"], "driver_id": session["driver_id"],
                           "event_type": "trip_resumed", "timestamp": mid_resume})
        events.append({"trip_id": session["id"], "truck_id": session["truck_id"], "driver_id": session["driver_id"],
                       "event_type": "trip_ended", "timestamp": session["end_time"]})
        requests.post(f"{base}/rest/v1/trip_events", headers=headers, json=events, timeout=30)

    Path(BASE_DIR / "reports" / "simulated_trips_manifest.json").write_text(
        json.dumps(summary, indent=2, default=str), encoding="utf-8"
    )
    print(f"\nManifest: {BASE_DIR / 'reports' / 'simulated_trips_manifest.json'}")


def _cli() -> None:
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    inject_all(dry_run=args.dry_run)


if __name__ == "__main__":
    _cli()
