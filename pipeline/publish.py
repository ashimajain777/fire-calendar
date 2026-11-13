"""Release upload and meta.json. See docs/CONTRACTS.md section 5."""
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def upload_release_assets(paths: list[Path], repo: str, tag: str = "data") -> None:
    subprocess.run(["gh", "release", "upload", tag, *map(str, paths), "--repo", repo, "--clobber"], check=True)


def write_meta(path: Path, **fields) -> None:
    fields["generated_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    Path(path).write_text(json.dumps(fields, indent=2, default=str), encoding="utf-8")
