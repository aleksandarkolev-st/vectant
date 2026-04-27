"""Compute total inventory value. Has a type bug: `quantity` is parsed
as a string from CSV but the multiplication assumes an int."""
from typing import Iterable, Mapping


def total_value(rows: Iterable[Mapping[str, str]]) -> float:
    total = 0.0
    for row in rows:
        # Bug: row["quantity"] is a str; mypy will flag the multiplication.
        total += row["quantity"] * float(row["unit_price"])
    return total
