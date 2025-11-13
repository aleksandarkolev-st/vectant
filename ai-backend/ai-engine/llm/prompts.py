def build_prompt(code: str, lang: str):
    return f"""
You are an AI code reviewer for Synthi Cloud IDE.
Language: {lang}

Analyze this code and give:
1. Bugs
2. Improvements
3. Refactor suggestions

Code:
{code}
"""
