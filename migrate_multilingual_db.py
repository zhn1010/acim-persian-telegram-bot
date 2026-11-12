#!/usr/bin/env python3
"""Migrate the legacy multilingual ACIM database to a canonical v2 schema."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any


LESSON_COUNT = 365
REMINDER_SEPARATOR = "\n\n...................\n\n"
EXPECTED_SCHEDULE_COUNTS = {
    "interval": 248,
    "times_per_day": 40,
    "times_per_hour": 4,
    "user_specified": 73,
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def string_field(record: dict[str, Any], field: str, language: str) -> str:
    container = record.get(field)
    if not isinstance(container, dict):
        return ""
    value = container.get(language, "")
    return value if isinstance(value, str) else ""


def optional_string(value: str) -> str | None:
    stripped = value.strip()
    return stripped if stripped else None


def normalize_english(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def select_main_record(
    lesson_number: int,
    records: list[dict[str, Any]],
    canonical_title: str,
    canonical_reminder: str,
) -> tuple[int, str, list[dict[str, Any]]]:
    """Select the actual lesson record from legacy arrays containing supplements."""

    if len(records) == 1:
        return 0, "single_record", [{"index": 0, "score": 0, "reasons": ["single_record"]}]

    scored: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        score = 0
        reasons: list[str] = []
        persian_urls = " ".join(
            [
                string_field(record, "textAddress", "fa"),
                string_field(record, "audioAddress", "fa"),
            ]
        ).lower()

        if re.search(rf"/lesson/{lesson_number}(?:[./]|$)", persian_urls):
            score += 100
            reasons.append("persian_lesson_url")
        if lesson_number >= 361 and "lessons-361-365" in persian_urls:
            score += 90
            reasons.append("persian_lesson_range")
        if "review-" in persian_urls or "/epilogue" in persian_urls:
            score -= 60
            reasons.append("supplemental_url")

        legacy_reminder = string_field(record, "repetitionText", "en")
        if normalize_english(legacy_reminder) == normalize_english(canonical_reminder):
            score += 30
            reasons.append("canonical_reminder_match")

        legacy_full_text = string_field(record, "text", "en")
        if normalize_english(legacy_full_text).startswith(normalize_english(canonical_title)):
            score += 20
            reasons.append("full_text_starts_with_canonical_title")

        scored.append({"index": index, "score": score, "reasons": reasons})

    ranked = sorted(scored, key=lambda item: (item["score"], item["index"]), reverse=True)
    if len(ranked) > 1 and ranked[0]["score"] == ranked[1]["score"]:
        raise ValueError(
            f"Ambiguous main-record selection for lesson {lesson_number}: {ranked[:2]}"
        )

    selected = ranked[0]
    reason = "+".join(selected["reasons"]) or "highest_heuristic_score"
    return int(selected["index"]), reason, ranked


def schedule_option(label: str) -> dict[str, Any]:
    times_match = re.fullmatch(r"(\d+) times", label)
    if times_match:
        return {"kind": "times_per_day", "count": int(times_match.group(1))}

    minutes_match = re.fullmatch(r"(\d+) minutes", label)
    if minutes_match:
        return {"kind": "interval", "minutes": int(minutes_match.group(1))}

    if label == "every hour":
        return {"kind": "interval", "minutes": 60}

    hours_match = re.fullmatch(r"every (\d+) hours", label)
    if hours_match:
        return {"kind": "interval", "minutes": int(hours_match.group(1)) * 60}

    raise ValueError(f"Unsupported canonical schedule label: {label!r}")


def verification_map(
    *,
    title: str,
    reminder_text: str,
    full_text: str,
    text_url: str,
    audio_url: str,
) -> dict[str, str]:
    return {
        "title": title,
        "reminder_text": reminder_text,
        "full_text": full_text,
        "text_url": text_url,
        "audio_url": audio_url,
    }


def language_content(
    *,
    title: str | None,
    reminder_text: str | None,
    full_text: str | None,
    text_url: str | None,
    audio_url: str | None,
    verification: dict[str, str],
) -> dict[str, Any]:
    return {
        "title": title,
        "reminder_text": reminder_text,
        "full_text": full_text,
        "text_url": text_url,
        "audio_url": audio_url,
        "verification": verification,
    }


def supplemental_kind(day_key: int, record: dict[str, Any]) -> tuple[str, str]:
    if day_key == 0:
        return "workbook_introduction", "Workbook Introduction"

    urls = " ".join(
        [
            string_field(record, "textAddress", "en"),
            string_field(record, "textAddress", "fa"),
            string_field(record, "audioAddress", "en"),
            string_field(record, "audioAddress", "fa"),
        ]
    ).lower()
    if "epilogue" in urls:
        return "epilogue", "Epilogue"
    if "review" in urls:
        return "review_introduction", "Review Introduction"
    return "supplemental", "Supplemental Section"


def build_supplement(
    *, day_key: int, record_index: int, record: dict[str, Any]
) -> dict[str, Any]:
    kind, english_title = supplemental_kind(day_key, record)
    supplement_id = f"supplement-{day_key:03d}-{record_index}"
    return {
        "id": supplement_id,
        "kind": kind,
        "anchor_lesson": 1 if day_key == 0 else day_key,
        "content": {
            "en": language_content(
                title=english_title,
                reminder_text=None,
                full_text=optional_string(string_field(record, "text", "en")),
                text_url=optional_string(string_field(record, "textAddress", "en")),
                audio_url=optional_string(string_field(record, "audioAddress", "en")),
                verification=verification_map(
                    title="standardized",
                    reminder_text="not_applicable",
                    full_text="legacy_unverified",
                    text_url="legacy_unverified",
                    audio_url="legacy_unverified",
                ),
            ),
            "fa": language_content(
                title=optional_string(string_field(record, "title", "fa")),
                reminder_text=None,
                full_text=optional_string(string_field(record, "text", "fa")),
                text_url=optional_string(string_field(record, "textAddress", "fa")),
                audio_url=optional_string(string_field(record, "audioAddress", "fa")),
                verification=verification_map(
                    title="legacy_unverified",
                    reminder_text="not_applicable",
                    full_text="legacy_unverified",
                    text_url="legacy_unverified",
                    audio_url="legacy_unverified",
                ),
            ),
        },
        "legacy_location": {"day_key": day_key, "record_index": record_index},
    }


def contains_non_finite(value: Any) -> bool:
    if isinstance(value, float):
        return not math.isfinite(value)
    if isinstance(value, dict):
        return any(contains_non_finite(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_non_finite(item) for item in value)
    return False


def contains_nan_sentinel(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() == "nan"
    if isinstance(value, dict):
        return any(contains_nan_sentinel(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_nan_sentinel(item) for item in value)
    return False


def migrate(
    legacy_path: Path, canonical_path: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    legacy = read_json(legacy_path)
    canonical = read_json(canonical_path)

    if set(legacy) != {str(number) for number in range(0, LESSON_COUNT + 1)}:
        raise ValueError("Legacy database must have numeric keys 0 through 365")
    if canonical.get("lesson_count") != LESSON_COUNT:
        raise ValueError("Canonical extraction must contain 365 lessons")

    canonical_lessons = canonical["lessons"]
    if [item["lesson_number"] for item in canonical_lessons] != list(
        range(1, LESSON_COUNT + 1)
    ):
        raise ValueError("Canonical lessons must be sequential from 1 through 365")

    selections: dict[int, dict[str, Any]] = {}
    for canonical_lesson in canonical_lessons:
        lesson_number = canonical_lesson["lesson_number"]
        canonical_title, canonical_reminder = canonical_lesson["reminder_text"].split(
            REMINDER_SEPARATOR, 1
        )
        records = legacy[str(lesson_number)]
        selected_index, reason, ranked = select_main_record(
            lesson_number, records, canonical_title, canonical_reminder
        )
        selections[lesson_number] = {
            "index": selected_index,
            "reason": reason,
            "ranked_candidates": ranked,
        }

    supplemental_sections: list[dict[str, Any]] = []
    lesson_supplements: dict[int, list[str]] = {
        number: [] for number in range(1, LESSON_COUNT + 1)
    }

    introduction = build_supplement(day_key=0, record_index=0, record=legacy["0"][0])
    supplemental_sections.append(introduction)
    lesson_supplements[1].append(introduction["id"])

    for lesson_number in range(1, LESSON_COUNT + 1):
        selected_index = selections[lesson_number]["index"]
        for record_index, record in enumerate(legacy[str(lesson_number)]):
            if record_index == selected_index:
                continue
            supplement = build_supplement(
                day_key=lesson_number,
                record_index=record_index,
                record=record,
            )
            supplemental_sections.append(supplement)
            lesson_supplements[lesson_number].append(supplement["id"])

    migrated_lessons: list[dict[str, Any]] = []
    lesson_report: list[dict[str, Any]] = []
    schedule_counts: Counter[str] = Counter()
    title_replacements = 0
    reminder_replacements = 0

    for canonical_lesson in canonical_lessons:
        lesson_number = canonical_lesson["lesson_number"]
        canonical_title, canonical_reminder = canonical_lesson["reminder_text"].split(
            REMINDER_SEPARATOR, 1
        )
        schedule_type = canonical_lesson["schedule_type"]
        schedule_counts[schedule_type] += 1

        selection = selections[lesson_number]
        main_record = legacy[str(lesson_number)][selection["index"]]

        if lesson_number == 1:
            prior_record = legacy["0"][0]
            prior_location = {"day_key": 0, "record_index": 0}
        else:
            prior_selection = selections[lesson_number - 1]
            prior_record = legacy[str(lesson_number - 1)][prior_selection["index"]]
            prior_location = {
                "day_key": lesson_number - 1,
                "record_index": prior_selection["index"],
            }

        legacy_title = string_field(main_record, "title", "en")
        legacy_reminder = string_field(main_record, "repetitionText", "en")
        title_changed = normalize_english(legacy_title) != normalize_english(canonical_title)
        reminder_changed = normalize_english(legacy_reminder) != normalize_english(
            canonical_reminder
        )
        title_replacements += int(title_changed)
        reminder_replacements += int(reminder_changed)

        migrated_lessons.append(
            {
                "lesson_number": lesson_number,
                "schedule": {
                    "type": schedule_type,
                    "course_specified_options": [
                        schedule_option(label)
                        for label in canonical_lesson["course_specified_schedules"]
                    ],
                },
                "content": {
                    "en": language_content(
                        title=canonical_title,
                        reminder_text=canonical_reminder,
                        full_text=optional_string(string_field(main_record, "text", "en")),
                        text_url=optional_string(
                            string_field(prior_record, "textAddress", "en")
                        ),
                        audio_url=optional_string(
                            string_field(main_record, "audioAddress", "en")
                        ),
                        verification=verification_map(
                            title="verified_acim_alerts",
                            reminder_text="verified_acim_alerts",
                            full_text="legacy_unverified",
                            text_url="legacy_shifted_unverified",
                            audio_url="legacy_unverified",
                        ),
                    ),
                    "fa": language_content(
                        title=optional_string(string_field(main_record, "title", "fa")),
                        reminder_text=optional_string(
                            string_field(main_record, "repetitionText", "fa")
                        ),
                        full_text=optional_string(string_field(main_record, "text", "fa")),
                        text_url=optional_string(
                            string_field(main_record, "textAddress", "fa")
                        ),
                        audio_url=optional_string(
                            string_field(main_record, "audioAddress", "fa")
                        ),
                        verification=verification_map(
                            title="legacy_unverified",
                            reminder_text="legacy_unverified",
                            full_text="legacy_unverified",
                            text_url="legacy_unverified",
                            audio_url="legacy_unverified",
                        ),
                    ),
                },
                "supplemental_section_ids": lesson_supplements[lesson_number],
                "legacy_locations": {
                    "main_record": {
                        "day_key": lesson_number,
                        "record_index": selection["index"],
                    },
                    "shifted_english_url_source": prior_location,
                },
            }
        )

        lesson_report.append(
            {
                "lesson_number": lesson_number,
                "legacy_record_count": len(legacy[str(lesson_number)]),
                "selected_record_index": selection["index"],
                "selection_reason": selection["reason"],
                "title_replaced": title_changed,
                "reminder_replaced": reminder_changed,
                "schedule_replaced": True,
                "supplemental_records_moved": len(lesson_supplements[lesson_number]),
            }
        )

    migrated = {
        "schema_version": 2,
        "lesson_count": LESSON_COUNT,
        "languages": ["en", "fa"],
        "provenance": {
            "canonical_english_title_reminder_and_schedule": canonical_path.name,
            "legacy_multilingual_content": legacy_path.name,
            "policy": (
                "English titles, reminder texts, and schedules are authoritative. "
                "Preserved legacy fields remain explicitly unverified."
            ),
        },
        "lessons": migrated_lessons,
        "supplemental_sections": supplemental_sections,
    }

    report = {
        "schema_version": 1,
        "source_files": {
            "legacy": legacy_path.name,
            "canonical": canonical_path.name,
        },
        "summary": {
            "legacy_top_level_keys": len(legacy),
            "legacy_records": sum(len(records) for records in legacy.values()),
            "migrated_lessons": len(migrated_lessons),
            "supplemental_sections": len(supplemental_sections),
            "english_titles_replaced": title_replacements,
            "english_reminders_replaced": reminder_replacements,
            "schedules_replaced": LESSON_COUNT,
            "schedule_type_counts": dict(sorted(schedule_counts.items())),
            "legacy_contains_non_finite_values": contains_non_finite(legacy),
        },
        "lessons": lesson_report,
    }

    validate_migration(migrated, report)
    return migrated, report


def validate_migration(migrated: dict[str, Any], report: dict[str, Any]) -> None:
    lessons = migrated["lessons"]
    if len(lessons) != LESSON_COUNT:
        raise ValueError("Migrated database must contain 365 lessons")
    if [lesson["lesson_number"] for lesson in lessons] != list(
        range(1, LESSON_COUNT + 1)
    ):
        raise ValueError("Migrated lesson numbers are not sequential")

    schedule_counts = Counter(lesson["schedule"]["type"] for lesson in lessons)
    if dict(schedule_counts) != EXPECTED_SCHEDULE_COUNTS:
        raise ValueError(f"Unexpected schedule counts: {dict(schedule_counts)}")

    if contains_non_finite(migrated) or contains_non_finite(report):
        raise ValueError("Migration produced a non-finite numeric value")
    if contains_nan_sentinel(migrated) or contains_nan_sentinel(report):
        raise ValueError("Migration produced a legacy 'nan' sentinel")

    if any(not lesson["content"]["en"]["title"] for lesson in lessons):
        raise ValueError("Every lesson must have a verified English title")
    if any(not lesson["content"]["en"]["reminder_text"] for lesson in lessons):
        raise ValueError("Every lesson must have a verified English reminder")

    lesson_25 = lessons[24]
    if lesson_25["content"]["en"]["title"] != "I do not know what anything is for.":
        raise ValueError("Lesson 25 title failed validation")
    if lesson_25["schedule"]["course_specified_options"] != [
        {"kind": "times_per_day", "count": 6}
    ]:
        raise ValueError("Lesson 25 schedule failed validation")

    supplement_ids = [item["id"] for item in migrated["supplemental_sections"]]
    if len(supplement_ids) != len(set(supplement_ids)):
        raise ValueError("Supplemental section IDs must be unique")

    referenced_supplements = [
        supplement_id
        for lesson in lessons
        for supplement_id in lesson["supplemental_section_ids"]
    ]
    if sorted(referenced_supplements) != sorted(supplement_ids):
        raise ValueError("Every supplemental section must be referenced exactly once")

    for lesson in lessons:
        schedule = lesson["schedule"]
        options = schedule["course_specified_options"]
        if schedule["type"] == "user_specified" and options:
            raise ValueError("User-specified lessons cannot contain course options")
        if schedule["type"] != "user_specified" and not options:
            raise ValueError("Course-specified lessons must contain schedule options")


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy", type=Path, default=Path("DB_multilingual.json"))
    parser.add_argument("--canonical", type=Path, default=Path("acim_lessons.json"))
    parser.add_argument(
        "--output", type=Path, default=Path("DB_multilingual.v2.json")
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("DB_multilingual.migration-report.json"),
    )
    args = parser.parse_args()

    migrated, report = migrate(args.legacy, args.canonical)
    write_json(args.output, migrated)
    write_json(args.report, report)


if __name__ == "__main__":
    main()
