-- and anomaly_score (double); the class label was inferred at evaluation time
-- which made multi-class metrics impossible to compute from the live snapshot.
ALTER TABLE telemetry_logs
  ADD COLUMN IF NOT EXISTS anomaly_type text;

CREATE INDEX IF NOT EXISTS idx_telemetry_logs_anomaly_type
  ON telemetry_logs(anomaly_type)
  WHERE anomaly_type IS NOT NULL;
