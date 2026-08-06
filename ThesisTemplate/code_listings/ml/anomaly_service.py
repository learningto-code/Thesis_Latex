"""Flask microservice wrapper around the thesis ML inference helpers."""

from __future__ import annotations

import os
from pathlib import Path

from flask import Flask, jsonify, request

from infer import (
    IFOREST_MODEL_A_PATH,
    IFOREST_MODEL_B_PATH,
    IFOREST_MODEL_C_PATH,
    IFOREST_PATH,
    MP_PATH,
    load_iforest_bundle,
    load_iforest_variant,
    load_mp_detector,
    run_combined_inference,
    run_iforest_inference,
)
from preprocess import MODEL_VARIANT_NAMES


app = Flask(__name__)
iforest_bundle = None      # default (best variant) used for inference
iforest_variants: dict = {}  # {"A": bundle, "B": bundle, "C": bundle}
mp_detector = None


@app.route("/", methods=["GET"])
def root() -> tuple:
    """Render-friendly landing page so a GET / does not 404 the health check."""
    return jsonify({"service": "fleet-monitor-ml", "status": "ok", "health": "/health", "detect": "/detect"})


def load_models() -> None:
    global iforest_bundle, iforest_variants, mp_detector

    requested = [v.strip().upper() for v in os.environ.get("ML_LOAD_VARIANTS", "B").split(",") if v.strip()]
    if not requested:
        requested = ["B"]
    print(f"[ml] Loading variants: {requested}", flush=True)

    # Load per-variant bundles
    for variant in requested:
        try:
            b = load_iforest_variant(variant)
            iforest_variants[variant] = b
            feat_count = len(b.get("features", []))
            print(f"[ml] Model {variant} ({MODEL_VARIANT_NAMES.get(variant, variant)}) loaded -- {feat_count} features", flush=True)
        except Exception as e:
            print(f"[ml] WARNING: Model {variant} not loaded -- {e}", flush=True)

    # (reports/thesis_defense_summary.json), Model B has the highest ROC-AUC
    # (0.936) and precision among models with full recall, so it is the
    # live GPS-OBD divergence data validates its distance-fusion features.
    for preferred in ("B", "C", "A"):
        if preferred in iforest_variants:
            iforest_bundle = iforest_variants[preferred]
            print(f"[ml] Default inference model = Model {preferred}", flush=True)
            break

    if iforest_bundle is None:
        try:
            iforest_bundle = load_iforest_bundle()
            print(f"[ml] IsolationForest loaded from {IFOREST_PATH}", flush=True)
        except Exception as e:
            print(f"[ml] WARNING: IsolationForest not loaded -- {e}", flush=True)

    try:
        mp_detector = load_mp_detector()
        print(f"[ml] MatrixProfile loaded from {MP_PATH}", flush=True)
    except Exception as e:
        print(f"[ml] WARNING: MatrixProfile not loaded -- {e}", flush=True)


def _variant_status(variant: str) -> dict:
    paths = {"A": IFOREST_MODEL_A_PATH, "B": IFOREST_MODEL_B_PATH, "C": IFOREST_MODEL_C_PATH}
    b = iforest_variants.get(variant)
    loaded = b is not None
    return {
        "loaded": loaded,
        "file_exists": paths[variant].exists(),
        "feature_count": len(b.get("features", [])) if loaded else 0,
        "score_threshold": round(float(b.get("score_threshold", 0.0)), 6) if loaded else None,
        "label": MODEL_VARIANT_NAMES.get(variant, variant),
    }


@app.route("/health", methods=["GET"])
def health() -> tuple:
    active_variant = None
    active_feature_count = 0
    if iforest_bundle is not None:
        active_variant = iforest_bundle.get("model_variant", "unknown")
        active_feature_count = len(iforest_bundle.get("features", []))

    return jsonify(
        {
            "status": "ok",
            "iforest_loaded": iforest_bundle is not None,
            "matrix_profile_loaded": mp_detector is not None,
            "active_model_variant": active_variant,
            "active_model_variant_label": MODEL_VARIANT_NAMES.get(active_variant, active_variant) if active_variant else None,
            "active_feature_count": active_feature_count,
            "model_variants": {v: _variant_status(v) for v in ("A", "B", "C")},
            "models": ["IsolationForest", "MatrixProfile"],
            "artifacts": {
                "iforest_default": str(IFOREST_PATH),
                "iforest_model_a": str(IFOREST_MODEL_A_PATH),
                "iforest_model_b": str(IFOREST_MODEL_B_PATH),
                "iforest_model_c": str(IFOREST_MODEL_C_PATH),
                "matrix_profile": str(MP_PATH),
            },
        }
    )


@app.route("/detect", methods=["POST"])
def detect() -> tuple:
    if iforest_bundle is None:
        return jsonify({
            "is_anomaly": False,
            "model_source": "none",
            "combined_score": 0.0,
            "details": "ML model not loaded -- check server logs",
            "if_result": {"anomaly_flag": False, "anomaly_score": 0.0},
            "mp_result": None,
        }), 503

    try:
        body = request.get_json(force=True) or {}
        combined = run_combined_inference(
            body,
            fuel_series=body.get("fuel_series"),
            iforest_bundle=iforest_bundle,
            mp_detector=mp_detector,
        )

        details = []
        if combined["if_result"]["anomaly_flag"]:
            details.append(f"IF score={combined['if_result']['anomaly_score']:.3f}")
        if combined["mp_result"] and combined["mp_result"]["anomaly_flag"]:
            details.append(combined["mp_result"].get("reason", "MP discord detected"))

        return jsonify(
            {
                "is_anomaly": combined["anomaly_flag"],
                "model_source": combined["model_source"],
                "combined_score": combined["anomaly_score"],
                "details": " | ".join(details) if details else "No anomaly",
                "if_result": combined["if_result"],
                "mp_result": combined["mp_result"],
            }
        )
    except Exception as exc:  # noqa: BLE001
        import traceback, sys
        traceback.print_exc(file=sys.stderr)
        return jsonify({"is_anomaly": False, "error": str(exc), "details": "inference error"}), 500


@app.route("/detect/batch", methods=["POST"])
def detect_batch() -> tuple:
    if iforest_bundle is None:
        return jsonify({"error": "ML model not loaded", "results": []}), 503

    try:
        body = request.get_json(force=True) or {}
        rows = body.get("rows", [])
        if not rows:
            return jsonify({"error": "No rows provided"}), 400
        return jsonify({"results": [run_iforest_inference(row, bundle=iforest_bundle) for row in rows]})
    except Exception as exc:  # noqa: BLE001
        import traceback, sys
        traceback.print_exc(file=sys.stderr)
        return jsonify({"error": str(exc)}), 500


# Load models at import time so gunicorn workers (Render production) have
# ensures this only runs once per dyno, not per worker.
load_models()


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="0.0.0.0", port=port, debug=False)
