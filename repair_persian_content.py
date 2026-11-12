#!/usr/bin/env python3
"""Repair Persian ACIM lesson data from the authoritative acim-farsi.org API.

The script deliberately keeps the canonical English reminder text and schedules
from the Android extraction. Persian reminder excerpts are rebuilt only from
English/Persian line pairs returned by acim-farsi.org; no machine translation is
used.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime as dt
import difflib
import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


BASE_URL = "https://acim-farsi.org"
API_URL = f"{BASE_URL}/api/page/current"
LESSON_COUNT = 365
USER_AGENT = "ACIM-Alerts-Persian-Repair/1.0"
PERSIAN_DIGITS = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")
EDITORIAL_PERSIAN = {
    "Farther away ………": "دورتر ………",
    "Shorter Practice Periods:": "دوره‌های تمرین کوتاه‌تر:",
    "Longer Practice Periods:": "دوره‌های تمرین طولانی‌تر:",
    "Shorter Practice:": "تمرین کوتاه‌تر:",
    "Longer Practice:": "تمرین طولانی‌تر:",
    "Watch thoughts ………": "افکار را مشاهده کن ………",
    "Review some of the external places you have looked for salvation ………": (
        "برخی از جاهای بیرونی را که در آن‌ها به دنبال رستگاری بوده‌ای مرور کن ………"
    ),
    "Add related thoughts, such as:": "افکار مرتبطی اضافه کن، مانند:",
    "For conflict thoughts that may cross your mind:": (
        "برای افکار تعارض‌آمیزی که ممکن است از ذهنت بگذرند:"
    ),
    "For particularly difficult one's tell yourself:": (
        "برای مواردی که به‌طور خاص دشوارند، به خودت بگو:"
    ),
    "Give thanks, etc. Then say:": "سپاسگزاری کن و سپس بگو:",
    "For disturbing situations or should you become angry:": (
        "برای موقعیت‌های آشفته‌کننده، یا اگر خشمگین شدی:"
    ),
    "Close eyes:": "چشم‌هایت را ببند:",
    "And remind yourself of this between the times you give five minutes:": (
        "و در فاصلهٔ میان زمان‌هایی که پنج دقیقه اختصاص می‌دهی، این را به خود یادآوری کن:"
    ),
    "If you are tempted to believe doubt and fear:": (
        "اگر وسوسه شدی که تردید و ترس را باور کنی:"
    ),
    "As often as you can:": "تا جایی که می‌توانی:",
    "And as often as is possible:": "و هر چند بار که ممکن است:",
    "To everyone I offer _____.  For example:  To everyone I offer quietness.": (
        "به همه _____ را عرضه می‌کنم. برای نمونه: به همه آرامش را عرضه می‌کنم."
    ),
    "And as often as possible:": "و هر چند بار که ممکن است:",
    "Dismiss temptation whenever it arises by saying:": (
        "هر زمان وسوسه پدیدار شد، با گفتن این جمله آن را کنار بگذار:"
    ),
    "And remember often:": "و بارها به یاد بیاور:",
    "Say the above throughout the day and whenever tempted.": (
        "عبارت بالا را در طول روز و هر زمان که وسوسه شدی بگو."
    ),
    "Throughout the day and when you forget forgivenesses meaning:": (
        "در طول روز و هر زمان که معنای بخشایش را فراموش کردی:"
    ),
    "For example, I do not see a neutral wall, because my thoughts about walls are not neutral.": (
        "برای نمونه، من یک دیوار خنثی نمی‌بینم، زیرا افکارم در مورد دیوارها خنثی نیستند."
    ),
    "For thoughts of grievance:  Love holds no grievances. Let me not betray my Self.": (
        "برای افکار گلایه‌آمیز: عشق هیچ گلایه‌ای را نگه نمی‌دارد. "
        "بگذار خویشتن* خود را فریب ندهم."
    ),
    "Several times an hour:  Love holds no grievances. I would wake to my Self by laying all my grievances aside and wakening in Him.": (
        "چند بار در هر ساعت: عشق هیچ گلایه‌ای را نگه نمی‌دارد. "
        "من می‌خواهم با کنار گذاشتن همه‌ی گلایه‌هایم و بیدار شدن در او*، "
        "به خویشتنم* بیدار شوم."
    ),
}


@dataclasses.dataclass(frozen=True)
class SourceLine:
    paragraph: int
    line: int
    style: str
    english: str
    persian: str
    translation_state: str | None


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def normalize_english(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = value.replace("’", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def words(value: str) -> list[str]:
    normalized = normalize_english(value)
    return normalized.split() if normalized else []


def api_cache_name(route: str) -> str:
    return route.strip("/").replace("/", "__") + ".json"


def request_json(route: str, cache_dir: Path, retries: int = 3) -> dict[str, Any]:
    cache_file = cache_dir / api_cache_name(route)
    if cache_file.exists():
        cached = read_json(cache_file)
        if isinstance(cached, dict) and isinstance(cached.get("page"), dict):
            return cached

    query = urllib.parse.urlencode({"path": route})
    request = urllib.request.Request(
        f"{API_URL}?{query}", headers={"User-Agent": USER_AGENT}
    )
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
            if not isinstance(payload, dict) or not isinstance(payload.get("page"), dict):
                raise ValueError(f"API returned no page for {route}")
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            write_json(cache_file, payload)
            return payload
        except (OSError, ValueError, json.JSONDecodeError) as error:
            last_error = error
            if attempt + 1 < retries:
                time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {route}: {last_error}")


def page_lines(page: dict[str, Any]) -> list[SourceLine]:
    result: list[SourceLine] = []
    paragraphs = page.get("paragraphs") or {}
    for paragraph in sorted(paragraphs.values(), key=lambda item: item.get("nr", 0)):
        paragraph_number = int(paragraph.get("nr", 0))
        lines = paragraph.get("lines") or {}
        for line in sorted(lines.values(), key=lambda item: item.get("nr", 0)):
            translation = line.get("translation") or {}
            result.append(
                SourceLine(
                    paragraph=paragraph_number,
                    line=int(line.get("nr", 0)),
                    style=str(line.get("style") or ""),
                    english=clean_text(str(line.get("content") or "")),
                    persian=clean_text(str(translation.get("content") or "")),
                    translation_state=(
                        str(translation.get("state"))
                        if translation.get("state") is not None
                        else None
                    ),
                )
            )
    return result


def translated_full_text(lines: list[SourceLine]) -> str:
    paragraphs: list[str] = []
    for paragraph_number in sorted({line.paragraph for line in lines}):
        paragraph_lines = [
            line.persian
            for line in lines
            if line.paragraph == paragraph_number and line.persian
        ]
        if paragraph_lines:
            paragraphs.append(" ".join(paragraph_lines))
    return "\n\n".join(paragraphs)


def line_sequences(lines: list[SourceLine], maximum: int = 16) -> Iterable[tuple[int, int, str]]:
    for start in range(len(lines)):
        combined: list[str] = []
        for end in range(start, min(len(lines), start + maximum)):
            combined.append(lines[end].english)
            yield start, end, normalize_english(" ".join(combined))


def best_line_sequence(
    english: str,
    lines: list[SourceLine],
    *,
    cursor: int = 0,
    allow_fuzzy: bool = True,
) -> tuple[list[SourceLine], str, float] | None:
    target = normalize_english(english)
    if not target:
        return None

    exact: list[tuple[int, int]] = []
    for start, end, candidate in line_sequences(lines):
        if candidate == target:
            exact.append((start, end))
    if exact:
        start, end = min(exact, key=lambda pair: (pair[0] < cursor, abs(pair[0] - cursor)))
        return lines[start : end + 1], "exact_source_lines", 1.0

    target_words = words(english)
    flat: list[tuple[str, int]] = []
    for index, line in enumerate(lines):
        flat.extend((word, index) for word in words(line.english))
    if target_words and len(target_words) <= len(flat):
        for offset in range(0, len(flat) - len(target_words) + 1):
            if [item[0] for item in flat[offset : offset + len(target_words)]] == target_words:
                start = flat[offset][1]
                end = flat[offset + len(target_words) - 1][1]
                return lines[start : end + 1], "exact_token_span", 1.0

    if not allow_fuzzy:
        return None

    best: tuple[float, int, int] | None = None
    for start, end, candidate in line_sequences(lines):
        score = difflib.SequenceMatcher(None, target, candidate).ratio()
        if best is None or score > best[0]:
            best = (score, start, end)
    if best and best[0] >= 0.94:
        score, start, end = best
        return lines[start : end + 1], "fuzzy_source_lines", score
    if best and re.search(r"\(\d+\)", english) and best[0] >= 0.82:
        score, start, end = best
        return lines[start : end + 1], "review_reference_substitution", score
    if best and best[0] >= 0.78:
        score, start, end = best
        return lines[start : end + 1], "source_line_expansion", score
    return None


def persian_review_title(english_title: str) -> str | None:
    match = re.fullmatch(r"Review (\d+)(?: to (\d+))?", english_title)
    if not match:
        return None
    first = match.group(1).translate(PERSIAN_DIGITS)
    second = match.group(2)
    if second is None:
        return f"مرور ({first})"
    second_fa = second.translate(PERSIAN_DIGITS)
    connector = " و " if int(second) - int(match.group(1)) == 1 else " تا "
    return f"مرور ({first}{connector}{second_fa})"


def repair_title(english_title: str, lines: list[SourceLine]) -> tuple[str, str, float]:
    review_title = persian_review_title(english_title)
    if review_title:
        return review_title, "derived_from_verified_review_range", 1.0
    match = best_line_sequence(english_title, lines, allow_fuzzy=True)
    if not match:
        raise ValueError(f"Could not align title: {english_title!r}")
    matched_lines, method, score = match
    persian = " ".join(line.persian for line in matched_lines if line.persian)
    if not persian:
        raise ValueError(f"Aligned title has no Persian translation: {english_title!r}")
    verification = (
        "verified_acim_farsi_api_alignment"
        if method != "fuzzy_source_lines"
        else "fuzzy_acim_farsi_api_alignment"
    )
    return persian, verification, score


def repair_reminder(
    english_reminder: str,
    lines: list[SourceLine],
) -> tuple[str | None, dict[str, Any]]:
    output: list[str] = []
    matches: list[dict[str, Any]] = []
    failures: list[str] = []
    uses_editorial_translation = False
    cursor = 0
    for raw_line in english_reminder.splitlines():
        if not raw_line.strip():
            output.append("")
            continue
        editorial = EDITORIAL_PERSIAN.get(raw_line.strip())
        if editorial:
            output.append(editorial)
            uses_editorial_translation = True
            matches.append(
                {
                    "english": raw_line,
                    "method": "standardized_editorial_translation",
                    "score": None,
                    "source_span": None,
                }
            )
            continue
        match = best_line_sequence(raw_line, lines, cursor=cursor, allow_fuzzy=True)
        if not match:
            failures.append(raw_line)
            output.append("")
            continue
        source_lines, method, score = match
        persian = " ".join(line.persian for line in source_lines if line.persian)
        if not persian:
            failures.append(raw_line)
            output.append("")
            continue
        output.append(persian)
        start = lines.index(source_lines[0])
        end = lines.index(source_lines[-1])
        cursor = end + 1
        matches.append(
            {
                "english": raw_line,
                "method": method,
                "score": round(score, 4),
                "source_span": {
                    "start": [source_lines[0].paragraph, source_lines[0].line],
                    "end": [source_lines[-1].paragraph, source_lines[-1].line],
                },
            }
        )

    while output and output[-1] == "":
        output.pop()
    metadata = {
        "line_count": sum(1 for line in english_reminder.splitlines() if line.strip()),
        "matched_line_count": len(matches),
        "matches": matches,
        "unmatched_english_lines": failures,
        "uses_standardized_editorial_translation": uses_editorial_translation,
    }
    if failures:
        return None, metadata
    return "\n".join(output), metadata


def audio_status(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = int(response.status)
            content_type = response.headers.get("Content-Type", "")
            length_value = response.headers.get("Content-Length")
            length = int(length_value) if length_value and length_value.isdigit() else None
            ready = status == 200 and content_type.lower().startswith("audio/")
            return {
                "ready": ready,
                "http_status": status,
                "content_type": content_type,
                "content_length": length,
            }
    except urllib.error.HTTPError as error:
        return {
            "ready": False,
            "http_status": int(error.code),
            "content_type": error.headers.get("Content-Type", "") if error.headers else "",
            "content_length": None,
        }
    except OSError as error:
        return {
            "ready": False,
            "http_status": None,
            "content_type": "",
            "content_length": None,
            "error": str(error),
        }


def absolute_url(value: str | None) -> str | None:
    if not value:
        return None
    return urllib.parse.urljoin(BASE_URL, value)


def route_from_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.netloc and parsed.netloc != "acim-farsi.org":
        raise ValueError(f"Unexpected Persian source host: {value}")
    if not parsed.path.startswith("/workbook/"):
        raise ValueError(f"Unexpected Persian workbook path: {value}")
    return parsed.path


def fetch_pages(routes: list[str], cache_dir: Path, workers: int) -> dict[str, dict[str, Any]]:
    pages: dict[str, dict[str, Any]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        future_routes = {
            executor.submit(request_json, route, cache_dir): route for route in routes
        }
        for future in concurrent.futures.as_completed(future_routes):
            route = future_routes[future]
            pages[route] = future.result()["page"]
    return pages


def verify_audio(urls: list[str], workers: int) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        future_urls = {executor.submit(audio_status, url): url for url in urls}
        for future in concurrent.futures.as_completed(future_urls):
            url = future_urls[future]
            results[url] = future.result()
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("DB_multilingual.v2.json"))
    parser.add_argument("--output", type=Path, default=Path("DB_multilingual.v3.json"))
    parser.add_argument(
        "--report", type=Path, default=Path("DB_multilingual.persian-repair-report.json")
    )
    parser.add_argument(
        "--cache-dir", type=Path, default=Path("/private/tmp/acim-farsi-api-cache")
    )
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    database = read_json(args.input)
    lessons = database.get("lessons")
    supplements = database.get("supplemental_sections")
    if not isinstance(lessons, list) or len(lessons) != LESSON_COUNT:
        raise ValueError("Input must contain exactly 365 lessons")
    if not isinstance(supplements, list):
        raise ValueError("Input must contain supplemental_sections")

    legacy_lesson_audio_numbers = {
        int(lesson["lesson_number"])
        for lesson in lessons
        if lesson["content"]["fa"].get("audio_url")
    }
    legacy_lesson_audio_count = len(legacy_lesson_audio_numbers)

    lesson_routes = {
        lesson["lesson_number"]: (
            f"/workbook/lesson/{lesson['lesson_number']}"
            if lesson["lesson_number"] <= 360
            else "/workbook/lessons-361-365"
        )
        for lesson in lessons
    }
    supplement_routes = {
        item["id"]: route_from_url(item["content"]["fa"]["text_url"])
        for item in supplements
    }
    routes = sorted(set(lesson_routes.values()) | set(supplement_routes.values()))
    pages = fetch_pages(routes, args.cache_dir, args.workers)

    api_audio_urls = sorted(
        {
            absolute_url(str(page.get("audioUrl") or ""))
            for page in pages.values()
            if page.get("audioUrl")
        }
    )
    audio_results = verify_audio([url for url in api_audio_urls if url], args.workers)

    lesson_report: list[dict[str, Any]] = []
    reminder_status_counts: Counter[str] = Counter()
    title_status_counts: Counter[str] = Counter()
    translation_state_counts: Counter[str] = Counter()

    for lesson in lessons:
        number = int(lesson["lesson_number"])
        route = lesson_routes[number]
        page = pages[route]
        if page.get("path") != route:
            raise ValueError(f"API path mismatch for lesson {number}: {page.get('path')!r}")
        lines = page_lines(page)
        if not lines:
            raise ValueError(f"No API source lines for lesson {number}")
        for line in lines:
            translation_state_counts[line.translation_state or "missing"] += 1

        english = lesson["content"]["en"]
        persian = lesson["content"]["fa"]
        repaired_title, title_verification, title_score = repair_title(
            english["title"], lines
        )
        title_status_counts[title_verification] += 1

        repaired_reminder, reminder_metadata = repair_reminder(
            english["reminder_text"], lines
        )
        if repaired_reminder is None:
            reminder_verification = "legacy_preserved_alignment_failed"
            reminder_status = "needs_manual_review"
        else:
            if reminder_metadata["uses_standardized_editorial_translation"]:
                reminder_verification = (
                    "verified_source_alignment_with_standardized_editorial_translation"
                )
                reminder_status = "verified_with_standardized_editorial_text"
            else:
                reminder_verification = "verified_acim_farsi_api_line_alignment"
                reminder_status = "verified"
            persian["reminder_text"] = repaired_reminder
        reminder_status_counts[reminder_status] += 1

        full_text = translated_full_text(lines)
        if not full_text:
            raise ValueError(f"No translated Persian full text for lesson {number}")

        audio_url = absolute_url(str(page.get("audioUrl") or ""))
        audio_check = audio_results.get(audio_url) if audio_url else None
        if audio_url and audio_check and audio_check["ready"]:
            persisted_audio_url = audio_url
            audio_verification = "verified_http_200_audio"
        elif audio_url:
            persisted_audio_url = None
            audio_verification = "source_listed_but_unavailable"
        else:
            persisted_audio_url = None
            audio_verification = "verified_absent_acim_farsi_api"

        persian.update(
            {
                "title": repaired_title,
                "full_text": full_text,
                "text_url": f"{BASE_URL}{route}",
                "audio_url": persisted_audio_url,
                "verification": {
                    "title": title_verification,
                    "reminder_text": reminder_verification,
                    "full_text": "verified_acim_farsi_api",
                    "text_url": "verified_acim_farsi_api",
                    "audio_url": audio_verification,
                },
            }
        )

        lesson_report.append(
            {
                "lesson_number": number,
                "source_path": route,
                "title_alignment_score": round(title_score, 4),
                "title_verification": title_verification,
                "reminder_status": reminder_status,
                "reminder_alignment": reminder_metadata,
                "api_audio_url": audio_url,
                "audio_check": audio_check,
            }
        )

    supplement_report: list[dict[str, Any]] = []
    for item in supplements:
        route = supplement_routes[item["id"]]
        page = pages[route]
        if page.get("path") != route:
            raise ValueError(f"API path mismatch for supplement {item['id']}")
        lines = page_lines(page)
        full_text = translated_full_text(lines)
        if not full_text:
            raise ValueError(f"No translated Persian text for supplement {item['id']}")
        content = item["content"]["fa"]
        title_container = page.get("title") or {}
        title = clean_text(str(title_container.get("fa") or ""))
        if not title:
            raise ValueError(f"No Persian title for supplement {item['id']}")
        audio_url = absolute_url(str(page.get("audioUrl") or ""))
        audio_check = audio_results.get(audio_url) if audio_url else None
        ready_audio = audio_url if audio_check and audio_check["ready"] else None
        content.update(
            {
                "title": title,
                "reminder_text": None,
                "full_text": full_text,
                "text_url": f"{BASE_URL}{route}",
                "audio_url": ready_audio,
                "verification": {
                    "title": "verified_acim_farsi_api",
                    "reminder_text": "not_applicable",
                    "full_text": "verified_acim_farsi_api",
                    "text_url": "verified_acim_farsi_api",
                    "audio_url": (
                        "verified_http_200_audio"
                        if ready_audio
                        else (
                            "source_listed_but_unavailable"
                            if audio_url
                            else "verified_absent_acim_farsi_api"
                        )
                    ),
                },
            }
        )
        supplement_report.append(
            {
                "id": item["id"],
                "source_path": route,
                "api_audio_url": audio_url,
                "audio_check": audio_check,
            }
        )

    retrieved_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    database["schema_version"] = 3
    database["provenance"] = {
        **database.get("provenance", {}),
        "authoritative_persian_source": BASE_URL,
        "persian_retrieved_at": retrieved_at,
        "persian_repair_script": "repair_persian_content.py",
        "persian_policy": (
            "Persian titles, full text, text URLs, and ready audio URLs come from "
            "acim-farsi.org. Persian reminder text is included only when every "
            "English reminder line aligns to bilingual API source lines; otherwise "
            "the legacy reminder is preserved and flagged for manual review."
        ),
    }

    audio_ready = [url for url, status in audio_results.items() if status["ready"]]
    audio_unavailable = [url for url, status in audio_results.items() if not status["ready"]]
    lesson_audio_ready_count = sum(
        1 for lesson in lessons if lesson["content"]["fa"].get("audio_url")
    )
    lesson_audio_ready_numbers = {
        int(lesson["lesson_number"])
        for lesson in lessons
        if lesson["content"]["fa"].get("audio_url")
    }
    supplement_audio_ready_count = sum(
        1 for item in supplements if item["content"]["fa"].get("audio_url")
    )
    report = {
        "generated_at": retrieved_at,
        "input": str(args.input),
        "output": str(args.output),
        "authoritative_source": BASE_URL,
        "summary": {
            "lesson_count": len(lessons),
            "supplemental_section_count": len(supplements),
            "api_pages_fetched": len(pages),
            "title_verification_counts": dict(sorted(title_status_counts.items())),
            "reminder_status_counts": dict(sorted(reminder_status_counts.items())),
            "translation_state_counts": dict(sorted(translation_state_counts.items())),
            "legacy_lesson_audio_urls": legacy_lesson_audio_count,
            "lesson_audio_urls_ready": lesson_audio_ready_count,
            "newly_available_lesson_audio_urls": (
                lesson_audio_ready_count - legacy_lesson_audio_count
            ),
            "lesson_audio_verified_absent": LESSON_COUNT - lesson_audio_ready_count,
            "supplement_audio_urls_ready": supplement_audio_ready_count,
            "audio_urls_listed_by_api": len(audio_results),
            "audio_urls_ready": len(audio_ready),
            "audio_urls_unavailable": len(audio_unavailable),
        },
        "audio": {
            "lesson_ready_numbers": sorted(lesson_audio_ready_numbers),
            "newly_available_lesson_numbers": sorted(
                lesson_audio_ready_numbers - legacy_lesson_audio_numbers
            ),
            "lesson_absent_numbers": sorted(
                set(range(1, LESSON_COUNT + 1)) - lesson_audio_ready_numbers
            ),
            "ready_urls": sorted(audio_ready),
            "unavailable_urls": sorted(audio_unavailable),
        },
        "lessons": lesson_report,
        "supplemental_sections": supplement_report,
    }

    write_json(args.output, database)
    write_json(args.report, report)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
