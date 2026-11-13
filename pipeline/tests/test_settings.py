from pipeline import settings


def test_config_has_single_data_block():
    data = settings.load_config()["data"]
    assert set(data) == {"dekad", "tables", "points"}


def test_category_codes():
    assert settings.CATEGORY["agricultural"] == 0 and settings.CATEGORY["offshore"] == 7
    assert settings.LANDSCAPE == {0, 1, 2, 3}
