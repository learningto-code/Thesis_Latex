# Diagram Revision Brief — Post-Defense Panel Comments

Author: Sam · Date: 2026-07-15 · For: thesis groupmates

The panel raised two diagram-specific revisions (comments #1 and #3 on the
revisions form). Both are re-drawings. LaTeX prose + figure blocks are already
in place in `methodology.tex` pointing at placeholder images; once you produce
the finished PNGs with the filenames listed below and drop them into
`ThesisTemplate/figure/`, everything compiles.

Target file format: **PNG, ≥ 1600 px wide, 200+ DPI, transparent-or-white bg**.
Preferred tool: **draw.io / diagrams.net** (save the `.drawio` source next to
the PNG in `docs/defense/`). Font: Inter or Roboto, size ≥ 12 pt so it stays
legible when scaled to the LaTeX text width.

---

## Diagram A — Channel Transition State Machine (Revision #1)

**Panel comment:** *"Describe the process by which the system determines
transitions among LoRa, LTE, GPRS, WiFi, and offline modes."*

**Output filename:** `Fig_5_10_Channel_State_Machine.png`
(replaces the placeholder `example_gray_box.pdf` currently referenced by
`\label{fig:channel_state_machine}` in `methodology.tex`).

**Type:** finite-state / directed-graph diagram — one node per channel, one
edge per transition trigger. **Not** a fall-through flowchart (that already
exists as Figure 5.9, Offline-Buffer Fall-Through Flowchart — do not
duplicate it).

### States (nodes)

Draw five states in this order, left-to-right, following the priority chain:

1. **LoRa (SX1278)** — highest priority
2. **LTE (A7670E)** — cellular preferred
3. **GSM 2G (A7670E)** — cellular fallback
4. **WiFi (ESP32)** — depot / hotspot
5. **Offline (SPIFFS `/tel_buf.log`)** — buffered

Use a distinct fill colour per state; keep the palette light. Add a small
subtitle under each node with the underlying hardware (as in parentheses
above) so the reader can map states to the hardware block diagram.

### Transitions (directed edges)

Each edge is labelled with the **event** that fires it. Use the exact source
in `embedded/hmi_phase1/src/main.cpp` as the source of truth. The events are:

| From → To | Trigger event | Source-of-truth |
|-----------|---------------|-----------------|
| LoRa → LTE | LoRa ACK timeout (2000 ms) OR `LORA_MAX_RETRIES` (1) exceeded | `LORA_ACK_TIMEOUT_MS`, `LORA_MAX_RETRIES` |
| LTE → GSM 2G | Modem reports `RAT_GSM_2G` after `CGATT` / `CGACT` renegotiation | `detectGsmRat()`, `gsmActiveRat` |
| GSM 2G → WiFi | Two consecutive HTTPS `POST /telemetry` failures on cellular | `CH_GSM_NO_SERVER` state |
| WiFi → Offline | `WiFi.status() != WL_CONNECTED` **and** all cellular attempts failed | `bufferTelemetry()` call site |
| Offline → any (recovery) | Any live channel returns HTTP 2xx during retry, replay via `flushTelemetryBuffer()` at `MAX_FLUSH_PER_CALL = 5 records/tick` | `flushTelemetryBuffer()` |
| LoRa (return) | `loraGatewayRecentlyOk()` — gateway ACK within last 90 s clears backoff | `lastLoraOkMs`, `loraGatewayBackoffActive()` |
| GSM/LTE (return) | `AT+CSQ` ≥ 10 **and** `AT+CGACT?` PDP context active | `gsmReconnect()` |

Show recovery edges as **dashed arrows** to distinguish them from failure
edges (solid). Every state must have at least one outgoing edge to the next
priority level *and* a dashed recovery edge back from the offline state
(illustrating that any channel can resume from buffered mode).

### Annotations

Add three small callout boxes anchored to the diagram (not floating text):

- **Callout 1** next to LoRa: *"Retry budget: 1 attempt, 2 s ACK window."*
- **Callout 2** next to Offline: *"Buffer file: `/tel_buf.log`, ~300 B/record,
  ~1 MB SPIFFS partition ⇒ ≈ 3 500 records ≈ 4.9 h at 5 s cadence. 32 KB
  low-space cutoff drops new records to protect the FS."*
- **Callout 3** spanning the diagram bottom: *"Every attempt reuses the same
  `seq` and `event_id` — replayed records are tagged
  `channel_used='offline_replay'` at the backend so deduplication is safe."*

### Deliverables

- `Fig_5_10_Channel_State_Machine.png` in `ThesisTemplate/figure/`
- `Fig_5_10_Channel_State_Machine.drawio` in `docs/defense/`
- A light-background variant `Fig_5_10_Channel_State_Machine_light.png` if
  the base file is dark-themed (match the pattern of `Fig_5_11_..._light.png`).

---

## Diagram B — ML Pipeline Redraw (Revision #3)

**Panel comment:** *"Revise the diagram (Figure 5.1) with corrected arrows,
greater detail, and a general representation in place of Python."*

**⚠️ Ambiguity to resolve first:** the panel wrote *"Figure 5.1"* but the
current LaTeX numbering has:

- **Figure 5.1** = `concep_diagram.png` (Conceptual Framework — no Python content)
- **Figure 5.11** = `Fig_5_11_Anomaly_Pipeline_light.png` (ML pipeline — has Python/library icons)
- Sub-figure inside 5.11 group = `thesis_defense_pipeline_v2.png` (also ML pipeline)

The "in place of Python" cue points at **Figure 5.11** (or its companion
`thesis_defense_pipeline_v2.png`). Confirm with the panel chair before
starting; assume 5.11 by default.

**Output filename:** `Fig_5_11_Anomaly_Pipeline_v3.png` (keeps the naming
convention; just bump the version suffix). Add a `_light.png` variant too.

### What to fix

The three panel asks map to concrete changes:

1. **"Corrected arrows."** The current diagram has ambiguous edge directions
   between the primary inference plane and the audit/override inference
   plane. Redraw so every arrow has a single direction and a labelled event:
   - IF pass → contextual gate (label: `if_score ≥ τ + δ`)
   - MP override → contextual gate (label: `mp_score ≥ 4.0 ∧ Δfuel < 0` OR
     `mp_score ≥ 2.0 ∧ Δfuel ≤ −2.0`)
   - Contextual gate → persistence (label: `pass`)
   - Contextual gate → audit-only sink (label: `suppressed`)
   - Persistence → alerts table (label: `combined_score > 0.65 ∧ dedup ok`)

2. **"Greater detail."** Add the four suppressors as labelled boxes inside
   the contextual gate (they are currently collapsed into one box):
   - `parkedRefuel`
   - `postRefuel`
   - `loadSpikeSuppress`
   - `coldStartSuppress`
   Each with a one-line trigger under the label.

3. **"General representation in place of Python."** Remove any of these that
   appear in the current PNG and replace with **generic algorithm names**:

   | Remove (Python-specific) | Replace with (general) |
   |--------------------------|------------------------|
   | `sklearn.IsolationForest` | *Isolation Forest (one-class ensemble)* |
   | `stumpy.matrix_profile` | *Matrix Profile (subsequence discord)* |
   | `pandas.DataFrame` / `numpy.ndarray` icons | *Feature-vector row (33 dim)* |
   | `pickle` model file icon | *Serialised model artefact* |
   | any Python code snippet, `sklearn`/`stumpy`/`numpy` logos, snake icons | plain algorithm names + arrows |

   Also drop any file-extension hints like `.pkl`, `.py`, `.csv` in favour
   of the conceptual data name (e.g. *"trained model"*, *"feature row"*).

### Deliverables

- `Fig_5_11_Anomaly_Pipeline_v3.png` and `_light.png` in
  `ThesisTemplate/figure/`.
- `Fig_5_11_Anomaly_Pipeline_v3.drawio` in `docs/defense/`.
- Confirm the LaTeX `\includegraphics{...}` in `methodology.tex` around
  line 1071 points at the new filename (Sam will handle the swap once the
  PNG lands).

---

## Once your PNGs are dropped in `ThesisTemplate/figure/`

Ping Sam. He will:

1. Swap the placeholder `example_gray_box.pdf` reference to your PNG in
   `methodology.tex` (both figures).
2. Re-flow the caption / paragraph to match the final visual (the
   placeholder captions and surrounding prose are already written but may
   need one-line edits once we see the actual layout).
3. Rebuild the PDF and verify figure numbering renumbered correctly (Fig
   5.10 is inserted between the existing 5.9 and 5.11, so cross-references
   downstream might shift by one).

Reach out on Messenger if any transition trigger in the state-machine table
is unclear — the firmware source is the authority, but the phrasing above
should be enough to draw the diagram without reading C++.
