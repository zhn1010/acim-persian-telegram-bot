#!/usr/bin/env python3
"""Build the English ACIM Alerts lesson dataset from JADX output."""

from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path


EXPECTED_LESSON_COUNT = 365
EXPECTED_TYPE_COUNTS = {
    "OneInterval": 248,
    "TimesPerDay": 40,
    "TimesPerHour": 4,
    "UserSpecified": 73,
}

INTERVAL_LABELS = {
    8: "8 minutes",
    10: "10 minutes",
    12: "12 minutes",
    15: "15 minutes",
    20: "20 minutes",
    30: "30 minutes",
    45: "45 minutes",
    60: "every hour",
    120: "every 2 hours",
    180: "every 3 hours",
    240: "every 4 hours",
    300: "every 5 hours",
    360: "every 6 hours",
}

# These are the exact menu choices highlighted by the app for each
# "TimesPerHour" course instruction.
TIMES_PER_HOUR_LABELS = {
    "5or6": ["10 minutes", "12 minutes"],
    "6or7": ["8 minutes", "10 minutes"],
    "3or4": ["15 minutes", "20 minutes"],
    "1or2": ["30 minutes", "every hour"],
}

SCHEDULE_TYPE_NAMES = {
    "OneInterval": "interval",
    "TimesPerDay": "times_per_day",
    "TimesPerHour": "times_per_hour",
    "UserSpecified": "user_specified",
}


def android_unescape(value: str) -> str:
    """Decode Android XML string escapes while preserving ordinary text."""

    pattern = re.compile(r"\\(u[0-9a-fA-F]{4}|n|r|t|\\|'|\")")

    def replace(match: re.Match[str]) -> str:
        token = match.group(1)
        if token.startswith("u"):
            return chr(int(token[1:], 16))
        return {
            "n": "\n",
            "r": "\r",
            "t": "\t",
            "\\": "\\",
            "'": "'",
            '"': '"',
        }[token]

    return pattern.sub(replace, value)


def load_array(arrays_path: Path, name: str) -> list[str]:
    root = ET.parse(arrays_path).getroot()
    array = root.find(f"./array[@name='{name}']")
    if array is None:
        raise ValueError(f"Missing array {name!r} in {arrays_path}")

    values: list[str] = []
    for item in array.findall("item"):
        raw = "".join(item.itertext())
        values.append(android_unescape(raw))
    return values


def parse_schedule_map(java_path: Path) -> dict[int, tuple[str, str | int | None]]:
    source = java_path.read_text(encoding="utf-8")
    entry_pattern = re.compile(
        r'f\s+(fVar\d+)\s*=\s*new f\("([^"]+)",\s*"(\d+)"\);'
        r"(.*?)f6669d\.add\(\1\);",
        re.DOTALL,
    )

    schedules: dict[int, tuple[str, str | int | None]] = {}
    for match in entry_pattern.finditer(source):
        variable, schedule_type, lesson_text, body = match.groups()
        lesson_number = int(lesson_text)

        if schedule_type == "OneInterval":
            value_match = re.search(rf"{variable}\.h\((\d+)\)", body)
            value: str | int | None = int(value_match.group(1)) if value_match else None
        elif schedule_type == "TimesPerDay":
            value_match = re.search(rf'{variable}\.j\("([^"]+)"\)', body)
            value = value_match.group(1) if value_match else None
        elif schedule_type == "TimesPerHour":
            value_match = re.search(rf'{variable}\.k\("([^"]+)"\)', body)
            value = value_match.group(1) if value_match else None
        elif schedule_type == "UserSpecified":
            value = None
        else:
            raise ValueError(f"Unexpected schedule type for lesson {lesson_number}: {schedule_type}")

        if lesson_number in schedules:
            raise ValueError(f"Duplicate mapping for lesson {lesson_number}")
        schedules[lesson_number] = (schedule_type, value)

    expected_lessons = set(range(1, EXPECTED_LESSON_COUNT + 1))
    actual_lessons = set(schedules)
    if actual_lessons != expected_lessons:
        missing = sorted(expected_lessons - actual_lessons)
        extra = sorted(actual_lessons - expected_lessons)
        raise ValueError(f"Invalid lesson mapping; missing={missing}, extra={extra}")

    type_counts = Counter(schedule_type for schedule_type, _ in schedules.values())
    if dict(type_counts) != EXPECTED_TYPE_COUNTS:
        raise ValueError(f"Unexpected schedule counts: {dict(type_counts)}")

    return schedules


def times_per_day_labels(value: str) -> list[str]:
    match = re.fullmatch(r"(\d+)(?:or(\d+))?", value)
    if not match:
        raise ValueError(f"Unexpected TimesPerDay value: {value!r}")
    numbers = [int(match.group(1))]
    if match.group(2):
        numbers.append(int(match.group(2)))
    return [f"{number} times" for number in numbers]


def schedule_labels(schedule_type: str, value: str | int | None) -> list[str]:
    if schedule_type == "OneInterval":
        if not isinstance(value, int) or value not in INTERVAL_LABELS:
            raise ValueError(f"Unexpected OneInterval value: {value!r}")
        return [INTERVAL_LABELS[value]]
    if schedule_type == "TimesPerDay":
        if not isinstance(value, str):
            raise ValueError(f"Unexpected TimesPerDay value: {value!r}")
        return times_per_day_labels(value)
    if schedule_type == "TimesPerHour":
        if not isinstance(value, str) or value not in TIMES_PER_HOUR_LABELS:
            raise ValueError(f"Unexpected TimesPerHour value: {value!r}")
        return TIMES_PER_HOUR_LABELS[value]
    if schedule_type == "UserSpecified":
        return []
    raise ValueError(f"Unexpected schedule type: {schedule_type}")


def build_dataset(jadx_dir: Path) -> dict[str, object]:
    arrays_path = jadx_dir / "resources/res/values/arrays.xml"
    java_path = jadx_dir / "sources/org/cdesolutions/acimworkbookwithreminders/d.java"

    lesson_titles = load_array(arrays_path, "lesson_titles")
    reminder_bodies = load_array(arrays_path, "reminder_texts")
    schedules = parse_schedule_map(java_path)

    required_array_size = EXPECTED_LESSON_COUNT + 1
    if len(lesson_titles) != required_array_size or len(reminder_bodies) != required_array_size:
        raise ValueError(
            "Lesson resource arrays are incomplete: "
            f"titles={len(lesson_titles)}, reminders={len(reminder_bodies)}"
        )

    lessons: list[dict[str, object]] = []
    for lesson_number in range(1, EXPECTED_LESSON_COUNT + 1):
        raw_type, raw_value = schedules[lesson_number]
        title = lesson_titles[lesson_number]
        body = reminder_bodies[lesson_number]
        reminder_text = f"{title}\n\n...................\n\n{body}"
        lessons.append(
            {
                "lesson_number": lesson_number,
                "schedule_type": SCHEDULE_TYPE_NAMES[raw_type],
                "course_specified_schedules": schedule_labels(raw_type, raw_value),
                "reminder_text": reminder_text,
            }
        )

    return {
        "source": "ACIM Alerts with Workbook Android application",
        "language": "en",
        "lesson_count": EXPECTED_LESSON_COUNT,
        "lessons": lessons,
    }


def validate_dataset(dataset: dict[str, object]) -> None:
    lessons = dataset["lessons"]
    if not isinstance(lessons, list) or len(lessons) != EXPECTED_LESSON_COUNT:
        raise ValueError("Dataset must contain exactly 365 lessons")

    numbers = [lesson["lesson_number"] for lesson in lessons]
    if numbers != list(range(1, EXPECTED_LESSON_COUNT + 1)):
        raise ValueError("Lesson numbers are not sequential from 1 through 365")

    lesson_25 = lessons[24]
    if lesson_25["course_specified_schedules"] != ["6 times"]:
        raise ValueError("Lesson 25 schedule does not match the app")
    if not str(lesson_25["reminder_text"]).startswith(
        "I do not know what anything is for.\n\n...................\n\n"
    ):
        raise ValueError("Lesson 25 reminder text does not match the app")

    user_specified = [
        lesson
        for lesson in lessons
        if lesson["schedule_type"] == "user_specified"
    ]
    if len(user_specified) != EXPECTED_TYPE_COUNTS["UserSpecified"]:
        raise ValueError("Unexpected user-specified lesson count")
    if any(lesson["course_specified_schedules"] for lesson in user_specified):
        raise ValueError("User-specified lessons must have empty schedule arrays")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--jadx-dir",
        type=Path,
        default=Path("/private/tmp/acim-jadx"),
        help="Directory containing JADX sources and resources",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("acim_lessons.json"),
        help="Destination JSON file",
    )
    args = parser.parse_args()

    dataset = build_dataset(args.jadx_dir)
    validate_dataset(dataset)
    args.output.write_text(
        json.dumps(dataset, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
