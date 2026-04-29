from money import format_amount


def render_invoice(amount):
    return "Total: " + format_amount(amount, "USD")
