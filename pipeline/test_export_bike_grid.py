"""Tests voor export_bike_grid.py.   python pipeline/test_export_bike_grid.py"""
import unittest

import numpy as np

from export_bike_grid import SEED_STEP, seed_bytes


class SeedBytes(unittest.TestCase):
    def test_afstand_in_stappen_afgerond(self):
        got = seed_bytes(np.array([[0.0, 99.0, 2032.0]]), np.array([[True, True, True]]))
        self.assertEqual(got.tolist(), [[0, 12, 254]])

    def test_een_half_naar_boven_zoals_math_round_in_de_browser(self):
        got = seed_bytes(np.array([[100.0, 116.0]]), np.array([[True, True]]))   # 12,5 en 14,5 stappen
        self.assertEqual(got.tolist(), [[13, 15]])

    def test_halte_met_alleen_verre_startcellen_houdt_de_dichtstbijzijnde(self):
        # anders valt de halte in de browser terug op een kegel (hemelsbreed), die water negeert
        got = seed_bytes(np.array([[3000.0, 2500.0, np.inf]]), np.array([[True, True, False]]))
        self.assertEqual(got.tolist(), [[255, 254, 255]])

    def test_te_ver_is_geen_verbinding_in_plaats_van_de_grens(self):
        # een cel over het water: 3,5 km lopen naar de brug, mag niet als 2.032 m in het bestand
        # (met een nabije startcel ernaast; zie de uitzondering hieronder)
        got = seed_bytes(np.array([[99.0, 3500.0, 255 * SEED_STEP]]), np.array([[True, True, True]]))
        self.assertEqual(got.tolist(), [[12, 255, 255]])

    def test_zonder_verbinding_blijft_255(self):
        got = seed_bytes(np.array([[np.inf, 50.0]]), np.array([[False, False]]))
        self.assertEqual(got.tolist(), [[255, 255]])


if __name__ == "__main__":
    unittest.main()
