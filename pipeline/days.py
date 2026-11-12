"""De dagen uit de GTFS-feed waar de kaart op rekent: één plek voor alle scripts in pipeline/.

BASE is de werkdag (de basis van de graaf); DAYS zijn werkdag, zaterdag en zondag, in die volgorde.
Kies een dinsdag of woensdag buiten de schoolvakanties, en controleer met feed_days.py dat elke
vervoerder op die dagen rijdt.
"""
BASE = "20261117"
DAYS = [BASE, "20261121", "20261122"]
