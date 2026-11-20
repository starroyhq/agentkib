from pathlib import Path
from hashlib import sha256
import re, sys

root = Path(sys.argv[1])
version = "0.32.0"
prefix = f"AgentKib_{version}"
expected = {
    "macos-arm64": [f"{prefix}_macos-arm64.dmg", f"{prefix}_macos-arm64.zip", "arm64-mac.yml"],
    "macos-x64": [f"{prefix}_macos-x64.dmg", f"{prefix}_macos-x64.zip", "x64-mac.yml"],
    "windows-x64": [f"{prefix}_windows-x64.exe", "x64.yml"],
    "windows-arm64-preview": [f"{prefix}_windows-arm64.exe", "arm64.yml"],
    "linux-ubuntu-x64": [f"{prefix}_linux-x86_64.AppImage", f"{prefix}_linux-amd64.deb", "latest-linux.yml"],
    "linux-ubuntu-arm64-preview": [f"{prefix}_linux-arm64.AppImage", f"{prefix}_linux-arm64.deb", "latest-linux-arm64.yml"],
    "linux-fedora-x64": [f"{prefix}_linux-x86_64.rpm"],
}
assert {group.name for group in root.iterdir()} == {f"agentkib-desktop-{key}" for key in expected}
for key, files in expected.items():
    group = root / f"agentkib-desktop-{key}"
    for name in files:
        asset = group / name
        assert asset.is_file() and asset.stat().st_size > 0, f"Missing asset: {asset}"
        if asset.suffix == ".yml":
            text = asset.read_text()
            assert re.search(r"^version: " + re.escape(version) + r"\s*$", text, re.M), f"Wrong version: {asset}"
            assert "files:" in text and "sha512:" in text, f"Invalid updater metadata: {asset}"
        else:
            assert asset.with_name(asset.name + ".sha256").is_file(), f"Missing checksum: {asset}"
    checksums = sorted(group.glob("*.sha256"))
    expected_blobs = {name for name in files if not name.endswith(".yml")}
    actual_blobs = {asset.name for asset in group.iterdir() if asset.suffix not in {".yml", ".sha256"}}
    assert expected_blobs <= actual_blobs
    assert all(name in expected_blobs or (name.endswith(".blockmap") and name[:-9] in expected_blobs) for name in actual_blobs)
    assert {checksum.name[:-7] for checksum in checksums} == actual_blobs
    for checksum in checksums:
        matched = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", checksum.read_text().strip())
        assert matched, f"Invalid checksum format: {checksum}"
        digest, filename = matched.groups()
        assert Path(filename).name == filename and filename == checksum.name[:-7], f"Checksum target mismatch: {checksum}"
        with (group / filename).open("rb") as package:
            verifier = sha256()
            for block in iter(lambda: package.read(1024 * 1024), b""):
                verifier.update(block)
            assert verifier.hexdigest() == digest, f"SHA-256 mismatch: {filename}"
    print(f"{key}: {len(checksums)} checksums verified; expected package manifest complete")
