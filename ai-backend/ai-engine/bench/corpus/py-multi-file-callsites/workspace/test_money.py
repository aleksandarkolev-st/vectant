from money import format_amount
from api import render_invoice
from report import render_summary


def test_format_amount_value_first():
    assert format_amount(100, "USD") == "100.00 USD"


def test_invoice_uses_new_format():
    assert render_invoice(99.5) == "Total: 99.50 USD"


def test_report_uses_new_format():
    assert render_summary(7) == "Sum 7.00 EUR"
