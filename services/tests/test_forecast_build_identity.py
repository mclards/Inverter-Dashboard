import hashlib
import json
import os
from pathlib import Path
import subprocess

import pytest

from scripts import generate_build_info as build_info


COMMIT = "a" * 40
SOURCE_HASH = "b" * 64
TIMESTAMP_MS = 1700000000000
TIMESTAMP_UTC = "2023-11-14T22:13:20.000Z"


def _ready_release_state():
    return {
        "release_base_ref": "origin/main",
        "release_base_ref_available": True,
        "commits_behind_release_base": 0,
        "package_version_tag_exists": False,
        "release_ready": True,
    }


def _mock_complete_identity(monkeypatch, *, dirty=False, release_state=None):
    monkeypatch.setattr(build_info, "_git_commit_hash", lambda _root: COMMIT)
    monkeypatch.setattr(build_info, "_git_is_dirty", lambda _root, _output: dirty)
    monkeypatch.setattr(build_info, "_file_sha256", lambda _path: SOURCE_HASH)
    monkeypatch.setattr(build_info, "_package_version", lambda _root: "9.8.7")
    monkeypatch.setattr(
        build_info,
        "_git_release_state",
        lambda _root, _version: release_state or _ready_release_state(),
    )


def _git(repo, *args):
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )


def _init_fixture_repo(tmp_path, version="1.2.3"):
    (tmp_path / "services").mkdir()
    (tmp_path / "package.json").write_text(
        json.dumps({"version": version}) + "\n",
        encoding="utf-8",
    )
    source = tmp_path / "services" / "forecast_engine.py"
    source.write_text("print('first')\n", encoding="utf-8")
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.name", "Build Identity Test")
    _git(tmp_path, "config", "user.email", "build-identity@example.invalid")
    _git(tmp_path, "add", "package.json", "services/forecast_engine.py")
    _git(tmp_path, "commit", "-q", "-m", "fixture")
    _git(tmp_path, "update-ref", "refs/remotes/origin/main", "HEAD")
    return source


def test_source_date_epoch_makes_timestamp_deterministic():
    assert build_info._build_timestamp_ms({"SOURCE_DATE_EPOCH": "1700000000"}) == TIMESTAMP_MS
    assert build_info._format_build_timestamp_utc(TIMESTAMP_MS) == TIMESTAMP_UTC
    with pytest.raises(ValueError, match="integer"):
        build_info._build_timestamp_ms({"SOURCE_DATE_EPOCH": "not-an-epoch"})


def test_clean_development_build_is_never_promotion_eligible(tmp_path, monkeypatch):
    _mock_complete_identity(monkeypatch)

    info = build_info.collect_build_info(
        tmp_path,
        tmp_path / build_info.DEFAULT_OUTPUT,
        timestamp_ms=TIMESTAMP_MS,
        build_channel=build_info.BUILD_CHANNEL_DEVELOPMENT,
    )

    assert info["identity_status"] == "verified"
    assert info["git_dirty"] is False
    assert info["build_channel"] == "development"
    assert info["release_ready"] is True
    assert info["promotion_eligible"] is False


def test_clean_release_ready_signed_build_is_promotion_eligible(tmp_path, monkeypatch):
    _mock_complete_identity(monkeypatch)

    info = build_info.collect_build_info(
        tmp_path,
        tmp_path / build_info.DEFAULT_OUTPUT,
        timestamp_ms=TIMESTAMP_MS,
        build_channel=build_info.BUILD_CHANNEL_SIGNED_RELEASE,
    )

    assert info["promotion_eligible"] is True
    assert info["source_hash"] == SOURCE_HASH
    assert info["build_timestamp_utc"] == TIMESTAMP_UTC


def test_unknown_git_state_fails_closed(tmp_path, monkeypatch):
    _mock_complete_identity(monkeypatch, dirty=None)

    info = build_info.collect_build_info(
        tmp_path,
        tmp_path / build_info.DEFAULT_OUTPUT,
        timestamp_ms=TIMESTAMP_MS,
        build_channel=build_info.BUILD_CHANNEL_SIGNED_RELEASE,
    )

    assert info["identity_status"] == "unverified"
    assert info["git_status_available"] is False
    assert info["git_dirty"] is True
    assert info["promotion_eligible"] is False


def test_validation_rejects_stale_hash_and_nonpromotable_identity():
    expected = {
        "schema_version": 1,
        "build_channel": "development",
        "package_version": "2.12.9",
        "git_commit": COMMIT,
        "git_dirty": False,
        "git_status_available": True,
        "source_path": "services/forecast_engine.py",
        "source_hash": SOURCE_HASH,
        "artifact_compatibility_version": 1,
        "identity_status": "verified",
        "promotion_eligible": False,
        "build_timestamp": TIMESTAMP_MS,
        "build_timestamp_utc": TIMESTAMP_UTC,
        **_ready_release_state(),
    }
    recorded = dict(expected, source_hash="c" * 64)

    errors = build_info.validation_errors(
        recorded,
        expected,
        require_promotion_eligible=True,
    )

    assert any(error.startswith("source_hash:") for error in errors)
    assert any("signed-release channel" in error for error in errors)


@pytest.mark.parametrize("bad_timestamp", [True, False, 1.5, "1700000000000", None])
def test_validation_rejects_bool_and_noninteger_timestamps(bad_timestamp):
    recorded = {
        "build_timestamp": bad_timestamp,
        "build_timestamp_utc": TIMESTAMP_UTC,
    }
    errors = build_info.validation_errors(recorded, recorded)
    assert any("non-negative integer" in error for error in errors)


@pytest.mark.parametrize(
    "bad_utc",
    [
        "2023-11-14T22:13:20+00:00",
        "2023-11-14T22:13:20.0000Z",
        "2023-11-14 22:13:20.000Z",
        "",
        True,
        None,
    ],
)
def test_validation_rejects_noncanonical_or_mismatched_utc(bad_utc):
    recorded = {
        "build_timestamp": TIMESTAMP_MS,
        "build_timestamp_utc": bad_utc,
    }
    errors = build_info.validation_errors(recorded, recorded)
    assert any("build_timestamp_utc" in error for error in errors)


def test_written_json_is_stably_ordered_and_newline_terminated(tmp_path):
    output = tmp_path / "forecast-build-info.json"
    build_info.write_build_info(output, {"z": 1, "a": 2})
    assert output.read_bytes() == b'{\n  "a": 2,\n  "z": 1\n}\n'


def test_pyinstaller_spec_bundles_identity_and_preserves_build_channel():
    repo_root = Path(__file__).resolve().parents[2]
    spec = (repo_root / "services" / "ForecastCoreService.spec").read_text(encoding="utf-8")
    assert "datas=[(str(build_info), '.')]" in spec
    assert "ADSI_FORECAST_BUILD_CHANNEL" in spec
    assert "--require-release-ready" in spec


def test_clean_repo_development_is_blocked_but_signed_release_is_promotable(tmp_path, monkeypatch):
    source = _init_fixture_repo(tmp_path)
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1700000000")
    output = tmp_path / build_info.DEFAULT_OUTPUT
    base_args = ["--repo-root", str(tmp_path), "--output", str(output)]

    assert build_info.main([*base_args, "--build-channel", "development"]) == 0
    assert json.loads(output.read_text(encoding="utf-8"))["promotion_eligible"] is False

    release_args = [
        *base_args,
        "--build-channel", "signed-release",
        "--require-promotion-eligible",
        "--require-release-ready",
    ]
    assert build_info.main(release_args) == 0
    recorded = json.loads(output.read_text(encoding="utf-8"))
    assert recorded["promotion_eligible"] is True
    assert recorded["commits_behind_release_base"] == 0
    assert build_info.main([*release_args, "--check"]) == 0

    source.write_text("print('changed')\n", encoding="utf-8")
    assert build_info.main([*release_args, "--check"]) == 2


def test_signed_release_rejects_head_behind_origin_main(tmp_path, monkeypatch):
    _init_fixture_repo(tmp_path)
    _git(tmp_path, "checkout", "-q", "-b", "upstream-fixture")
    (tmp_path / "upstream.txt").write_text("new upstream commit\n", encoding="utf-8")
    _git(tmp_path, "add", "upstream.txt")
    _git(tmp_path, "commit", "-q", "-m", "upstream")
    _git(tmp_path, "update-ref", "refs/remotes/origin/main", "HEAD")
    _git(tmp_path, "checkout", "-q", "master")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1700000000")

    output = tmp_path / build_info.DEFAULT_OUTPUT
    result = build_info.main([
        "--repo-root", str(tmp_path), "--output", str(output),
        "--build-channel", "signed-release",
        "--require-promotion-eligible", "--require-release-ready",
    ])
    recorded = json.loads(output.read_text(encoding="utf-8"))
    assert result == 2
    assert recorded["commits_behind_release_base"] == 1
    assert recorded["promotion_eligible"] is False


def test_signed_release_rejects_existing_version_tag(tmp_path, monkeypatch):
    _init_fixture_repo(tmp_path)
    _git(tmp_path, "tag", "v1.2.3")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1700000000")
    output = tmp_path / build_info.DEFAULT_OUTPUT

    result = build_info.main([
        "--repo-root", str(tmp_path), "--output", str(output),
        "--build-channel", "signed-release",
        "--require-promotion-eligible", "--require-release-ready",
    ])
    recorded = json.loads(output.read_text(encoding="utf-8"))
    assert result == 2
    assert recorded["package_version_tag_exists"] is True
    assert recorded["promotion_eligible"] is False


def test_thumbprint_and_pdf_backup_guards_are_fail_closed():
    repo_root = Path(__file__).resolve().parents[2]
    script = r"""
const guards = require('./scripts/release-build-guards');
if (guards.parsePinnedThumbprint('a'.repeat(40)) !== 'A'.repeat(40)) process.exit(10);
for (const bad of ['', 'A'.repeat(39), 'G'.repeat(40), 'A'.repeat(41)]) {
  let rejected = false;
  try { guards.parsePinnedThumbprint(bad); } catch (_) { rejected = true; }
  if (!rejected) process.exit(11);
}
let warned = false;
const fakeFs = { existsSync: () => true, rmSync: () => { throw new Error('locked'); } };
const ok = guards.cleanupInstalledPdfBackup('backup.pdf', fakeFs, { warn: () => { warned = true; } });
if (ok !== false || !warned) process.exit(12);
"""
    subprocess.run(["node", "-e", script], cwd=repo_root, check=True)


def test_signed_installer_wires_release_identity_docs_and_thumbprint_gates():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "scripts" / "build-installer-signed.js").read_text(encoding="utf-8")
    assert "--build-channel', forecastBuildChannel" in source
    assert "--require-release-ready" in source
    assert "['run', 'docs:pdf', '--', '--check']" in source
    assert "Skipping release PDF preflight for unsigned development build" in source
    assert "required thumbprint pin file is missing" in source
    assert "thumbprint pin check was skipped" not in source


def test_pdf_provenance_check_is_nonmutating_and_detects_source_drift(tmp_path):
    repo_root = Path(__file__).resolve().parents[2]
    html = tmp_path / "complete-guide.html"
    pdf = tmp_path / "complete-guide.pdf"
    sidecar = tmp_path / "complete-guide.pdf.provenance.json"
    source = (
        '<!doctype html><html><head><meta name="adsi-guide-source" content="complete"></head><body>'
        + "".join(f"<h1>Section {index}</h1>" for index in range(12))
        + ("x" * 41000)
        + "</body></html>"
    )
    html.write_text(source, encoding="utf-8")
    page_markers = b"/Type /Page\n" * 12
    pdf_bytes = b"%PDF-1.7\n" + page_markers + (b"x" * 51000) + b"\n%%EOF\n"
    pdf.write_bytes(pdf_bytes)

    relative_script = r"""
const path = require('path');
for (const value of process.argv.slice(1)) {
  process.stdout.write(path.relative(process.cwd(), value).split(path.sep).join('/') + '\n');
}
"""
    paths = subprocess.run(
        ["node", "-e", relative_script, str(html), str(pdf)],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    provenance = {
        "schema_version": 1,
        "generator": "scripts/_gen_userguide_pdf.js",
        "source_path": paths[0],
        "source_sha256": hashlib.sha256(html.read_bytes()).hexdigest(),
        "source_bytes": len(html.read_bytes()),
        "source_heading_count": 12,
        "pdf_path": paths[1],
        "pdf_sha256": hashlib.sha256(pdf_bytes).hexdigest(),
        "pdf_bytes": len(pdf_bytes),
        "pdf_page_count": 12,
    }
    sidecar.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    env = {
        **os.environ,
        "ADSI_USERGUIDE_HTML": str(html),
        "ADSI_USERGUIDE_PDF": str(pdf),
        "ADSI_USERGUIDE_PROVENANCE": str(sidecar),
    }
    before_pdf = pdf.read_bytes()
    before_sidecar = sidecar.read_bytes()

    subprocess.run(
        ["node", "scripts/_gen_userguide_pdf.js", "--check"],
        cwd=repo_root,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    assert pdf.read_bytes() == before_pdf
    assert sidecar.read_bytes() == before_sidecar

    html.write_text(source.replace("Section 0", "Changed section"), encoding="utf-8")
    failed = subprocess.run(
        ["node", "scripts/_gen_userguide_pdf.js", "--check"],
        cwd=repo_root,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert failed.returncode == 2
    assert "provenance mismatch for source_sha256" in failed.stderr
    assert pdf.read_bytes() == before_pdf
    assert sidecar.read_bytes() == before_sidecar
