import pytest

from pipeline import aggregate


@pytest.fixture(autouse=True)
def _no_outage_rule(monkeypatch):
    """Hand-built frames hold a few days of data, so the multi-day outage rule is off unless a test sets it."""
    monkeypatch.setattr(aggregate, "OUTAGE_MIN_DAYS", 10**6)
