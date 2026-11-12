#!/usr/bin/env python3
"""Download and verify every ready Persian ACIM audio file."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


USER_AGENT = "ACIM-Alerts-Audio-Archive/1.0"
PRINT_LOCK = threading.Lock()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".part")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-.")
    if not cleaned:
        raise ValueError(f"Cannot create filename from {value!r}")
    return cleaned


def build_items(report: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for lesson in report["lessons"]:
        check = lesson.get("audio_check") or {}
        if not check.get("ready"):
            continue
        number = int(lesson["lesson_number"])
        items.append(
            {
                "kind": "lesson",
                "id": number,
                "url": lesson["api_audio_url"],
                "relative_path": f"lessons/{number:03d}.mp3",
                "expected_bytes": int(check["content_length"]),
            }
        )

    for supplement in report["supplemental_sections"]:
        check = supplement.get("audio_check") or {}
        if not check.get("ready"):
            continue
        url = supplement["api_audio_url"]
        filename = safe_filename(Path(urllib.parse.urlparse(url).path).name)
        items.append(
            {
                "kind": "supplement",
                "id": supplement["id"],
                "url": url,
                "relative_path": f"supplements/{filename}",
                "expected_bytes": int(check["content_length"]),
            }
        )

    paths = [item["relative_path"] for item in items]
    if len(paths) != len(set(paths)):
        raise ValueError("Audio inventory contains duplicate destination paths")
    return items


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def download_one(item: dict[str, Any], root: Path, retries: int = 6) -> dict[str, Any]:
    destination = root / item["relative_path"]
    part = destination.with_suffix(destination.suffix + ".part")
    expected = int(item["expected_bytes"])
    destination.parent.mkdir(parents=True, exist_ok=True)

    if destination.exists() and destination.stat().st_size == expected:
        result = dict(item)
        result.update(
            {
                "actual_bytes": expected,
                "sha256": file_sha256(destination),
                "status": "already_present",
            }
        )
        return result
    if destination.exists():
        destination.replace(part)
    if part.exists() and part.stat().st_size > expected:
        part.unlink()

    last_error: Exception | None = None
    for attempt in range(retries):
        offset = part.stat().st_size if part.exists() else 0
        headers = {"User-Agent": USER_AGENT}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(item["url"], headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                status = int(response.status)
                content_type = response.headers.get("Content-Type", "").lower()
                if status not in (200, 206):
                    raise RuntimeError(f"Unexpected HTTP status {status}")
                if not content_type.startswith("audio/"):
                    raise RuntimeError(f"Unexpected content type {content_type!r}")
                if offset and status != 206:
                    offset = 0
                mode = "ab" if offset and status == 206 else "wb"
                with part.open(mode) as stream:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        stream.write(chunk)
            actual = part.stat().st_size
            if actual != expected:
                raise RuntimeError(f"Size mismatch: expected {expected}, received {actual}")
            os.replace(part, destination)
            result = dict(item)
            result.update(
                {
                    "actual_bytes": actual,
                    "sha256": file_sha256(destination),
                    "status": "downloaded",
                }
            )
            return result
        except (OSError, RuntimeError, urllib.error.HTTPError) as error:
            last_error = error
            if attempt + 1 < retries:
                time.sleep(min(2**attempt, 16))

    raise RuntimeError(f"Failed {item['relative_path']}: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("DB_multilingual.persian-repair-report.json"),
    )
    parser.add_argument("--output-dir", type=Path, default=Path("persian_audio"))
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    report = read_json(args.report)
    items = build_items(report)
    if len(items) != 271:
        raise ValueError(f"Expected 271 ready audio files, found {len(items)}")
    expected_total = sum(item["expected_bytes"] for item in items)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    completed_bytes = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(download_one, item, args.output_dir): item for item in items
        }
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try:
                result = future.result()
                results.append(result)
                completed_bytes += int(result["actual_bytes"])
                with PRINT_LOCK:
                    print(
                        f"[{len(results):03d}/{len(items)}] {result['relative_path']} "
                        f"({completed_bytes / expected_total:.1%})",
                        flush=True,
                    )
            except Exception as error:  # noqa: BLE001 - collect all failed downloads
                failures.append(
                    {"relative_path": item["relative_path"], "error": str(error)}
                )
                with PRINT_LOCK:
                    print(f"FAILED {item['relative_path']}: {error}", flush=True)

    generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    manifest = {
        "generated_at": generated_at,
        "source": report["authoritative_source"],
        "source_report": str(args.report),
        "file_count": len(results),
        "expected_file_count": len(items),
        "total_bytes": sum(result["actual_bytes"] for result in results),
        "expected_total_bytes": expected_total,
        "failures": failures,
        "files": sorted(results, key=lambda item: item["relative_path"]),
    }
    write_json(args.output_dir / "manifest.json", manifest)

    if failures:
        raise SystemExit(f"{len(failures)} audio files failed; rerun to resume")
    if manifest["total_bytes"] != expected_total:
        raise SystemExit("Downloaded byte total does not match the verified inventory")
    print(
        f"Complete: {len(results)} files, {manifest['total_bytes']} bytes",
        flush=True,
    )


if __name__ == "__main__":
    main()
