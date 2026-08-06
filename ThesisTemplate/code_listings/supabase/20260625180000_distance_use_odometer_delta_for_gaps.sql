-- the device's onboard speed-integrated trip distance instead of being
-- silently dropped at the 300 s per-segment time cap.
-- km of real driving (trip stored as 65.6 km, actual ~93 km).
-- delta_s to guard against runaway accumulation if odometer_km was published
-- the more conservative speed/GPS branches when they happen to be larger.

CREATE OR REPLACE FUNCTION public.compute_trip_distance_km(p_trip_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
WITH ordered AS (
  SELECT
    GREATEST(speed::NUMERIC, 0) AS speed,
    lat, lon, odometer_km,
    COALESCE(sent_at, timestamp) AS t
  FROM telemetry_logs
  WHERE trip_id = p_trip_id
  ORDER BY COALESCE(sent_at, timestamp) ASC NULLS LAST, timestamp ASC
),
pairs AS (
  SELECT
    speed,
    LEAD(speed) OVER (ORDER BY t) AS next_speed,
    lat, lon, odometer_km,
    LEAD(odometer_km) OVER (ORDER BY t) AS next_odo,
    t,
    LEAD(lat) OVER (ORDER BY t) AS next_lat,
    LEAD(lon) OVER (ORDER BY t) AS next_lon,
    EXTRACT(EPOCH FROM (LEAD(t) OVER (ORDER BY t) - t)) AS delta_s
  FROM ordered
),
speed_seg AS (
  SELECT SUM(
    CASE
      WHEN delta_s > 0 AND delta_s <= 300 AND speed >= 0
      THEN LEAST(LEAST(speed, 200) * delta_s / 3600.0, 5.0)
      ELSE 0
    END
  ) AS km
  FROM pairs
  WHERE speed IS NOT NULL
),
gps_pairs AS (
  SELECT
    speed,
    COALESCE(next_speed, speed) AS next_speed,
    delta_s,
    CASE
      WHEN lat IS NULL OR lon IS NULL OR next_lat IS NULL OR next_lon IS NULL THEN NULL
      WHEN ABS(lat) < 0.000001 AND ABS(lon) < 0.000001 THEN NULL
      WHEN ABS(next_lat) < 0.000001 AND ABS(next_lon) < 0.000001 THEN NULL
      ELSE 12742.0 * ASIN(SQRT(
        POWER(SIN(RADIANS((next_lat - lat) / 2.0)), 2) +
        COS(RADIANS(lat)) * COS(RADIANS(next_lat)) *
        POWER(SIN(RADIANS((next_lon - lon) / 2.0)), 2)
      ))
    END AS hav_km
  FROM pairs
),
gps_seg AS (
  SELECT SUM(
    LEAST(
      hav_km,
      GREATEST(
        LEAST(GREATEST(speed, next_speed, 5)::NUMERIC, 200) * delta_s / 3600.0 * 1.3,
        0.05
      )
    )
  ) AS km
  FROM gps_pairs
  WHERE hav_km IS NOT NULL
    AND delta_s > 0 AND delta_s <= 300
    AND (hav_km >= 0.01 OR speed >= 2 OR next_speed >= 2)
),
-- Odometer-delta branch: uses the HMI's onboard speed-integrated trip
-- distance (odometer_km) to fill long gaps the time-capped branches drop.
-- the GPS branch, so the LoRa/buffered gap isn't credited beyond physical
-- plausibility even if odometer_km has a stale read.
odo_seg AS (
  SELECT SUM(
    CASE
      WHEN odometer_km IS NULL OR next_odo IS NULL THEN 0
      WHEN next_odo <= odometer_km THEN 0   -- non-monotonic / reset = ignore
      WHEN delta_s IS NULL OR delta_s <= 0 THEN 0
      ELSE LEAST(
        (next_odo - odometer_km)::NUMERIC,
        GREATEST(LEAST(GREATEST(speed, next_speed, 5)::NUMERIC, 200) * delta_s / 3600.0 * 1.3, 0.05)
      )
    END
  ) AS km
  FROM pairs
)
SELECT ROUND(GREATEST(
  COALESCE((SELECT km FROM speed_seg), 0),
  COALESCE((SELECT km FROM gps_seg),   0),
  COALESCE((SELECT km FROM odo_seg),   0)
)::NUMERIC, 2);
$function$;

-- Recompute the affected ended trip so the dashboard catches up.
UPDATE trip_sessions
   SET distance_km = public.compute_trip_distance_km(id)
 WHERE trip_status = 'ended';
