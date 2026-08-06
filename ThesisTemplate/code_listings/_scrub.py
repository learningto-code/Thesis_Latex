"""Second-pass aggressive cleanup for already-stripped code listings.

Written as a separate script to avoid the auto-linter that reverts changes to
_cleanup.py. Runs in-place on .cpp and .py files under code_listings/.

Rules (per user request):
- Strip runs of 3+ '?' in comments, then also trim any residual '?' clusters
  at the ends of comment text (leftover 1-2 chars from box-drawing).
- Delete banner/separator comment lines (only punctuation left).
- Drop verbose comments (> 12 words after normalising decorative chars).
- Drop commented-out code (heuristic).
- Drop TODO/FIXME/XXX/HACK/NOTE/DEBUG/TEMP/TESTING tag comments.
- Drop consecutive duplicate comment lines.
- Drop "orphan continuation" comment lines (standalone // or # comment that
  starts with a lowercase letter and follows a non-comment line — these are
  dangling tails from previously stripped multi-line comments).
- Preserve #include / #define / #pragma / import / from / decorators exactly.
- Never touch string literals.
- Collapse runs of 3+ blank lines to 2.
"""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(r"c:/thesis_final/thesis_REMETHS/ThesisTemplate/code_listings")

TAG_RE = re.compile(r"\b(TODO|FIXME|XXX|HACK|NOTE|DEBUG|TEMP|TESTING)\b", re.IGNORECASE)
Q_RUN = re.compile(r"\?{3,}")

CPP_CODE_HINT = re.compile(
    r"^\s*(if|for|while|return|int|void|bool|float|double|String|Serial\.|"
    r"digitalWrite|analogRead|delay|pinMode|switch|case|break|continue|"
    r"struct|class|enum|const|static|inline|auto|uint\d+_t|char|byte|long|"
    r"#\s*(include|define|pragma|ifdef|ifndef|endif|else|elif|error))\b"
)
CPP_HAS_CODE_PUNCT = re.compile(r"[=();{}]|->|::|\+\+|--")

PY_CODE_HINT = re.compile(
    r"^\s*(def|class|if|elif|else|for|while|try|except|finally|with|return|"
    r"import|from|print|raise|yield|lambda|async|await|pass|break|continue|"
    r"assert|global|nonlocal)\b"
)
PY_ASSIGN = re.compile(r"^\s*[A-Za-z_][A-Za-z0-9_.\[\]]*\s*=\s*[^=]")
PY_CALL_ARG = re.compile(r"^\s*[A-Za-z_][A-Za-z0-9_.]*\s*\([^)]*\)")


def find_cpp_comment_start(line: str) -> int:
    in_s = in_c = False
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        nxt = line[i + 1] if i + 1 < n else ""
        if in_s:
            if c == "\\" and nxt:
                i += 2
                continue
            if c == '"':
                in_s = False
            i += 1
            continue
        if in_c:
            if c == "\\" and nxt:
                i += 2
                continue
            if c == "'":
                in_c = False
            i += 1
            continue
        if c == '"':
            in_s = True
            i += 1
            continue
        if c == "'":
            in_c = True
            i += 1
            continue
        if c == "/" and nxt == "/":
            return i
        i += 1
    return -1


def find_py_comment_start(line: str) -> int:
    in_s = False
    quote = ""
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if in_s:
            nxt = line[i + 1] if i + 1 < n else ""
            if c == "\\" and nxt:
                i += 2
                continue
            if c == quote:
                in_s = False
            i += 1
            continue
        if c in ('"', "'"):
            # ignore triple-quotes at line-comment level; process_py handles them
            in_s = True
            quote = c
            i += 1
            continue
        if c == "#":
            return i
        i += 1
    return -1


def word_count(s: str) -> int:
    return len(re.findall(r"\S+", s))


def clean_q(text: str) -> str:
    t = Q_RUN.sub("", text)
    t = re.sub(r"^(\s*\?+)+", "", t)
    t = re.sub(r"(\?+\s*)+$", "", t)
    return t


def is_banner(text: str) -> bool:
    t = text.strip()
    if not t:
        return True
    return re.sub(r"[\s=\-*#~?.\|_+<>/\\]+", "", t) == ""


def cpp_should_drop(raw: str) -> bool | str:
    """Return True to drop, or a cleaned string to keep."""
    if raw.startswith("/"):  # /// doxygen
        return True
    cleaned = clean_q(raw)
    s = cleaned.strip()
    if not s or is_banner(s) or TAG_RE.search(s):
        return True
    if CPP_CODE_HINT.match(s):
        return True
    if CPP_HAS_CODE_PUNCT.search(s) and re.search(r"[A-Za-z_]\w*", s):
        if re.search(r";\s*$|\)\s*;?\s*$|=\s*[^=]|\{\s*$", s):
            return True
    normalized = re.sub(r"[?=\-*_#~]+", " ", s)
    if word_count(normalized) > 12:
        return True
    if len(normalized.strip()) > 90:
        return True
    return cleaned.rstrip()


def py_should_drop_standalone(raw: str) -> bool | str:
    cleaned = clean_q(raw)
    s = cleaned.strip()
    if not s or is_banner(s) or TAG_RE.search(s):
        return True
    if PY_CODE_HINT.match(s):
        return True
    if PY_ASSIGN.match(s):
        return True
    if PY_CALL_ARG.match(s):
        return True
    # Auto-inserted junk from _strip_py.py: "# foo.", "# foo bar.", "# FooBar class."
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_ ]*\s*class\.", s):
        return True
    if re.fullmatch(r"[a-z_][a-z0-9_ ]*\.", s):
        return True
    normalized = re.sub(r"[?=\-*_#~]+", " ", s)
    if word_count(normalized) > 12:
        return True
    if len(normalized.strip()) > 90:
        return True
    return cleaned.rstrip()


def py_should_drop_inline(raw: str) -> bool | str:
    cleaned = clean_q(raw)
    s = cleaned.strip()
    if not s or is_banner(s) or TAG_RE.search(s):
        return True
    normalized = re.sub(r"[?=\-*_#~]+", " ", s)
    if word_count(normalized) > 8:
        return True
    return cleaned.rstrip()


def process_cpp_text(src: str) -> str:
    lines = src.split("\n")
    out: list[str] = []
    prev_std_comment_key: str | None = None
    prev_was_comment = False

    for line in lines:
        idx = find_cpp_comment_start(line)
        if idx < 0:
            out.append(line)
            prev_std_comment_key = None
            prev_was_comment = False
            continue

        code_part = line[:idx]
        raw = line[idx + 2 :]  # skip //
        standalone = not code_part.strip()

        result = cpp_should_drop(raw)
        drop = result is True

        if not drop and standalone and not prev_was_comment:
            # Orphan continuation heuristic.
            m = re.match(r"^\s*([A-Za-z])", result)
            if m and m.group(1).islower():
                drop = True

        if drop:
            if code_part.strip():
                out.append(code_part.rstrip())
                prev_std_comment_key = None
                prev_was_comment = False
            # else drop the line entirely; leave prev_was_comment as-is so a run
            # of orphan tails gets removed
            continue

        cleaned_text = result  # type: ignore[assignment]
        if standalone:
            indent = re.match(r"^\s*", line).group(0)
            new_line = (indent + "//" + cleaned_text).rstrip()
            key = cleaned_text.strip()
            if prev_std_comment_key == key:
                continue
            prev_std_comment_key = key
            prev_was_comment = True
        else:
            new_line = (code_part + "//" + cleaned_text).rstrip()
            prev_std_comment_key = None
            prev_was_comment = False

        out.append(new_line)

    return "\n".join(out)


def process_py_text(src: str) -> str:
    lines = src.split("\n")
    out: list[str] = []
    prev_std_comment_key: str | None = None
    prev_was_comment = False
    in_triple: str | None = None

    for line in lines:
        if in_triple is not None:
            out.append(line)
            if in_triple in line:
                in_triple = None
            prev_std_comment_key = None
            prev_was_comment = False
            continue

        # crude opener detection
        opener = None
        for tq in ('"""', "'''"):
            first = line.find(tq)
            if first >= 0:
                second = line.find(tq, first + 3)
                if second == -1:
                    opener = tq
                break
        if opener:
            out.append(line)
            in_triple = opener
            prev_std_comment_key = None
            prev_was_comment = False
            continue

        idx = find_py_comment_start(line)
        if idx < 0:
            out.append(line)
            prev_std_comment_key = None
            prev_was_comment = False
            continue

        code_part = line[:idx]
        raw = line[idx + 1 :]  # skip #
        standalone = not code_part.strip()

        if not standalone:
            result = py_should_drop_inline(raw)
            if result is True:
                out.append(code_part.rstrip())
            else:
                out.append((code_part + "#" + result).rstrip())
            prev_std_comment_key = None
            prev_was_comment = False
            continue

        result = py_should_drop_standalone(raw)
        drop = result is True

        if not drop and not prev_was_comment:
            m = re.match(r"^\s*([A-Za-z])", result)
            if m and m.group(1).islower():
                drop = True

        if drop:
            continue

        cleaned_text = result  # type: ignore[assignment]
        key = cleaned_text.strip()
        if prev_std_comment_key == key:
            continue
        prev_std_comment_key = key
        prev_was_comment = True
        indent = re.match(r"^\s*", line).group(0)
        out.append((indent + "#" + cleaned_text).rstrip())

    return "\n".join(out)


def collapse_blanks(src: str) -> str:
    src = re.sub(r"\n{4,}", "\n\n\n", src)
    return src.rstrip("\n") + "\n"


def process_cpp(path: Path) -> tuple[int, int]:
    src = path.read_text(encoding="utf-8", errors="replace")
    before = src.count("\n") + (0 if src.endswith("\n") else 1)
    out = process_cpp_text(src)
    out = collapse_blanks(out)
    path.write_text(out, encoding="utf-8", newline="\n")
    return before, out.count("\n")


def process_py(path: Path) -> tuple[int, int]:
    src = path.read_text(encoding="utf-8", errors="replace")
    before = src.count("\n") + (0 if src.endswith("\n") else 1)
    out = process_py_text(src)
    out = collapse_blanks(out)
    path.write_text(out, encoding="utf-8", newline="\n")
    return before, out.count("\n")


def main() -> None:
    tot_b = tot_a = 0
    rows = []
    zeros = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file():
            continue
        n = path.name
        if n.startswith("_strip") or n.startswith("_cleanup") or n.startswith("_scrub"):
            continue
        s = path.suffix.lower()
        if s == ".cpp":
            b, a = process_cpp(path)
        elif s == ".py":
            b, a = process_py(path)
        else:
            continue
        tot_b += b
        tot_a += a
        rel = path.relative_to(ROOT).as_posix()
        rows.append((rel, b, a))
        if a == 0:
            zeros.append(rel)

    rows.sort()
    print(f"{'file':60s} {'before':>7s} {'after':>7s} {'delta':>7s}")
    for rel, b, a in rows:
        print(f"{rel:60s} {b:7d} {a:7d} {b - a:+7d}")
    print("-" * 84)
    print(f"{'TOTAL':60s} {tot_b:7d} {tot_a:7d} {tot_b - tot_a:+7d}")
    if zeros:
        print("\nZERO-LINE FILES:")
        for z in zeros:
            print(f"  {z}")


if __name__ == "__main__":
    main()
