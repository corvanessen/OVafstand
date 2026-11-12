"""Tests voor export_bike_grid.py.   python pipeline/test_export_bike_grid.py"""
import unittest

import numpy as np

from export_bike_grid import SEED_STEP, seed_bytes


class SeedBytes(unittest.TestCase):
    def test_afstand_in_stappen_afgerond(self):
        got = seed_bytes(np.array([[0.0, 100.0, 2032.0]]), np.array([[True, True, True]]))
        self.assertEqual(got.tolist(), [[0, round(100 / SEED_STEP), 254]])

    def test_te_ver_is_geen_verbinding_in_plaats_van_de_grens(self):
        # een cel over het water: 3,5 km lopen naar de brug, mag niet als 2.032 m in het bestand
        got = seed_bytes(np.array([[3500.0, 255 * SEED_STEP]]), np.array([[True, True]]))
        self.assertEqual(got.tolist(), [[255, 255]])

    def test_zonder_verbinding_blijft_255(self):
        got = seed_bytes(np.array([[np.inf, 50.0]]), np.array([[False, False]]))
        self.assertEqual(got.tolist(), [[255, 255]])


if __name__ == "__main__":
    unittest.main()
