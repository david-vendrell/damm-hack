"""LineWise — Step 10: Push the LineWise OEE forecaster to a private HF Space.

Stages a minimal directory (app.py + engine/ + models/ + lookups/ +
Space-specific requirements.txt + README with YAML frontmatter) into
.hf_stage/ and uploads it via huggingface_hub.

Setup:
    1. Generate a write-scope token at https://huggingface.co/settings/tokens
    2. export HF_TOKEN=hf_xxxxxxxx...
    3. (Optional) export HF_USER=marcaguilar       (defaults to whoami() result)
    4. (Optional) export HF_SPACE=linewise-demo    (defaults to "linewise-demo")

Run from repo root:
    python3 scripts/10_push_to_hf_space.py
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from huggingface_hub import HfApi, whoami

ROOT = Path(__file__).resolve().parent.parent
STAGE = ROOT / ".hf_stage"

SPACE_REQUIREMENTS = """\
gradio>=4.0
pandas>=2.0
numpy>=1.26
pyarrow>=14.0
openpyxl>=3.1
lightgbm>=4.0
holidays>=0.40
"""

SPACE_README = """\
---
title: LineWise — OEE Forecaster
emoji: 🍺
colorFrom: red
colorTo: gray
sdk: gradio
sdk_version: "5.50.0"
app_file: app.py
pinned: false
license: other
short_description: "Upload Damm planning Excel → per-block OEE forecast"
---

# LineWise — OEE Forecaster

Damm × Engineering HUB Hackathon · canning lines 14 · 17 · 19 at El Prat.

Upload a Damm planning Excel (`Planificado producciones` or `Diario Hl_Planif`)
and get per-block OEE predictions (p10 / p50 / p90), the SHAP drivers of each
prediction, and a weekly summary per line.

Trained on ~2 200 historical Production Orders from 2025.
**`p90` represents the realistic OEE ceiling for the proposed combination.**
"""


def main() -> None:
    token = os.environ.get("HF_TOKEN")
    if not token:
        print("ERROR: HF_TOKEN environment variable not set.", file=sys.stderr)
        print("       Generate at https://huggingface.co/settings/tokens (write scope)", file=sys.stderr)
        print("       Then: export HF_TOKEN=hf_xxxxxx...", file=sys.stderr)
        sys.exit(1)

    api = HfApi(token=token)
    me = whoami(token=token)
    user = os.environ.get("HF_USER") or me["name"]
    space_name = os.environ.get("HF_SPACE", "linewise-demo")
    repo_id = f"{user}/{space_name}"
    print(f"==> Target Space: {repo_id} (PRIVATE)")

    # ============================================================ Stage
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir()

    # Required files
    print("==> Staging files ...")
    shutil.copy(ROOT / "app.py", STAGE / "app.py")
    shutil.copytree(ROOT / "engine",  STAGE / "engine",  ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(ROOT / "models",  STAGE / "models")
    shutil.copytree(ROOT / "lookups", STAGE / "lookups")

    (STAGE / "requirements.txt").write_text(SPACE_REQUIREMENTS)
    (STAGE / "README.md").write_text(SPACE_README)

    # Stats
    file_count = sum(1 for _ in STAGE.rglob("*") if _.is_file())
    total_bytes = sum(f.stat().st_size for f in STAGE.rglob("*") if f.is_file())
    print(f"==> Staged {file_count} files, total size {total_bytes/1024/1024:.2f} MB")

    # ============================================================ Create Space (idempotent)
    print(f"==> Ensuring Space {repo_id} exists (private, Gradio SDK) ...")
    try:
        api.create_repo(
            repo_id=repo_id,
            repo_type="space",
            space_sdk="gradio",
            private=True,
            exist_ok=True,
        )
    except Exception as exc:
        print(f"WARNING during create_repo: {exc}")

    # ============================================================ Upload
    print("==> Uploading folder ...")
    commit = api.upload_folder(
        folder_path=str(STAGE),
        repo_id=repo_id,
        repo_type="space",
        commit_message="LineWise OEE forecaster — Gradio Space",
        ignore_patterns=["__pycache__", "*.pyc", ".DS_Store"],
    )
    print(f"==> Done. Commit: {commit.commit_url}")
    print(f"==> Live Space:   https://huggingface.co/spaces/{repo_id}")
    print("\nThe Space is PRIVATE. Toggle to public from the Space settings for the demo.")


if __name__ == "__main__":
    main()
