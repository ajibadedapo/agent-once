import re
from pathlib import Path

from agent_once import LEDGER_SCHEMA_VERSION

SPEC_SQL = Path(__file__).resolve().parents[2] / "spec" / "ledger-v1.sql"


def test_ledger_schema_version_matches_the_spec_sql() -> None:
    sql = SPEC_SQL.read_text(encoding="utf-8")
    match = re.search(r"INSERT INTO meta \(key, value\) VALUES \('schema_version', '(\d+)'\);", sql)
    assert match is not None
    assert match.group(1) == str(LEDGER_SCHEMA_VERSION)
