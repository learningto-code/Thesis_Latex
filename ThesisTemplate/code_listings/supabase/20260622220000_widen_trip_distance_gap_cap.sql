-- batches from inflating trip distance, but on live cellular drives the
-- A7670E's HTTPDATA stalls and PDP reconnect cycles routinely produce
-- 1.5-3 minute gaps between successive telemetry rows even while the
-- Per-segment safeguards (so widening the cap can't inflate distance):
--   * GPS branch (haversine):    LEAST(hav_km, 0.6) -> max 0.6 km / segment
--   * Speed branch (existing):   LEAST(speed, 200) * delta_s / 3600
--     explicit LEAST per segment so the speed branch can't run away.

CREATE OR REPLACE FUNCTION public.compute_trip_distance_km(p_trip_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
WITH ordered AS (
  SELECT
    GREATEST(speed::NUMERIC, 0) AS speed,
    lat, lon,
    COALESCE(sent_at, timestamp) AS t
  FROM telemetry_logs
  WHERE trip_id = p_trip_id
  ORDER BY COALESCE(sent_at, timestamp) ASC NULLS LAST, timestamp ASC
),
pairs AS (
  SELECT
    speed,
    lat, lon,
    t,
    LEAD(lat) OVER (ORDER BY t) AS next_lat,
    LEAD(lon) OVER (ORDER BY t) AS next_lon,
    EXTRACT(EPOCH FROM (LEAD(t) OVER (ORDER BY t) - t)) AS delta_s
  FROM ordered
),
speed_seg AS (
  -- Cap each segment at the lesser of:
  --     vehicle was offline; trust the next live row's odometer or GPS)
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
  -- Only count GPS segments that look like real movement:
  --   * haversine >= 10 m (0.01 km) suppresses stationary GPS jitter
  --     that averages ~5 m on consumer GPS, OR
  --     GPS round-trip happened to round down to a small delta)
  -- real-world cellular gaps without losing legitimate driving distance).
  SELECT SUM(LEAST(hav_km, 0.6)) AS km
  FROM gps_pairs
  WHERE hav_km IS NOT NULL
    AND delta_s > 0 AND delta_s <= 300
    AND (hav_km >= 0.01 OR speed >= 2)
)
SELECT ROUND(GREATEST(
  COALESCE((SELECT km FROM speed_seg), 0),
  COALESCE((SELECT km FROM gps_seg),   0)
)::NUMERIC, 2);
$function$;

-- Recompute all ended trips so historical distance reflects the new RPC.
-- We never directly persisted distance_km until /trip/end calls
-- finalizeTripDistanceAndMileage, so we have to UPDATE explicitly.
UPDATE trip_sessions t
SET distance_km = public.compute_trip_distance_km(t.id)
WHERE trip_status = 'ended';

-- reset and rebuild from scratch using the new distances.
UPDATE trucks SET current_odometer_km = 0
WHERE id IN (SELECT DISTINCT truck_id FROM trip_sessions WHERE odometer_accumulated_at IS NOT NULL);

UPDATE trucks t
SET current_odometer_km = (
  SELECT COALESCE(SUM(distance_km), 0)
  FROM trip_sessions
  WHERE truck_id = t.id
    AND trip_status = 'ended'
    AND COALESCE(distance_km, 0) > 0
)
WHERE id IN (SELECT DISTINCT truck_id FROM trip_sessions WHERE odometer_accumulated_at IS NOT NULL);
