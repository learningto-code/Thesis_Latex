# Defense Summary and Demo Checklist

## One-Page Defense Summary

**Problem:** Philippine logistics fleets need a practical way to monitor fuel use, vehicle location, driver activity, and possible fuel anomalies without relying only on manual inspection or after-the-fact records.

**Why machine learning is needed:** Traffic congestion, idling, load variation, route delays, slopes, refueling behavior, and stop-and-go driving can make normal fuel use look abnormal under fixed thresholds. The study uses context-aware features so the detector can compare fuel behavior against speed, RPM, engine load, throttle, idling, distance, route behavior, and per-vehicle/per-driver fuel-economy baselines.

**System:** The prototype integrates OBD-II fuel and vehicle context, GPS, an embedded in-vehicle HMI, a mobile driver web application, an administrative dashboard, backend storage, alert logic, prioritized telemetry transmission, and ML-based anomaly detection.

**Best results:** SO1 achieved 1.04% MAPE against known-volume pump-gas validation; SO4 achieved 92.9% precision and 1.09% FPR using Isolation Forest Model C under leave-one-trip-out evaluation; SO5 achieved a SUS score of 81.9 with 100 generated alerts and a 95% resolution rate.

**Main limitation:** Direct dipstick/tank-volume calibration was not permitted, and confirmed real-world theft/leak events were limited, so longer SGSA fleet deployment is needed before production-scale generalization.

**Contribution:** The work is an integrated end-to-end prototype, not only an ML model. It connects embedded telemetry, communication fallback, backend synchronization, driver/operator interfaces, contextual anomaly detection, and operational alert handling.

## Prototype Demo Checklist

- [ ] Power on HMI.
- [ ] Log in as driver.
- [ ] Select truck.
- [ ] Start trip.
- [ ] Show dashboard active truck.
- [ ] Show mobile app sync.
- [ ] Show GPS/log update.
- [ ] Press Rest on HMI.
- [ ] Show dashboard/mobile rest state.
- [ ] Press Resume.
- [ ] Trigger or show sample fuel anomaly alert.
- [ ] End trip.
- [ ] Show trip history/logs.

