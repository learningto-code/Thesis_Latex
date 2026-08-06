"""Strip comments from JS/JSX/SQL source per the appendix rules.

Same spirit as _strip.py (C++) but adapted for JS/JSX (// and /* */) and SQL
(-- and /* */). Also ASCII-folds the output so LaTeX listings render cleanly.
"""

import os
import re
import unicodedata

TAG_KEEP = re.compile(r'\b(NOTE|TODO|FIXME|XXX|HACK)\b', re.IGNORECASE)
COPYRIGHT = re.compile(r'\b(copyright|license|licensed|SPDX|all rights reserved)\b',
                       re.IGNORECASE)

CODE_LIKE = re.compile(
    r'(;\s*$)'
    r'|(^\s*\}?\s*else\b)'
    r'|(\breturn\b\s)'
    r'|(\bif\s*\()'
    r'|(\bfor\s*\()'
    r'|(\bwhile\s*\()'
    r'|(\bswitch\s*\()'
    r'|(=>\s)'
    r'|(->\w)'
    r'|(::\w)'
    r'|(\bconst\s+\w+\s*=)'
    r'|(\blet\s+\w+\s*=)'
    r'|(\bvar\s+\w+\s*=)'
    r'|(\bfunction\b)'
    r'|(\w+\s*\(.*\)\s*;?\s*$)'
)


def strip_block_comments_c_style(src: str) -> str:
    out = []
    i = 0
    n = len(src)
    in_dq = False
    in_sq = False
    in_bt = False
    in_line_comment = False
    in_block = False
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if in_block:
            if c == '*' and nxt == '/':
                in_block = False
                i += 2
                continue
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
        if in_dq:
            out.append(c)
            if c == '\\' and nxt:
                out.append(nxt)
                i += 2
                continue
            if c == '"':
                in_dq = False
            i += 1
            continue
        if in_sq:
            out.append(c)
            if c == '\\' and nxt:
                out.append(nxt)
                i += 2
                continue
            if c == "'":
                in_sq = False
            i += 1
            continue
        if in_bt:
            out.append(c)
            if c == '\\' and nxt:
                out.append(nxt)
                i += 2
                continue
            if c == '`':
                in_bt = False
            i += 1
            continue
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
            in_dq = True
            out.append(c)
            i += 1
            continue
        if c == "'":
            in_sq = True
            out.append(c)
            i += 1
            continue
        if c == '`':
            in_bt = True
            out.append(c)
            i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def is_deletable_line_comment(text):
    t = text.strip()
    if not t:
        return True
    if re.fullmatch(r'[\s\-=*_#~\.]+', t):
        return True
    if COPYRIGHT.search(t):
        return True
    if TAG_KEEP.search(t):
        return True
    if CODE_LIKE.search(t):
        return True
    cleaned = re.sub(r'[\-=*_#~]+', ' ', t).strip()
    if not cleaned:
        return True
    if re.search(r'\.\s+\S', cleaned):
        return True
    words = re.findall(r"\S+", cleaned)
    if len(words) > 12:
        return True
    if len(cleaned) > 90:
        return True
    return False


def find_line_comment_js(line):
    in_dq = False
    in_sq = False
    in_bt = False
    i = 0
    n = len(line)
    while i < n:
        c = line[i]
        nxt = line[i + 1] if i + 1 < n else ''
        if in_dq:
            if c == '\\' and nxt:
                i += 2
                continue
            if c == '"':
                in_dq = False
            i += 1
            continue
        if in_sq:
            if c == '\\' and nxt:
                i += 2
                continue
            if c == "'":
                in_sq = False
            i += 1
            continue
        if in_bt:
            if c == '\\' and nxt:
                i += 2
                continue
            if c == '`':
                in_bt = False
            i += 1
            continue
        if c == '"':
            in_dq = True
            i += 1
            continue
        if c == "'":
            in_sq = True
            i += 1
            continue
        if c == '`':
            in_bt = True
            i += 1
            continue
        if c == '/' and nxt == '/':
            return i
        i += 1
    return -1


def find_line_comment_sql(line):
    in_dq = False
    in_sq = False
    i = 0
    n = len(line)
    while i < n:
        c = line[i]
        nxt = line[i + 1] if i + 1 < n else ''
        if in_dq:
            if c == '"':
                in_dq = False
            i += 1
            continue
        if in_sq:
            if c == "'":
                in_sq = False
            i += 1
            continue
        if c == '"':
            in_dq = True
            i += 1
            continue
        if c == "'":
            in_sq = True
            i += 1
            continue
        if c == '-' and nxt == '-':
            return i
        i += 1
    return -1


def strip_line_comments_js(src):
    result_lines = []
    for line in src.split('\n'):
        idx = find_line_comment_js(line)
        if idx < 0:
            result_lines.append(line)
            continue
        code_part = line[:idx]
        comment_full = line[idx:]
        comment_text = comment_full[2:]
        if is_deletable_line_comment(comment_text):
            if code_part.strip():
                result_lines.append(code_part.rstrip())
            continue
        result_lines.append(line.rstrip())
    return '\n'.join(result_lines)


def strip_line_comments_sql(src):
    result_lines = []
    for line in src.split('\n'):
        idx = find_line_comment_sql(line)
        if idx < 0:
            result_lines.append(line)
            continue
        code_part = line[:idx]
        comment_full = line[idx:]
        comment_text = comment_full[2:]
        if is_deletable_line_comment(comment_text):
            if code_part.strip():
                result_lines.append(code_part.rstrip())
            continue
        result_lines.append(line.rstrip())
    return '\n'.join(result_lines)


def collapse_comment_blocks_js(src):
    lines = src.split('\n')
    is_comment_only = []
    for L in lines:
        s = L.strip()
        is_comment_only.append(s.startswith('//'))

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

    for i in range(1, len(lines)):
        if not keep[i] or not is_comment_only[i]:
            continue
        if not is_comment_only[i - 1] or not keep[i - 1]:
            continue
        t = lines[i].strip()[2:].strip()
        first_word = re.match(r'([A-Za-z]+)', t)
        if not first_word:
            continue
        w = first_word.group(1)
        if w[0].islower() or w.lower() in (
            'and', 'but', 'or', 'so', 'the', 'a', 'an', 'with', 'without',
            'plus', 'also', 'then', 'this', 'that', 'these', 'those', 'it',
            'if', 'when', 'while', 'because', 'since', 'used', 'i.e', 'e.g'
        ):
            keep[i] = False

    return '\n'.join(L for L, k in zip(lines, keep) if k)


def collapse_blanks(src):
    src = re.sub(r'\n{4,}', '\n\n\n', src)
    return src.strip('\n') + '\n'


ASCII_MAP = {
    "–": '-', "—": '-', "−": '-',
    "‘": "'", "’": "'", "‚": "'",
    "“": '"', "”": '"', "„": '"',
    "…": '...', " ": ' ', "•": '*',
    "→": '->', "←": '<-', "⇒": '=>',
    "×": 'x', "±": '+/-', "°": 'deg',
    "µ": 'u', "≤": '<=', "≥": '>=',
    "≠": '!=', "·": '.', "′": "'",
    "″": '"',
}


def ascii_fold(src):
    out = []
    for ch in src:
        if ord(ch) < 128:
            out.append(ch)
            continue
        if ch in ASCII_MAP:
            out.append(ASCII_MAP[ch])
            continue
        nk = unicodedata.normalize('NFKD', ch)
        stripped = ''.join(c for c in nk if not unicodedata.combining(c) and ord(c) < 128)
        if stripped:
            out.append(stripped)
        else:
            out.append('?')
    return ''.join(out)


def strip_js(src):
    src = strip_block_comments_c_style(src)
    src = strip_line_comments_js(src)
    src = collapse_comment_blocks_js(src)
    src = collapse_blanks(src)
    src = ascii_fold(src)
    return src


def strip_sql(src):
    src = strip_block_comments_c_style(src)
    src = strip_line_comments_sql(src)
    src = collapse_blanks(src)
    src = ascii_fold(src)
    return src


def strip_file(inp, outp, kind):
    with open(inp, 'r', encoding='utf-8', errors='replace') as f:
        src = f.read()
    if kind == 'sql':
        out = strip_sql(src)
    else:
        out = strip_js(src)
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    with open(outp, 'w', encoding='utf-8', newline='\n') as f:
        f.write(out)
    return out.count('\n')


DST_ROOT = r'c:/thesis_final/thesis_REMETHS/ThesisTemplate/code_listings'

JOBS = [
    (r'c:/thesis_final/THESIS/backend/server.js',
     DST_ROOT + '/backend/server.js', 'js'),
    (r'c:/thesis_final/THESIS/backend/scripts/rescore_trip.js',
     DST_ROOT + '/backend/rescore_trip.js', 'js'),
    (r'c:/thesis_final/THESIS/supabase/migrations/20260622091500_trip_distance_odometer_accumulation.sql',
     DST_ROOT + '/supabase/20260622091500_trip_distance_odometer_accumulation.sql', 'sql'),
    (r'c:/thesis_final/THESIS/supabase/migrations/20260622220000_widen_trip_distance_gap_cap.sql',
     DST_ROOT + '/supabase/20260622220000_widen_trip_distance_gap_cap.sql', 'sql'),
    (r'c:/thesis_final/THESIS/supabase/migrations/20260625120000_physics_capped_trip_distance.sql',
     DST_ROOT + '/supabase/20260625120000_physics_capped_trip_distance.sql', 'sql'),
    (r'c:/thesis_final/THESIS/supabase/migrations/20260625160000_add_anomaly_type_to_telemetry_logs.sql',
     DST_ROOT + '/supabase/20260625160000_add_anomaly_type_to_telemetry_logs.sql', 'sql'),
    (r'c:/thesis_final/THESIS/supabase/migrations/20260625180000_distance_use_odometer_delta_for_gaps.sql',
     DST_ROOT + '/supabase/20260625180000_distance_use_odometer_delta_for_gaps.sql', 'sql'),
    (r'c:/thesis_final/THESIS/frontend/src/App.jsx',
     DST_ROOT + '/frontend/App.jsx', 'js'),
    (r'c:/thesis_final/THESIS/frontend/src/main.jsx',
     DST_ROOT + '/frontend/main.jsx', 'js'),
]

for name in ['Alerts', 'Analytics', 'Dashboard', 'FleetMap', 'Layout',
             'LoginSignUp', 'Logs', 'MapView', 'RouteAssignModal',
             'Settings', 'Trips', 'TruckDetailModal', 'Trucks']:
    JOBS.append(('c:/thesis_final/THESIS/frontend/src/components/' + name + '.jsx',
                 DST_ROOT + '/frontend/' + name + '.jsx', 'js'))

for name in ['DriverApp', 'DriverLogin', 'DriverMap', 'DriverNav',
             'DriverNoTrip', 'DriverTrip', 'DriverTrucks']:
    JOBS.append(('c:/thesis_final/THESIS/frontend/src/components/driver/' + name + '.jsx',
                 DST_ROOT + '/frontend/driver/' + name + '.jsx', 'js'))


if __name__ == '__main__':
    for inp, outp, kind in JOBS:
        n = strip_file(inp, outp, kind)
        print('{:6d}  {}'.format(n, outp))
