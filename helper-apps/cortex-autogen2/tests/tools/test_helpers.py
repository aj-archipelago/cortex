import os
from pathlib import Path
from agents.util.helpers import append_accomplishment_to_file


def test_append_accomplishment_mirrors(tmp_path):
    work_dir = tmp_path / "req_test_fake"
    work_dir.mkdir(parents=True, exist_ok=True)
    # ensure logs dir was created
    logs_dir = work_dir / "logs"
    logs_dir.mkdir(exist_ok=True)
    # call the helper
    append_accomplishment_to_file(str(work_dir), "SYSTEM: Test accomplishment mirror")

    # Verify per-request accomplishments exists
    per_path = logs_dir / "accomplishments.log"
    assert per_path.exists()
    content = per_path.read_text(encoding='utf-8')
    assert "SYSTEM: Test accomplishment mirror" in content

    # Verify mirror file creation under repo logs/request_accomplishments
    repo_mirror = Path(os.getcwd()) / "logs" / "request_accomplishments" / f"{work_dir.name}_accomplishments.log"
    assert repo_mirror.exists()
    mirror_content = repo_mirror.read_text(encoding='utf-8')
    assert "SYSTEM: Test accomplishment mirror" in mirror_content
