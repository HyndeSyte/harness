"""The harness controller.

A small deterministic program that owns his Telegram thread, keeps the
ledger, and holds the only keys that can change anything. Models are
engines: they read what the controller hands them and return an answer
or a typed proposal. They never hold a credential.

Design of record: DESIGN-v1.4 (2026-10-05), option A, chosen after four
adversarial review rounds.
"""

__version__ = "0.1.0"
