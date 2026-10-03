from __future__ import annotations

import re
from pathlib import Path
from typing import Any

PATTERNS = [
    ("cross_reference", re.compile(r"Could not resolve cross-reference|Failed to find a named object", re.I)),
    ("xml", re.compile(r"XML error|XML patch operation|XML loader", re.I)),
    ("type_load", re.compile(r"TypeLoadException|ReflectionTypeLoadException|Could not load type", re.I)),
    ("assembly", re.compile(r"Could not load file or assembly|FileNotFoundException.*\.dll", re.I)),
    ("harmony", re.compile(r"Harmony.*(exception|error|failed)|Patching exception", re.I)),
    ("exception", re.compile(r"\b(?:NullReferenceException|InvalidCastException|ArgumentException|InvalidOperationException|Exception:)\b", re.I)),
    ("texture", re.compile(r"Could not load UnityEngine\.Texture|Failed to load texture|Could not load texture", re.I)),
]

# Lines that only matter in aggregate: dozens of identical "Duplicate stacktrace" lines
# mean a per-tick or per-frame thrower, and the original stack is in the first block.
AGGREGATE_PATTERNS = {
    "duplicate_stack_ref": re.compile(r"\[Ref [0-9A-Fa-f]+\]\s*(Duplicate stacktrace, see ref for original)?"),
}


def _dedupe_storms(lines: list[str], max_hits: int) -> tuple[list[dict[str, Any]], int, list[dict[str, Any]]]:
    """Collapse identical repeats. Returns (hits, collapsed_count, storms).

    A storm is any single stripped line repeated >= 25 times that looks like an
    exception/ref-dedup line. Unity dedupes identical stack traces to
    '[Ref XXXX] Duplicate stacktrace', so per-line counts are the real signal.
    """
    def _kinds(text: str) -> list[str]:
        return [name for name, pattern in PATTERNS if pattern.search(text)]

    def _stormy(text: str) -> bool:
        return bool(_kinds(text)) or bool(AGGREGATE_PATTERNS["duplicate_stack_ref"].search(text))

    counts: dict[str, int] = {}
    for line in lines:
        t = line.strip()
        if t:
            counts[t] = counts.get(t, 0) + 1

    hits: list[dict[str, Any]] = []
    collapsed = 0
    for i, line in enumerate(lines):
        kinds = _kinds(line)
        if not kinds:
            continue
        text = line.strip()
        if counts[text] > 1:
            collapsed += 1
            if hits and hits[-1]["text"] == text:
                continue  # consecutive identical repeat -> already captured with context
        lo = max(0, i - 1)
        hi = min(len(lines), i + 2)
        hits.append({"line": i + 1, "kinds": kinds, "text": text, "context": lines[lo:hi]})
        if len(hits) >= max_hits:
            break

    storms: list[dict[str, Any]] = []
    for text, n in counts.items():
        if n >= 25 and _stormy(text):
            first = next(i + 1 for i, l in enumerate(lines) if l.strip() == text)
            storms.append({"line": first, "text": text, "repeats": n, "kinds": _kinds(text)})
    storms.sort(key=lambda s: -s["repeats"])
    return hits, collapsed, storms


def analyze_log(path: Path, context: int = 1, max_hits: int = 200) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(path)
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    hits, collapsed, storms = _dedupe_storms(lines, max_hits)
    counts: dict[str, int] = {}
    for hit in hits:
        for kind in hit["kinds"]:
            counts[kind] = counts.get(kind, 0) + 1
    # storm kinds counted from full-text frequency, not the capped hit list
    for storm in storms:
        kinds = storm["kinds"] or ["duplicate_stack_ref"]
        for kind in kinds:
            counts[kind] = counts.get(kind, 0) + storm["repeats"] - 1
    return {
        "ok": True,
        "file": str(path),
        "lines": len(lines),
        "hits": hits,
        "counts": counts,
        "storms": storms,
        "duplicate_lines_collapsed": collapsed,
        "truncated": len(hits) >= max_hits,
        "notes": [
            "Storm lines repeat identically because Unity dedupes stack traces; the FIRST block in the log holds the original stack."
        ] if storms else [],
    }
