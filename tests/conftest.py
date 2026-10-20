import os

# main.py refuses to start without a DB password; tests that need a real database use the DB_* variables.
os.environ.setdefault("DB_PASSWORD", "test")
