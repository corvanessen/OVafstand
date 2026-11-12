"""Tests voor de argumenten van build_bike_grid.py en export_bike_grid.py.   python pipeline/test_build_bike_grid.py"""
import contextlib
import io
import unittest

from build_bike_grid import parse_args
from days import BASE


class ParseArgs(unittest.TestCase):
    def fails(self, argv):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parse_args(argv)

    def test_standaard_fiets_op_de_basisdag(self):
        a = parse_args([])
        self.assertEqual((a.profile, a.date), ("bike", BASE))

    def test_lopen_met_spatie_of_isteken(self):
        self.assertEqual(parse_args(["--profile", "foot"]).profile, "foot")
        self.assertEqual(parse_args(["--profile=foot"]).profile, "foot")

    def test_profiel_bike_is_geen_datum(self):
        a = parse_args(["--profile", "bike", "20261117"])
        self.assertEqual((a.profile, a.date), ("bike", "20261117"))

    def test_onbekend_of_ontbrekend_profiel_stopt(self):
        self.fails(["--profile"])
        self.fails(["--profile", "auto"])

    def test_datum_alleen_als_acht_cijfers(self):
        self.fails(["bike"])
        self.fails(["2026111"])


if __name__ == "__main__":
    unittest.main()
