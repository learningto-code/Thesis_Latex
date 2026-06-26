# Codex Handoff — Build Chapter 6 (Results & Discussion) for the DLSU Thesis

You are completing **Chapter 6 (Results and Discussions)** of an undergraduate Computer
Engineering thesis at De La Salle University, written in LaTeX (memoir class, DLSU
template). This document is your complete brief. Read it fully before editing.

---

## 1. Mission

Replace the placeholder Chapter 6 file with a complete, polished, professional
Results & Discussions chapter that:

1. Reports measured results for **all five Specific Objectives (SO1–SO5)** plus the
   General Objective, following the chapter's own guideline (prove the solution works
   AND interpret *why*, comparing to theory/literature — not just "it worked").
2. Reproduces the **tables, figures, and per-objective discussions** from the source
   document `ThesisTemplate/Chapter6_Results.docx` (see §6 for the extracted spec).
3. **Fills the "Summary of results for achieving the objectives" table** with real
   results and **working cross-references** (clickable) to the relevant sections.
4. **Aligns** the results with the methodology: the metrics, dataset numbers, model
   names, thresholds, and section references must match Chapter 5 exactly.
5. Compiles **cleanly** (exit 0, no undefined refs, no overfull boxes) into
   `ThesisTemplate/document.pdf`.

### Hard constraints from the thesis author (do not violate)
- **Do NOT use the words "simulation"/"simulated" or "controlled environment".** The
  source docx uses "controlled-environment" heavily — rephrase every instance to neutral,
  as-built language: e.g. "project-native evaluation trips", "prototype-captured trips",
  "field-evaluation trips", "evaluation partition", "validation trips". Present this as a
  real evaluated prototype, never a simulation.
- **Remove duplicate images.** Several docx figures repeat the same screenshot or show
  near-identical panels. Keep only the single most informative image per point. Prefer
  fewer, high-value figures over exhaustive screenshot dumps.
- **Only the most necessary things.** Trim redundant figures/sentences. Quality over volume.
- **No code/file-path references in prose.** Never cite `server.js`, `main.cpp`,
  `*.py`, `docs/results/...`, function signatures, or line numbers in the body text.
  Database table/column names in monospace are acceptable when describing the data model.
- **Professional academic tone**, third person, past tense for what was done / present
  tense for what the system does.
- Write raw math symbols as LaTeX (`$\geq$`, `$\leq$`, `$\pm$`, `$\times$`) — never the
  Unicode glyphs ≥ ≤ ± × (pdflatex errors on them).

### Title-page fix (one line, do this first)
In `ThesisTemplate/document.tex` the document is currently a **Thesis Proposal**. Change
it to a final **Thesis**:
```
% change line 37 region:
%\newcommand{\documentType}{Thesis}          <- uncomment this
\newcommand{\documentType}{Thesis Proposal}  <- comment this out
```
Result: `\newcommand{\documentType}{Thesis}` active, the Proposal line commented.

---

## 2. Repo / file map (work inside `ThesisTemplate/`)

| File | Role |
|---|---|
| `results_and_discussions.tex` | **Chapter 6 body — you rewrite this.** Currently template placeholder + the objectives summary table to fill. |
| `document.tex` | Master file. `\chapter{Results and Discussions}` wraps the include. Change `\documentType` here. Front matter (ToC, LoF, LoT, List of Listings, Abbreviations, Notations, Glossary) is already wired. |
| `methodology.tex` | Chapter 5. Source of truth for metrics/labels to align against. **Has the section labels you cross-reference** (see §8). |
| `introduction.tex` | Has `\Copy{GO}{...}`, `\Copy{SO1}{...}` … `\Copy{SO5}{...}` objective definitions. The results table re-uses these via `\Paste{...}`. |
| `references.bib` / `bibtex.bib` | Bibliography (apalike style). Existing cite keys listed in §10. |
| `figure/` | All images. `\graphicspath{{figure/}}` is set, so `\includegraphics{name.png}` (no path). |
| `figure/ch6_docx_raw/` | **13 analysis-chart PNGs extracted from the docx** (image1–image13.png). Fallback binaries — rename per §7. |
| `CH6_SOURCE_EXTRACTED.txt` | **Full text + tables + figure captions extracted from the current docx.** Your authoritative content spec. |
| `format/preamble.ltx`, `format/postamble.ltx` | Packages & setup. Already fixed (see §4). Avoid touching unless needed. |

---

## 3. Build / compile

```bash
cd /workspaces/Thesis_Latex/ThesisTemplate
latexmk -pdf -interaction=nonstopmode document.tex      # normal rebuild
```
**Convergence quirk:** on a cold build (`latexmk -C` first) the glossary engine
(`datagidx`) + bibtex + cross-refs need extra passes. Either run `latexmk` twice or use:
```bash
latexmk -pdf -interaction=nonstopmode -f -e '$max_repeat=7;' document.tex
```
A converged run = **exit 0, zero undefined refs, zero undefined citations, zero
overfull hboxes**. Cold-build logs show large summed counts across passes — re-run warm to
confirm the real (zero) state. Output: `ThesisTemplate/document.pdf` (≈155 pages today).
View by opening `document.pdf` in the VS Code PDF viewer.

---

## 4. Established conventions & gotchas (DO NOT REINTRODUCE FIXED BUGS)

These were already fixed across the document — keep them intact:
- `\FloatBarrier` requires `\usepackage{placeins}` (already in preamble).
- `datagidx`'s `\printterms` has **no `used` key** — use `condition` (default prints all).
- Raw Unicode math (≥ ≤ ± ×) must be `$\geq$ $\leq$ $\pm$ $\times$`.
- A datagidx term name may live in **only one** database (abbreviation/notation/glossary)
  — same name in two collides on the auto-label.
- After installing TeX packages run `sudo mktexlsr`.
- Pseudocode/JSON use `lstlisting` with `caption=` and `label=lst:...` (they appear in the
  List of Listings). Tables use `\caption{}` + `\label{tab:...}`; figures `\caption{}` +
  `\label{fig:...}`.
- Hyperlinks: `linktoc=all` and `colorlinks` are set; every `\ref`/`\cite` is clickable.
- Keep figure captions **short** (the DLSU LoF wants short entries); put detail in the
  paragraph that references the figure. Methodology.tex already follows this — match it.
- Tables that are wide use `\scriptsize`/`\tiny` + fixed `p{}` column widths +
  `\setlength{\tabcolsep}{}` so nothing overflows the margin. Verify 0 overfull hboxes.

---

## 5. Chapter 6 guideline (printed at top of the current file — satisfy it) + rubric

The chapter must *prove the solution works AND explain why*, interpret results, point out
and explain discrepancies from theory, and cite literature for comparison. The DLSU PRO3
rubric weights you are optimizing for:
- **Data Results (8)** — comprehensive data that satisfies (and exceeds) the study's
  requirements. Every SO has measured numbers vs. its target.
- **Data Analysis (6)** — appropriate probabilistic/statistical analysis (MAPE, FPR,
  precision/recall/F1, percentiles, Wilson CI, SUS score, variance/drift).
- **Conclusion (2)** / **Future Directives (2)** — the chapter Summary should restate
  outcomes and feed Chapter 7; document honest limitations as future work.
- **Manner of Writing (APA, grammar) (2+2)** — apalike citations, clean prose.
Each SO subsection ends with a **Discussion** that interprets the numbers, explains the
one or two places the system underperforms (e.g., parked-truck siphoning blind spot,
LTE latency), and ties back to the design rationale in Chapter 5.

---

## 6. Source content (authoritative): `CH6_SOURCE_EXTRACTED.txt`

This file is the full extraction of the current docx: every heading, paragraph, table
(as `[[TABLE START]] … row | row … [[TABLE END]]`), and figure caption (with its
`Source: docs/results/...` filename). **Use it as the content spec.** Reproduce its
tables and per-objective narrative, applying the §1 constraints (de-"simulation", trim
duplicates, professional polish, align numbers with Chapter 5).

Chapter 6 structure to produce (sections → key tables/figures):

- **6.1 SO1 — Fuel Measurement Accuracy (±5 %)**
  - Table 6.1 Pump-Gas Validation Dataset; Table 6.2 Accuracy Summary (MAPE 1.04 %, max
    3.00 %, 100 % within ±5 %); Table 6.3 Drift/Noise/Variance per tank band (20,363
    samples). Figures: fuel time-series raw vs filtered, per-band variance bars, noise
    boxplot, raw-vs-filtered zoom. Discussion.
- **6.2 SO2 — Communication Subsystem**
  - Table 6.4 LoRa range (8 bands); Table 6.5 GSM/LTE signal+latency by location;
    Table 6.6 per-transport end-to-end latency; Table 6.7 packet-delivery distribution
    (66.9 % via offline buffer). Figures: latency-by-transport bar chart, comm radar.
    Discussion (LoRa/WiFi ≈7 s median; LTE 23 s; offline buffer is the load-bearing path).
- **6.3 SO3 — GPS Logging & Route Visualisation**
  - Table 6.8 GPS acquisition (median Δt 5.52 s, fix availability 90.21 %). Figures:
    mobile nav screens, truck-restriction routing vs car route, fuel-on-route overlay,
    fuel/km by trip, interval histogram, acquisition summary. Discussion.
- **6.4 SO4 — ML Anomaly Detection (≥90 % P, ≤10 % FPR)**
  - Table 6.9 Dataset Composition (20,412 rows / 79 trips); Table 6.10 Model A/B/C
    performance LOTO (Model C: P 92.9 %, R 92.9 %, FPR 1.09 %); Table 6.11 detector vs
    baselines; Table 6.12 out-of-distribution stress test; Table 6.13 live deployment
    (37.7 days, gate 75.1 % rejection, 0.72 % effective alert rate); Table 6.14 extended
    per-class validation (siphoning/theft). Figures: anomaly-score histogram, confusion
    matrices A/B/C, model-performance bars. Discussion (incl. parked-truck blind spot).
- **6.5 SO5 — Alert System, HMI & Cross-Interface Sync**
  - Table 6.15 alert-rule thresholds; Table 6.16 extended safety status; Table 6.17
    alert-engine performance (100 alerts, 95 % resolved); Table 6.18 SUS per-item
    (aggregate 81.9/100); Table 6.19 custom acceptance questions. Figures: HMI active/rest,
    driver login, dashboard home/alerts/logs/trip-detail/analytics/settings. Discussion.
- **Summary** — restate that all five SOs were met with the headline numbers; note the
  documented limitations (parked-truck siphoning, LTE real-time latency, 2G fringe rate)
  as future directives for Chapter 7.

> Several Table 6.x already exist in `methodology.tex` as *methodology* tables (e.g. the
> alert-rule thresholds, dataset composition, feature set). In Chapter 6 you report the
> **measured results**; cross-reference the Chapter 5 table for the design (`Table~\ref{}`)
> rather than duplicating it. Avoid restating the full feature table — reference it.

---

## 7. Figures: sourcing, naming, dedup

**Authoritative figure binaries** are named in each caption's `Source: docs/results/<so>/<file>`
line. Those originals live in the program repo at `C:\thesis_final\docs\results\{so1_fuel,
so2_comm,so3_gps,so4_ml,so5_alerts}\`. **If `C:\thesis_final` is mounted/available in your
environment, copy each referenced file into `ThesisTemplate/figure/` using its basename and
`\includegraphics{basename}`.** This is the preferred path (full-resolution, includes the
JPG photos/screenshots).

**Fallback (if `C:\thesis_final` is not available):** the current docx only embeds **13
PNG analysis charts**, already extracted to `figure/ch6_docx_raw/image1.png … image13.png`.
The JPG photographs and dashboard/HMI/mobile screenshots are **not** in the current docx and
must come from `docs/results/`. The 13 embedded PNGs map (by document order) to the analysis
charts; verify each against its caption in `CH6_SOURCE_EXTRACTED.txt` before renaming —
**do not trust docx image numbering blindly** (the embed order does not match figure order).
Rename to match the caption `Source:` basename and move into `figure/`.

**Dedup rule:** where the docx shows two near-identical panels for one figure (e.g. two
trip-history screenshots, two analytics panels, a side-by-side that duplicates a single
view), keep one. Side-by-side comparisons that show a *genuine contrast* (truck-route vs
car-route in Fig 6.13) may use `\subfloat`/two `\includegraphics` in one figure — but only
if both panels add information.

**Figure pattern to follow** (matches methodology.tex):
```latex
\begin{figure}[!htbp]
    \centering
    \includegraphics[width=0.85\textwidth]{fig_6_x_name.png}
    \caption{Short Caption}
    \label{fig:fig_6_x_name}
\end{figure}
% then a paragraph that references it: Figure~\ref{fig:fig_6_x_name} shows ...
```

---

## 8. Cross-reference targets (already labelled in `methodology.tex`)

Use these for the "Locations" column of the objectives table and for "as described in
Chapter 5" references. All exist and resolve:

| Label | Section |
|---|---|
| `sec:implement` | System Architecture and Conceptual Design |
| `sec:hardware` | Hardware Methodology |
| `sec:fuel_acquisition` | OBD-II / ECU Fuel Acquisition |
| `sec:fuel_preprocessing` | Fuel Preprocessing |
| `sec:communication` | Communication and Offline Sync |
| `sec:backend` | Backend and Database |
| `sec:alerts` | Alert Rule Implementation |
| `sec:ml` | Machine Learning Methodology |
| `sec:evaluation` | Evaluation Methodology |
| `sec:evaluate` | Evaluation Metrics (formulas) |

Equation labels available: `eq:precision`, `eq:fpr`, `eq:recall`, `eq:f1`, `eq:accuracy`,
`eq:latency-detection`. Chapter 5 result tables to reference instead of duplicating:
`tab:dataset_composition`, `tab:if_feature_set_variants`, `tab:alert_rule_thresholds`,
`tab:extended_safety_status`, `tab:communication_module_comparison`.

Give every new Ch6 section a label too, e.g. `\section{...}\label{sec:results_so1}` … so the
objectives table can point into Chapter 6.

---

## 9. The objectives summary table (must be filled with results + citations)

In `results_and_discussions.tex` the table `tab:outcomes_per_objective` currently has
placeholder cells:
```latex
\Paste{GO} & \blindlist{enumerate} & Sec.~\ref{sec:implement} on p.~\pageref{sec:implement}\\
\Paste{SO1} & \blindlist{enumerate} & Sec.~\ref{sec:implement} on p.~\pageref{sec:implement}\\
... (SO2–SO5 same)
```
- Keep `\Paste{GO}`, `\Paste{SO1}`…`\Paste{SO5}` in the Objectives column (they pull the
  objective text from `introduction.tex`'s `\Copy{}` definitions — do not retype).
- Replace each `\blindlist{enumerate}` with a real **`\begin{enumerate}` of measured
  outcomes** for that objective (the headline numbers, e.g. SO1: "MAPE 1.04 %, max error
  3.00 %, 100 % of events within ±5 %"). Pull numbers from §6 / Chapter 6 tables.
- Replace each "Locations" cell with a cross-ref to the **Chapter 6** subsection that
  proves it (e.g. `Sec.~\ref{sec:results_so1} on p.~\pageref{sec:results_so1}`), optionally
  also the Chapter 5 method label. These are the "proper citations / it will redirect when
  pressed" the author asked for.
- Remove the template opener cruft (the `\cite{ISO800002}`/`\cite{Einstein}`/`Oetiker2014`
  LaTeX-template demo paragraph and `\graytx{\Blindtext}`).

"Proper citation" also means: in the **discussions**, cite literature when comparing
results (e.g. compare the ML precision/recall to Barbado & Corcho 2022 and Mumcuoglu et al.
2023; compare LoRa range to the SX1278 datasheet expectation; SUS 81.9 vs the 68-point
benchmark). Use `\cite{key}`.

---

## 10. Citations available / to add

Likely-relevant existing keys in `references.bib` (verify before use):
`barbado2022interpretable`, `mumcuoglu2023fuel`, `mathi2024development`,
`joshi2024intelligent`, `ntc2025legacy_network_phaseout`, plus the Chapter 3 method
refs (`wilson1927probable`, `lavin2015nab`, `fawcett2006roc`, `davis2006prroc`,
`arlot2010survey`, `chandola2009anomaly`, `liu2008isolation` if present).
If you cite something not in the .bib (e.g. the SUS source — Brooke 1996; an LTO
driver-fatigue circular), **add a correct apalike entry** to `references.bib`. Run a grep
for the key first; never invent a key that resolves to nothing (causes undefined-citation).

---

## 11. Definition of done (acceptance checklist)

- [ ] `\documentType` = `Thesis` (title page no longer says "Proposal").
- [ ] `results_and_discussions.tex` rewritten: 6.1–6.5 + Summary, each SO with overview,
      result tables, figures, and an interpretive Discussion.
- [ ] All target numbers match Chapter 5 (dataset 20,412 rows/79 trips; Model C 92.9 %/
      92.9 %/1.09 %; offline-buffer 66.9 %; GPS 5.52 s / 90.21 %; MAPE 1.04 %; SUS 81.9).
- [ ] No occurrence of "simulation"/"simulated"/"controlled environment" in Chapter 6.
- [ ] No code paths/file names/line numbers in prose.
- [ ] Duplicate/low-value figures removed; every figure is referenced by `Figure~\ref{}`
      in the text and has a short caption + `\label`.
- [ ] Objectives summary table filled (real result enumerates + clickable Location refs);
      template demo paragraph removed.
- [ ] Literature cited in discussions where results are compared.
- [ ] `latexmk` converges: **exit 0, 0 undefined refs, 0 undefined citations, 0 overfull
      hboxes**; `document.pdf` regenerated; spot-check the Ch6 pages render figures/tables.

---

## 12. Suggested order of work

1. Flip `\documentType` to Thesis; compile once to confirm baseline still builds.
2. Bring in figures: copy from `C:\thesis_final\docs\results\...` if available, else
   rename `figure/ch6_docx_raw/*` per captions; dedup.
3. Draft `results_and_discussions.tex` section by section from `CH6_SOURCE_EXTRACTED.txt`,
   applying all §1 constraints and aligning numbers to Chapter 5.
4. Fill the objectives summary table + add discussion citations.
5. Converge the build; fix any undefined ref/cite/overfull; re-verify zero.
6. Final read for tone, APA, and that every SO visibly hits its target.
