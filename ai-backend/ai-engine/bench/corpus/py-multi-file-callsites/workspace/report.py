from money import format_amount


def render_summary(amount, currency="EUR"):
    return f"Sum {format_amount(amount, currency)}"
