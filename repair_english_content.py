#!/usr/bin/env python3
"""Repair English ACIM titles, reminder excerpts, and full text line alignment.

The bilingual acim-farsi.org API contains the English source lines paired with
the authoritative Persian translation. This pass makes English reminder
excerpts use those exact source lines while retaining a small set of useful
Android-app-only navigation labels in standardized form.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

import repair_persian_content as source


LESSON_COUNT = 365

# These labels organize the Android reminder excerpts but are not sentences in
# the Course source. Values fix punctuation, grammar, and obvious transcription
# mistakes without presenting the labels as verbatim source text.
EDITORIAL_ENGLISH = {
    "Farther away ………": "Farther away:",
    "Shorter Practice Periods:": "Shorter practice periods:",
    "Longer Practice Periods:": "Longer practice periods:",
    "Shorter Practice:": "Shorter practice:",
    "Longer Practice:": "Longer practice:",
    "Watch thoughts ………": "Watch your thoughts:",
    "Review some of the external places you have looked for salvation ………": (
        "Review some of the external places where you have looked for salvation:"
    ),
    "Add related thoughts, such as:": "Add related thoughts, such as:",
    "For conflict thoughts that may cross your mind:": (
        "For conflict thoughts that may cross your mind:"
    ),
    "For particularly difficult one's tell yourself:": (
        "For particularly difficult thoughts, tell yourself:"
    ),
    "Give thanks, etc. Then say:": "Give thanks, then say:",
    "For disturbing situations or should you become angry:": (
        "For disturbing situations, or if you become angry:"
    ),
    "Close eyes:": "Close your eyes:",
    "And remind yourself of this between the times you give five minutes:": (
        "Between the five-minute practice periods, remind yourself:"
    ),
    "If you are tempted to believe doubt and fear:": (
        "If you are tempted to believe in doubt and fear:"
    ),
    "As often as you can:": "As often as you can:",
    "And as often as is possible:": "And as often as possible:",
    "And as often as possible:": "And as often as possible:",
    "Dismiss temptation whenever it arises by saying:": (
        "Whenever temptation arises, dismiss it by saying:"
    ),
    "And remember often:": "And remember often:",
    "Say the above throughout the day and whenever tempted.": (
        "Repeat the statement above throughout the day and whenever you are tempted."
    ),
    "Throughout the day and when you forget forgivenesses meaning:": (
        "Throughout the day, and whenever you forget the meaning of forgiveness:"
    ),
    # These combine an app label with source content. The source wording is
    # retained, while the label is standardized.
    "For example, I do not see a neutral wall, because my thoughts about walls are not neutral.": (
        "For example: I do not see a neutral wall, because my thoughts about walls are not neutral."
    ),
    "For thoughts of grievance:  Love holds no grievances. Let me not betray my Self.": (
        "For thoughts of grievance: Love holds no grievances. Let me not betray my Self."
    ),
    "Several times an hour:  Love holds no grievances. I would wake to my Self by laying all my grievances aside and wakening in Him.": (
        "Several times an hour: Love holds no grievances. I would wake to my Self by "
        "laying all my grievances aside and wakening in Him."
    ),
    "To everyone I offer _____.  For example:  To everyone I offer quietness.": (
        "For example: To everyone I offer quietness."
    ),
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def english_full_text(lines: list[source.SourceLine]) -> str:
    paragraphs: list[str] = []
    for paragraph_number in sorted({line.paragraph for line in lines}):
        paragraph_lines = [
            line.english
            for line in lines
            if line.paragraph == paragraph_number and line.english
        ]
        if paragraph_lines:
            paragraphs.append(" ".join(paragraph_lines))
    return "\n\n".join(paragraphs)


def clean_prose_title(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    value = re.sub(r"\s+([.,;:!?])", r"\1", value)
    value = re.sub(r"\.{2,}$", ".", value)
    return value


def source_title(
    current_title: str, lines: list[source.SourceLine]
) -> tuple[str, str, dict[str, Any]]:
    review = re.fullmatch(r"Review (\d+)(?: to (\d+))?", current_title)
    if review:
        expected = [int(review.group(1))]
        if review.group(2):
            expected = list(range(int(review.group(1)), int(review.group(2)) + 1))
        found: list[int] = []
        for line in lines:
            match = re.match(r"\((\d+)\)", line.english)
            if match:
                found.append(int(match.group(1)))
        missing = [number for number in expected if number not in found]
        if missing:
            raise ValueError(
                f"Review title {current_title!r} is inconsistent with source; "
                f"missing lesson references {missing}"
            )
        return (
            current_title,
            "derived_review_summary_verified_against_source",
            {"expected_review_lessons": expected, "source_review_lessons": found},
        )

    match = source.best_line_sequence(current_title, lines, allow_fuzzy=True)
    if not match:
        raise ValueError(f"Could not align English title: {current_title!r}")
    matched_lines, method, score = match
    exact_title = " ".join(line.english for line in matched_lines)
    cleaned_current = clean_prose_title(current_title)
    current_has_unbalanced_brackets = (
        cleaned_current.count("[") != cleaned_current.count("]")
    )
    source_restores_divine_love = (
        "Love of God" in exact_title and "love of God" in cleaned_current
    )
    source_restores_quoted_term = (
        exact_title.count('"') == 2
        and cleaned_current.count('"') == 0
        and cleaned_current.count("'") == 2
    )
    wording_differs = source.normalize_english(cleaned_current) != source.normalize_english(
        exact_title
    )
    if (
        current_has_unbalanced_brackets
        or source_restores_divine_love
        or source_restores_quoted_term
        or wording_differs
    ):
        repaired_title = exact_title
    else:
        # Some later lesson titles are poetic lines whose source begins a new
        # line with a capital letter. In this single-line JSON field, retain
        # natural prose capitalization while verifying identical wording.
        repaired_title = cleaned_current
    verification = (
        "verified_acim_farsi_api_english_source"
        if repaired_title == exact_title
        else "verified_source_wording_with_prose_capitalization"
    )
    return (
        repaired_title,
        verification,
        {
            "method": method,
            "score": round(score, 4),
            "exact_source_title": exact_title,
            "source_span": {
                "start": [matched_lines[0].paragraph, matched_lines[0].line],
                "end": [matched_lines[-1].paragraph, matched_lines[-1].line],
            },
        },
    )


def repair_reminder(
    reminder: str, lines: list[source.SourceLine]
) -> tuple[str, list[dict[str, Any]], bool]:
    output: list[str] = []
    audit: list[dict[str, Any]] = []
    uses_editorial = False
    cursor = 0
    last_source_span: tuple[int, int] | None = None
    last_source_output_index: int | None = None

    for raw_line in reminder.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            output.append("")
            last_source_span = None
            last_source_output_index = None
            continue

        editorial = EDITORIAL_ENGLISH.get(stripped)
        if editorial is not None:
            output.append(editorial)
            uses_editorial = True
            audit.append(
                {
                    "before": raw_line,
                    "after": editorial,
                    "method": "standardized_app_editorial_text",
                    "source_span": None,
                }
            )
            last_source_span = None
            last_source_output_index = None
            continue

        match = source.best_line_sequence(raw_line, lines, cursor=cursor, allow_fuzzy=True)
        if not match:
            raise ValueError(f"Could not align reminder line: {raw_line!r}")
        matched_lines, method, score = match
        exact_source = " ".join(line.english for line in matched_lines)
        start = lines.index(matched_lines[0])
        end = lines.index(matched_lines[-1])
        cursor = end + 1
        span = (start, end)
        coalesced = False
        if (
            last_source_span is not None
            and last_source_output_index is not None
            and span[0] <= last_source_span[1]
            and last_source_span[0] <= span[1]
        ):
            merged_span = (
                min(last_source_span[0], span[0]),
                max(last_source_span[1], span[1]),
            )
            exact_source = " ".join(
                line.english for line in lines[merged_span[0] : merged_span[1] + 1]
            )
            output[last_source_output_index] = exact_source
            last_source_span = merged_span
            coalesced = True
        else:
            output.append(exact_source)
            last_source_span = span
            last_source_output_index = len(output) - 1
        audit.append(
            {
                "before": raw_line,
                "after": exact_source,
                "method": method,
                "score": round(score, 4),
                "coalesced_with_previous_source_span": coalesced,
                "source_span": {
                    "start": [matched_lines[0].paragraph, matched_lines[0].line],
                    "end": [matched_lines[-1].paragraph, matched_lines[-1].line],
                },
            }
        )

    while output and output[-1] == "":
        output.pop()
    return "\n".join(output), audit, uses_editorial


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("DB_multilingual.v3.json"))
    parser.add_argument("--output", type=Path, default=Path("DB_multilingual.v4.json"))
    parser.add_argument(
        "--report", type=Path, default=Path("DB_multilingual.english-repair-report.json")
    )
    parser.add_argument(
        "--cache-dir", type=Path, default=Path("/private/tmp/acim-farsi-api-cache")
    )
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    database = read_json(args.input)
    lessons = database.get("lessons")
    if not isinstance(lessons, list) or len(lessons) != LESSON_COUNT:
        raise ValueError("Input must contain exactly 365 lessons")

    routes = {
        number: (
            f"/workbook/lesson/{number}"
            if number <= 360
            else "/workbook/lessons-361-365"
        )
        for number in range(1, LESSON_COUNT + 1)
    }
    pages = source.fetch_pages(sorted(set(routes.values())), args.cache_dir, args.workers)

    lesson_audit: list[dict[str, Any]] = []
    title_verification_counts: Counter[str] = Counter()
    reminder_verification_counts: Counter[str] = Counter()
    reminder_method_counts: Counter[str] = Counter()
    changed_title_count = 0
    changed_reminder_count = 0
    changed_full_text_count = 0

    for lesson in lessons:
        number = int(lesson["lesson_number"])
        route = routes[number]
        page = pages[route]
        if page.get("path") != route:
            raise ValueError(f"Source path mismatch for lesson {number}")
        lines = source.page_lines(page)
        if not lines:
            raise ValueError(f"No source lines for lesson {number}")

        english = lesson["content"]["en"]
        before_title = english["title"]
        before_reminder = english["reminder_text"]
        before_full_text = english["full_text"]

        repaired_title, title_verification, title_audit = source_title(
            before_title, lines
        )
        repaired_reminder, reminder_audit, uses_editorial = repair_reminder(
            before_reminder, lines
        )
        repaired_full_text = english_full_text(lines)

        if before_title != repaired_title:
            changed_title_count += 1
        if before_reminder != repaired_reminder:
            changed_reminder_count += 1
        if before_full_text != repaired_full_text:
            changed_full_text_count += 1

        reminder_verification = (
            "verified_source_alignment_with_standardized_app_editorial_text"
            if uses_editorial
            else "verified_acim_farsi_api_english_source"
        )
        title_verification_counts[title_verification] += 1
        reminder_verification_counts[reminder_verification] += 1
        reminder_method_counts.update(item["method"] for item in reminder_audit)

        existing_verification = english.get("verification") or {}
        english.update(
            {
                "title": repaired_title,
                "reminder_text": repaired_reminder,
                "full_text": repaired_full_text,
                "verification": {
                    **existing_verification,
                    "title": title_verification,
                    "reminder_text": reminder_verification,
                    "full_text": "verified_acim_farsi_api_english_source",
                },
            }
        )

        lesson_audit.append(
            {
                "lesson_number": number,
                "source_path": route,
                "title_changed": before_title != repaired_title,
                "title_before": before_title,
                "title_after": repaired_title,
                "title_alignment": title_audit,
                "reminder_changed": before_reminder != repaired_reminder,
                "reminder_verification": reminder_verification,
                "reminder_lines": reminder_audit,
                "full_text_changed": before_full_text != repaired_full_text,
            }
        )

    generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    database["schema_version"] = 4
    database["provenance"] = {
        **database.get("provenance", {}),
        "english_source_alignment": (
            "English titles, reminder excerpts, and full text were aligned to the "
            "English lines paired with Persian translations by acim-farsi.org."
        ),
        "english_repaired_at": generated_at,
        "english_repair_script": "repair_english_content.py",
        "english_editorial_policy": (
            "Useful Android-app-only reminder headings were retained in corrected, "
            "standardized English and explicitly distinguished from source lines."
        ),
    }

    report = {
        "generated_at": generated_at,
        "input": str(args.input),
        "output": str(args.output),
        "source": source.BASE_URL,
        "summary": {
            "lesson_count": len(lessons),
            "titles_changed": changed_title_count,
            "reminders_changed": changed_reminder_count,
            "full_texts_changed": changed_full_text_count,
            "title_verification_counts": dict(sorted(title_verification_counts.items())),
            "reminder_verification_counts": dict(
                sorted(reminder_verification_counts.items())
            ),
            "reminder_line_method_counts": dict(sorted(reminder_method_counts.items())),
            "unmatched_title_count": 0,
            "unmatched_reminder_line_count": 0,
        },
        "lessons": lesson_audit,
    }

    write_json(args.output, database)
    write_json(args.report, report)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
