"""Strip comments from ESP32 C++ source per the appendix rules.

Rules implemented:
- Remove all /* ... */ block comments entirely (state machine, honors strings).
- Remove Doxygen ///  and /** */ (the /** */ falls under block-comment removal).
- Remove single-line // comments that are:
    * long ( > 80 chars of comment text ), OR
    * multi-sentence (contains '. ' or ends with '.' AND has another '.'), OR
    * TODO / FIXME / XXX / NOTE / HACK, OR
    * copyright / boilerplate, OR
    * commented-out code (heuristic: contains ';' or '{' or '}' or '(' followed
      by ')' or '=' operator or 'return' keyword or ends with ; ).
- Keep short single-line // comments (one clause, ~<= 80 chars, no sentence
  boundary, non-code).
- Preserve blank lines and code exactly.
- Preserve #include / #define / #pragma exactly.
"""

import os
import re
import sys

TAG_KEEP = re.compile(r'\b(NOTE|TODO|FIXME|XXX|HACK)\b', re.IGNORECASE)
COPYRIGHT = re.compile(r'\b(copyright|license|licensed|SPDX|all rights reserved)\b',
                       re.IGNORECASE)

# Heuristic: line looks like commented-out code
CODE_LIKE = re.compile(
    r'(;\s*$)'
    r'|(^\s*\}?\s*else\b)'
    r'|(\breturn\b\s)'
    r'|(\bif\s*\()'
    r'|(\bfor\s*\()'
    r'|(\bwhile\s*\()'
    r'|(\bswitch\s*\()'
    r'|(->\w)'
    r'|(::\w)'
    r'|(\w+\s*=\s*[^=])'
    r'|(\w+\s*\(.*\)\s*;?\s*$)'
    r'|(#\s*(include|define|pragma|ifdef|ifndef|endif))'
)

def strip_block_comments(src: str) -> str:
    """Remove /* ... */ everywhere, respecting string/char literals."""
    out = []
    i = 0
    n = len(src)
    in_string = False
    in_char = False
    in_line_comment = False
    in_block = False
    while i < n:
        c = src[i]
        nxt = src[i+1] if i+1 < n else ''
        if in_block:
            if c == '*' and nxt == '/':
                in_block = False
                i += 2
                continue
            # eat everything including newlines but preserve newlines to keep line structure minimal
            if c == '\n':
                out.append('\n')
            i += 1
            continue
        if in_line_comment:
            out.append(c)
            if c == '\n':
                in_line_comment = False
            i += 1
            continue
        if in_string:
            out.append(c)
            if c == '\\' and nxt:
                out.append(nxt)
                i += 2
                continue
            if c == '"':
                in_string = False
            i += 1
            continue
        if in_char:
            out.append(c)
            if c == '\\' and nxt:
                out.append(nxt)
                i += 2
                continue
            if c == "'":
                in_char = False
            i += 1
            continue
        # Not in any comment/string
        if c == '/' and nxt == '*':
            in_block = True
            i += 2
            continue
        if c == '/' and nxt == '/':
            in_line_comment = True
            out.append(c)
            i += 1
            continue
        if c == '"':
            in_string = True
            out.append(c)
            i += 1
            continue
        if c == "'":
            in_char = True
            out.append(c)
            i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def is_deletable_line_comment(text: str, code_before: str) -> bool:
    """Given the // comment text (without //) and the code portion before //,
    decide whether to delete the comment.
    """
    t = text.strip()
    if not t:
        return True
    # decorative separator lines (?? ?? ?? with maybe title) -- if fully punct, drop
    if re.fullmatch(r'[\s\-=*_#~\.?-?]+', t):
        return True
    # copyright/license
    if COPYRIGHT.search(t):
        return True
    # tag comments (TODO/FIXME/XXX/NOTE/HACK)
    if TAG_KEEP.search(t):
        return True
    # commented-out code
    if CODE_LIKE.search(t):
        return True
    # Strip decorative box-drawing chars for word-counting
    cleaned = re.sub(r'[?-?\-=*_#~]+', ' ', t).strip()
    if not cleaned:
        return True
    # multi-sentence: has '. ' with letter after
    if re.search(r'\.\s+\S', cleaned):
        return True
    # > 15 words -> verbose design note, drop
    words = re.findall(r"\S+", cleaned)
    if len(words) > 15:
        return True
    # > 100 chars (safety)
    if len(cleaned) > 100:
        return True
    return False


def strip_line_comments(src: str) -> str:
    """Walk line by line and drop or trim // comments per rules.

    We must respect string literals -- a '//' inside a string is not a comment.
    Since strings inside a single line matter, do char-level scan per line.
    """
    result_lines = []
    for line in src.split('\n'):
        # Find // outside of string/char literal.
        idx = find_line_comment(line)
        if idx < 0:
            result_lines.append(line)
            continue
        code_part = line[:idx]
        comment_full = line[idx:]  # starts with //
        # Strip leading slashes to get comment text; handle /// as doxygen -> delete.
        if comment_full.startswith('///'):
            # Doxygen -- always delete
            if code_part.strip():
                result_lines.append(code_part.rstrip())
            # else: drop entire line
            continue
        # normal // comment
        comment_text = comment_full[2:]
        if is_deletable_line_comment(comment_text, code_part):
            if code_part.strip():
                # inline trailing comment on a code line -- strip it
                result_lines.append(code_part.rstrip())
            # else: drop entire comment-only line
            continue
        # keep the comment as-is
        result_lines.append(line.rstrip())
    return '\n'.join(result_lines)


def find_line_comment(line: str) -> int:
    """Return index of // that starts a real comment, or -1."""
    in_string = False
    in_char = False
    i = 0
    n = len(line)
    while i < n:
        c = line[i]
        nxt = line[i+1] if i+1 < n else ''
        if in_string:
            if c == '\\' and nxt:
                i += 2
                continue
            if c == '"':
                in_string = False
            i += 1
            continue
        if in_char:
            if c == '\\' and nxt:
                i += 2
                continue
            if c == "'":
                in_char = False
            i += 1
            continue
        if c == '"':
            in_string = True
            i += 1
            continue
        if c == "'":
            in_char = True
            i += 1
            continue
        if c == '/' and nxt == '/':
            return i
        i += 1
    return -1


def collapse_comment_blocks(src: str) -> str:
    """Any run of 3+ consecutive comment-only // lines -> keep just the first,
    drop the rest. This kills paragraph-style design notes that survived
    per-line stripping because each individual line was short enough.
    Also drops continuation lines that clearly extend the previous comment
    (start with lowercase letter, or a small connective word).
    """
    lines = src.split('\n')
    is_comment_only = []
    for L in lines:
        s = L.strip()
        is_comment_only.append(s.startswith('//') and not s.startswith('///'))

    # Pass 1: collapse runs of 3+ into just the first
    keep = [True] * len(lines)
    i = 0
    while i < len(lines):
        if is_comment_only[i]:
            j = i
            while j < len(lines) and is_comment_only[j]:
                j += 1
            run_len = j - i
            if run_len >= 3:
                for k in range(i + 1, j):
                    keep[k] = False
            i = j
        else:
            i += 1

    # Pass 2: drop continuation lines directly after a kept comment
    for i in range(1, len(lines)):
        if not keep[i]:
            continue
        if not is_comment_only[i]:
            continue
        if not is_comment_only[i-1]:
            continue
        if not keep[i-1]:
            continue
        # extract text after //
        t = lines[i].strip()[2:].strip()
        first_word = re.match(r'([A-Za-z]+)', t)
        if not first_word:
            continue
        w = first_word.group(1)
        if w[0].islower():
            keep[i] = False
            continue
        if w.lower() in ('and', 'but', 'or', 'so', 'the', 'a', 'an',
                          'with', 'without', 'plus', 'also', 'then',
                          'this', 'that', 'these', 'those', 'it', 'if',
                          'when', 'while', 'because', 'since', 'used',
                          'because', 'i.e', 'e.g'):
            keep[i] = False

    return '\n'.join(L for L, k in zip(lines, keep) if k)


def collapse_blanks(src: str) -> str:
    """Collapse runs of 3+ blank lines to 2 blank lines max."""
    src = re.sub(r'\n{4,}', '\n\n\n', src)
    # remove leading/trailing extra newlines
    return src.strip('\n') + '\n'


def strip_file(inp: str, outp: str) -> int:
    with open(inp, 'r', encoding='utf-8', errors='replace') as f:
        src = f.read()
    src = strip_block_comments(src)
    src = strip_line_comments(src)
    src = collapse_comment_blocks(src)
    src = collapse_blanks(src)
    with open(outp, 'w', encoding='utf-8', newline='\n') as f:
        f.write(src)
    return src.count('\n')


JOBS = [
    (r'c:/thesis_final/THESIS/embedded/hmi_phase1/src/main.cpp',
     r'c:/thesis_final/thesis_REMETHS/ThesisTemplate/code_listings/hmi_phase1/main.cpp'),
    (r'c:/thesis_final/THESIS/embedded/lora_gateway/src/main.cpp',
     r'c:/thesis_final/thesis_REMETHS/ThesisTemplate/code_listings/lora_gateway/main.cpp'),
    (r'c:/thesis_final/THESIS/embedded/obd2_emulator/src/main.cpp',
     r'c:/thesis_final/thesis_REMETHS/ThesisTemplate/code_listings/obd2_emulator/main.cpp'),
    (r'c:/thesis_final/THESIS/embedded/filter_field_test/src/main.cpp',
     r'c:/thesis_final/thesis_REMETHS/ThesisTemplate/code_listings/filter_field_test/main.cpp'),
    (r'c:/thesis_final/THESIS/embedded/tests/lora_distance/src/tx.cpp',
     r'c:/thesis_final/thesis_REMETHS/ThesisTemplate/code_listings/lora_distance/tx.cpp'),
    (r'c:/thesis_final/THESIS/embedded/tests/lora_distance/src/rx.cpp',
     r'c:/thesis_final/thesis_REMETHS/ThesisTemplate/code_listings/lora_distance/rx.cpp'),
    (r'c:/thesis_final/THESIS/embedded/tests/gsm_drive/src/main.cpp',
     r'c:/thesis_final/thesis_REMETHS/ThesisTemplate/code_listings/gsm_drive/main.cpp'),
]


if __name__ == '__main__':
    for inp, outp in JOBS:
        os.makedirs(os.path.dirname(outp), exist_ok=True)
        n = strip_file(inp, outp)
        print(f'{n:6d}  {outp}')
