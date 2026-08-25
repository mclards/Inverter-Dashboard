"""Generate and verify the identity bundled with ForecastCoreService.

The output is a build artifact, not a source-of-truth file.  Release builds
must run this script immediately before PyInstaller and then run ``--check``.
``SOURCE_DATE_EPOCH`` is honoured so repeatable build environments can produce
stable metadata; otherwise the current UTC time is recorded.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BUILD_INFO_SCHEMA_VERSION = 1
ARTIFACT_COMPATIBILITY_VERSION = 1
DEFAULT_OUTPUT = Path("services") / "forecast-build-info.json"
FORECAST_SOURCE = Path("services") / "forecast_engine.py"
RELEASE_BASE_REF = "origin/main"
BUILD_CHANNEL_DEVELOPMENT = "development"
BUILD_CHANNEL_SIGNED_RELEASE = "signed-release"
BUILD_CHANNELS = (BUILD_CHANNEL_DEVELOPMENT, BUILD_CHANNEL_SIGNED_RELEASE)
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _run_git(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _git_commit_hash(repo_root: Path) -> str | None:
    result = _run_git(repo_root, "rev-parse", "--verify", "HEAD")
    value = str(result.stdout or "").strip().lower() if result else ""
    return value if result and result.returncode == 0 and COMMIT_RE.fullmatch(value) else None


def _git_is_dirty(repo_root: Path, ignored_output: Path) -> bool | None:
    """Return source-tree dirtiness, excluding only the generated output.

    Excluding the generated JSON prevents the build step from making an
    otherwise clean checkout dirty.  No source, spec, test, or packaging file
    is excluded from the promotion gate.
    """

    try:
        relative_output = ignored_output.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        relative_output = ""

    args = ["status", "--porcelain=v1", "--untracked-files=all", "--", "."]
    if relative_output:
        args.append(f":(exclude){relative_output}")
    result = _run_git(repo_root, *args)
    if result is None or result.returncode != 0:
        return None
    return bool(str(result.stdout or "").strip())


def _git_release_state(repo_root: Path, package_version: str | None) -> dict[str, Any]:
    """Resolve local release readiness without requiring network access."""

    base = _run_git(repo_root, "rev-parse", "--verify", RELEASE_BASE_REF)
    base_available = bool(base and base.returncode == 0 and COMMIT_RE.fullmatch(str(base.stdout or "").strip().lower()))
    behind_count: int | None = None
    if base_available:
        behind = _run_git(repo_root, "rev-list", "--count", f"HEAD..{RELEASE_BASE_REF}")
        raw = str(behind.stdout or "").strip() if behind else ""
        if behind and behind.returncode == 0 and raw.isdigit():
            behind_count = int(raw)

    tag_exists: bool | None = None
    if package_version:
        tag_exists = False
        for tag in (package_version, f"v{package_version}"):
            result = _run_git(repo_root, "show-ref", "--verify", "--quiet", f"refs/tags/{tag}")
            if result is None or result.returncode not in (0, 1):
                tag_exists = None
                break
            if result.returncode == 0:
                tag_exists = True
                break

    release_ready = bool(
        base_available
        and behind_count == 0
        and tag_exists is False
    )
    return {
        "release_base_ref": RELEASE_BASE_REF,
        "release_base_ref_available": base_available,
        "commits_behind_release_base": behind_count,
        "package_version_tag_exists": tag_exists,
        "release_ready": release_ready,
    }


def _file_sha256(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _package_version(repo_root: Path) -> str | None:
    try:
        value = json.loads((repo_root / "package.json").read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError, TypeError):
        return None
    value = str(value or "").strip()
    return value or None


def _build_timestamp_ms(environ: dict[str, str] | None = None) -> int:
    env = os.environ if environ is None else environ
    raw_epoch = str(env.get("SOURCE_DATE_EPOCH", "")).strip()
    if raw_epoch:
        try:
            epoch = int(raw_epoch)
        except ValueError as exc:
            raise ValueError("SOURCE_DATE_EPOCH must be an integer number of seconds") from exc
        if epoch < 0:
            raise ValueError("SOURCE_DATE_EPOCH must not be negative")
        return epoch * 1000
    return int(time.time() * 1000)


def _format_build_timestamp_utc(timestamp_ms: int) -> str:
    if type(timestamp_ms) is not int or timestamp_ms < 0:
        raise ValueError("build timestamp must be a non-negative integer number of milliseconds")
    try:
        return datetime.fromtimestamp(
            timestamp_ms / 1000, tz=timezone.utc
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError) as exc:
        raise ValueError("build timestamp is outside the supported UTC range") from exc


def collect_build_info(
    repo_root: Path,
    output_path: Path,
    *,
    timestamp_ms: int | None = None,
    build_channel: str = BUILD_CHANNEL_DEVELOPMENT,
) -> dict[str, Any]:
    if build_channel not in BUILD_CHANNELS:
        raise ValueError(f"unsupported build channel: {build_channel!r}")
    repo_root = repo_root.resolve()
    output_path = output_path.resolve()
    commit = _git_commit_hash(repo_root)
    dirty_state = _git_is_dirty(repo_root, output_path)
    # Unknown Git status must fail closed; it must never yield a promotable build.
    git_dirty = True if dirty_state is None else dirty_state
    source_hash = _file_sha256(repo_root / FORECAST_SOURCE)
    package_version = _package_version(repo_root)
    built_ms = _build_timestamp_ms() if timestamp_ms is None else timestamp_ms
    built_utc = _format_build_timestamp_utc(built_ms)
    release_state = _git_release_state(repo_root, package_version)

    identity_complete = bool(
        package_version
        and commit
        and COMMIT_RE.fullmatch(commit)
        and source_hash
        and SHA256_RE.fullmatch(source_hash)
        and dirty_state is not None
    )
    promotion_eligible = bool(
        identity_complete
        and not git_dirty
        and build_channel == BUILD_CHANNEL_SIGNED_RELEASE
        and release_state["release_ready"]
    )

    return {
        "schema_version": BUILD_INFO_SCHEMA_VERSION,
        "build_channel": build_channel,
        "package_version": package_version,
        "git_commit": commit,
        "git_dirty": git_dirty,
        "git_status_available": dirty_state is not None,
        "build_timestamp": built_ms,
        "build_timestamp_utc": built_utc,
        "source_path": FORECAST_SOURCE.as_posix(),
        "source_hash": source_hash,
        "artifact_compatibility_version": ARTIFACT_COMPATIBILITY_VERSION,
        "identity_status": "verified" if identity_complete else "unverified",
        "promotion_eligible": promotion_eligible,
        **release_state,
    }


def write_build_info(output_path: Path, info: dict[str, Any]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(info, indent=2, sort_keys=True) + "\n"
    output_path.write_text(payload, encoding="utf-8", newline="\n")


def validation_errors(
    recorded: dict[str, Any],
    expected: dict[str, Any],
    *,
    require_promotion_eligible: bool = False,
    require_release_ready: bool = False,
) -> list[str]:
    # Timestamp fields describe when the JSON was generated, so freshness is
    # established by the source/version/Git fields rather than wall-clock time.
    compared_fields = (
        "schema_version",
        "build_channel",
        "package_version",
        "git_commit",
        "git_dirty",
        "git_status_available",
        "source_path",
        "source_hash",
        "artifact_compatibility_version",
        "identity_status",
        "promotion_eligible",
        "release_base_ref",
        "release_base_ref_available",
        "commits_behind_release_base",
        "package_version_tag_exists",
        "release_ready",
    )
    errors = [
        f"{field}: recorded={recorded.get(field)!r}, current={expected.get(field)!r}"
        for field in compared_fields
        if recorded.get(field) != expected.get(field)
    ]
    recorded_timestamp = recorded.get("build_timestamp")
    if type(recorded_timestamp) is not int or recorded_timestamp < 0:
        errors.append("build_timestamp: must be a non-negative integer number of milliseconds (bool is invalid)")
    else:
        try:
            canonical_utc = _format_build_timestamp_utc(recorded_timestamp)
        except ValueError as exc:
            errors.append(f"build_timestamp: {exc}")
        else:
            if type(recorded.get("build_timestamp_utc")) is not str:
                errors.append("build_timestamp_utc: must be a canonical UTC string")
            elif recorded.get("build_timestamp_utc") != canonical_utc:
                errors.append(
                    "build_timestamp_utc: must exactly equal the UTC value derived from "
                    f"build_timestamp ({canonical_utc!r})"
                )
    if require_release_ready:
        if recorded.get("release_base_ref_available") is not True:
            errors.append(f"release preflight: required ref {RELEASE_BASE_REF!r} is unavailable")
        behind = recorded.get("commits_behind_release_base")
        if type(behind) is not int or behind != 0:
            errors.append(
                f"release preflight: HEAD is behind or not comparable to {RELEASE_BASE_REF} "
                f"(behind={behind!r})"
            )
        if recorded.get("package_version_tag_exists") is not False:
            errors.append(
                "release preflight: package version already exists as a tag or tag state is unavailable"
            )
    if require_promotion_eligible and recorded.get("promotion_eligible") is not True:
        errors.append(
            "promotion_eligible: false (requires signed-release channel, clean complete identity, "
            "current release base, and an unused version tag)"
        )
    return errors


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="repository root (defaults to the parent of scripts/)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="build-info output path (defaults to services/forecast-build-info.json)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the existing JSON matches the current source; do not rewrite it",
    )
    parser.add_argument(
        "--build-channel",
        choices=BUILD_CHANNELS,
        default=BUILD_CHANNEL_DEVELOPMENT,
        help="development is always non-promotable; signed-release enables release gates",
    )
    parser.add_argument(
        "--require-promotion-eligible",
        action="store_true",
        help="fail unless the signed-release identity passes every promotion gate",
    )
    parser.add_argument(
        "--require-release-ready",
        action="store_true",
        help="fail unless HEAD is current with origin/main and package version has no existing tag",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    repo_root = args.repo_root.resolve()
    output_path = (
        args.output.resolve()
        if args.output is not None
        else (repo_root / DEFAULT_OUTPUT).resolve()
    )

    try:
        if args.check:
            recorded = json.loads(output_path.read_text(encoding="utf-8"))
            if not isinstance(recorded, dict):
                raise ValueError("root JSON value must be an object")
            recorded_timestamp = recorded.get("build_timestamp")
            try:
                _format_build_timestamp_utc(recorded_timestamp)
            except ValueError:
                expected_timestamp = 0
            else:
                expected_timestamp = recorded_timestamp
            expected = collect_build_info(
                repo_root,
                output_path,
                timestamp_ms=expected_timestamp,
                build_channel=args.build_channel,
            )
            errors = validation_errors(
                recorded,
                expected,
                require_promotion_eligible=args.require_promotion_eligible,
                require_release_ready=args.require_release_ready,
            )
            if errors:
                print(f"ERROR: stale or ineligible Forecast build info: {output_path}", file=sys.stderr)
                for error in errors:
                    print(f"  - {error}", file=sys.stderr)
                return 2
            print(f"Forecast build info OK: {output_path}")
            return 0

        info = collect_build_info(
            repo_root,
            output_path,
            build_channel=args.build_channel,
        )
        write_build_info(output_path, info)
        print(f"Generated Forecast build info: {output_path}")
        print(
            "  channel={build_channel} version={package_version} commit={git_commit} dirty={git_dirty} "
            "source_hash={source_hash} promotion_eligible={promotion_eligible}".format(**info)
        )
        errors = validation_errors(
            info,
            info,
            require_promotion_eligible=args.require_promotion_eligible,
            require_release_ready=args.require_release_ready,
        )
        if errors:
            print("ERROR: generated identity failed requested release gates:", file=sys.stderr)
            for error in errors:
                print(f"  - {error}", file=sys.stderr)
            return 2
        return 0
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        print(f"ERROR: could not {'verify' if args.check else 'generate'} build info: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
