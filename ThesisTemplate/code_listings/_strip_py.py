"""AST-driven comment/docstring stripper for thesis ML Python source listings.

Rules:
- Remove triple-quoted docstrings longer than one sentence; keep one-line docstrings.
- Remove standalone '#' comments that (a) span more than one sentence, or
  (b) look like design notes/rationale, or (c) are commented-out executable code.
- Preserve short single-sentence standalone comments.
- Preserve trailing inline comments on code lines (short annotations).
- Preserve imports, decorators, signatures, and code exactly.
- Ensure every def/class has EITHER a short docstring OR a short '#' header comment.
- Collapse runs of >2 blank lines to 2.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path


COMMENTED_CODE_PATTERNS = [
    re.compile(r"^\s*#\s*(def|class|if|elif|else|for|while|try|except|finally|with|return|import|from|print|raise|yield|lambda|async|await)\b"),
    re.compile(r"^\s*#\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^=]"),
    re.compile(r"^\s*#\s*[A-Za-z_][A-Za-z0-9_.]*\s*\("),
    re.compile(r"^\s*#\s*@[A-Za-z_]"),
]

DESIGN_KEYWORDS = re.compile(
    r"\b(rationale|thesis|because|since |reason|explanation|"
    r"see (also|section|paper)|per (the|user|spec)|according to|we chose|"
    r"we use|we opt|approach|strategy|philosophy|caveat|assumption|"
    r"historical|legacy|deprecated)\b",
    re.IGNORECASE,
)


def is_commented_code(line: str) -> bool:
    for pat in COMMENTED_CODE_PATTERNS:
        if pat.match(line):
            return True
    return False


def sentence_count(text: str) -> int:
    text = text.strip()
    if not text:
        return 0
    parts = re.split(r"[.!?](?:\s+|$)", text)
    return sum(1 for p in parts if p.strip())


def is_design_comment(line: str) -> bool:
    body = re.sub(r"^\s*#\s?", "", line)
    return bool(DESIGN_KEYWORDS.search(body))


def strip_line_comments(source: str) -> str:
    """Drop standalone '#' comment lines that violate rules; keep trailing ones."""
    out: list[str] = []
    for line in source.splitlines():
        stripped = line.lstrip()
        if not stripped.startswith("#"):
            out.append(line)
            continue
        # Standalone comment line.
        if is_commented_code(line):
            continue
        body = re.sub(r"^\s*#\s?", "", line)
        if sentence_count(body) > 1:
            continue
        if is_design_comment(line):
            continue
        # Also drop decorative separators like "# ---" or "# ==="
        body_stripped = body.strip()
        if body_stripped and re.fullmatch(r"[-=_*~#]+", body_stripped):
            continue
        if len(body) > 100:
            # Long single-sentence comment: drop as noise.
            continue
        out.append(line)
    return "\n".join(out) + ("\n" if source.endswith("\n") else "")


def strip_multiline_docstrings(source: str) -> str:
    """Remove docstrings on Module/Class/Function that are multi-line or multi-sentence."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return source

    to_remove: set[int] = set()

    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if not (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)):
            continue
        doc_text = first.value.value
        start = first.lineno
        end = getattr(first, "end_lineno", start)
        # Keep short single-line docstrings.
        if start == end and sentence_count(doc_text) <= 1 and len(doc_text) < 100:
            continue
        for ln in range(start, end + 1):
            to_remove.add(ln)

    if not to_remove:
        return source

    lines = source.splitlines()
    out = [line for idx, line in enumerate(lines, start=1) if idx not in to_remove]
    return "\n".join(out) + ("\n" if source.endswith("\n") else "")


def add_def_class_summaries(source: str) -> str:
    """Ensure every def/class body starts with a comment or short docstring."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return source

    lines = source.splitlines()
    insertions: list[tuple[int, str, str]] = []

    def summarize(name: str, kind: str) -> str:
        words = re.split(r"[_\s]+", name)
        pretty = " ".join(w for w in words if w)
        if kind == "class":
            return f"# {pretty} class."
        return f"# {pretty}."

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        # Short docstring? OK.
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
            doc_text = first.value.value
            if first.lineno == getattr(first, "end_lineno", first.lineno) and sentence_count(doc_text) <= 1:
                continue
        # Check line just above `first` inside body: if it's a comment, we're good.
        above_idx = first.lineno - 2
        if 0 <= above_idx < len(lines) and lines[above_idx].strip().startswith("#"):
            continue
        first_line = lines[first.lineno - 1]
        m = re.match(r"^(\s*)", first_line)
        indent = m.group(1) if m else "    "
        kind = "class" if isinstance(node, ast.ClassDef) else "def"
        insertions.append((first.lineno, indent, summarize(node.name, kind)))

    if not insertions:
        return source

    insertions.sort(key=lambda x: x[0], reverse=True)
    for lineno_1, indent, comment in insertions:
        lines.insert(lineno_1 - 1, f"{indent}{comment}")
    return "\n".join(lines) + ("\n" if source.endswith("\n") else "")


def collapse_blank_lines(source: str) -> str:
    result = re.sub(r"\n{4,}", "\n\n\n", source)
    return result.strip("\n") + "\n"


def strip_file(src_path: Path, dst_path: Path) -> tuple[int, bool]:
    source = src_path.read_text(encoding="utf-8")
    s1 = strip_multiline_docstrings(source)
    s2 = strip_line_comments(s1)
    s3 = add_def_class_summaries(s2)
    s4 = collapse_blank_lines(s3)
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    dst_path.write_text(s4, encoding="utf-8")
    ok = True
    try:
        ast.parse(s4)
    except SyntaxError as e:
        ok = False
        print(f"[PARSE-FAIL] {src_path.name}: {e}", file=sys.stderr)
    return len(s4.splitlines()), ok


FILES = [
    "preprocess.py",
    "dataset_pipeline.py",
    "build_real_obd_dataset.py",
    "inject_anomalies.py",
    "train_iforest.py",
    "matrix_profile.py",
    "fuel_kalman.py",
    "filter_comparison.py",
    "filter_field_test.py",
    "loto_evaluate.py",
    "loto_baselines.py",
    "loto_ablation.py",
    "stats_tests.py",
    "anomaly_service.py",
    "infer.py",
    "simulate_test_trips.py",
    "simulate_live_trip.py",
]


def main() -> None:
    src_root = Path(r"c:/thesis_final/THESIS/ml")
    dst_root = Path(r"c:/thesis_final/thesis_REMETHS/ThesisTemplate/code_listings/ml")
    print(f"{'file':40s} {'lines':>6s}  parse")
    for name in FILES:
        src = src_root / name
        dst = dst_root / name
        n, ok = strip_file(src, dst)
        flag = "OK" if ok else "FAIL"
        print(f"{name:40s} {n:6d}  {flag}")


if __name__ == "__main__":
    main()
