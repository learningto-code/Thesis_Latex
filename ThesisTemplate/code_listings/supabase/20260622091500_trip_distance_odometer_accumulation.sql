-- Lifetime mileage accumulation from finalized trip distance.
-- The Toyota Hilux fleet used in the prototype exposes dashboard mileage to
-- trip_sessions.distance_km as the source of truth and accumulates it into
-- trucks.current_odometer_km exactly once per ended trip.

ALTER TABLE trip_sessions
  ADD COLUMN IF NOT EXISTS odometer_accumulated_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.accumulate_trip_distance_odometer(p_trip_id uuid)
RETURNS TABLE (
  trip_id uuid,
  truck_id uuid,
  distance_km double precision,
  current_odometer_km double precision,
  accumulated boolean
)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_trip trip_sessions%ROWTYPE;
  v_next_odo double precision;
BEGIN
  SELECT *
  INTO v_trip
  FROM trip_sessions
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_trip.trip_status <> 'ended'
     OR COALESCE(v_trip.distance_km, 0) <= 0
     OR v_trip.odometer_accumulated_at IS NOT NULL THEN
    RETURN QUERY
      SELECT
        v_trip.id,
        v_trip.truck_id,
        COALESCE(v_trip.distance_km, 0)::double precision,
        t.current_odometer_km,
        false
      FROM trucks t
      WHERE t.id = v_trip.truck_id;
    RETURN;
  END IF;

  UPDATE trucks t
  SET
    current_odometer_km = ROUND((COALESCE(t.current_odometer_km, 0) + v_trip.distance_km)::numeric, 1)::double precision,
    last_maintenance_odometer_km = CASE
      WHEN t.last_maintenance_odometer_km IS NULL
      THEN ROUND((COALESCE(t.current_odometer_km, 0) + v_trip.distance_km)::numeric, 1)::double precision
      ELSE t.last_maintenance_odometer_km
    END
  WHERE t.id = v_trip.truck_id
  RETURNING t.current_odometer_km INTO v_next_odo;

  UPDATE trip_sessions
  SET odometer_accumulated_at = NOW()
  WHERE id = v_trip.id;

  RETURN QUERY
    SELECT
      v_trip.id,
      v_trip.truck_id,
      v_trip.distance_km::double precision,
      v_next_odo,
      true;
END;
$function$;

-- is marked with odometer_accumulated_at before the migration completes.
WITH pending AS (
  SELECT truck_id, SUM(distance_km) AS distance_km
  FROM trip_sessions
  WHERE trip_status = 'ended'
    AND COALESCE(distance_km, 0) > 0
    AND odometer_accumulated_at IS NULL
  GROUP BY truck_id
)
UPDATE trucks t
SET
  current_odometer_km = ROUND((COALESCE(t.current_odometer_km, 0) + pending.distance_km)::numeric, 1)::double precision,
  last_maintenance_odometer_km = CASE
    WHEN t.last_maintenance_odometer_km IS NULL
    THEN ROUND((COALESCE(t.current_odometer_km, 0) + pending.distance_km)::numeric, 1)::double precision
    ELSE t.last_maintenance_odometer_km
  END
FROM pending
WHERE t.id = pending.truck_id;

UPDATE trip_sessions
SET odometer_accumulated_at = NOW()
WHERE trip_status = 'ended'
  AND COALESCE(distance_km, 0) > 0
  AND odometer_accumulated_at IS NULL;
