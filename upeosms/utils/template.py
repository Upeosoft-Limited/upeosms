import re

VAR_PATTERN = re.compile(r"\{([a-zA-Z0-9_]+)\}")

def normalize_key(key: str) -> str:
    return (
        str(key or "")
        .strip()
        .lower()
        .replace(" ", "_")
        .replace("-", "_")
        .replace("/", "_")
    )

def extract_variables(template: str) -> list[str]:
    if not template:
        return []
    return sorted(set(VAR_PATTERN.findall(template)))

def render_message(template: str, data: dict) -> str:
    message = template or ""
    for key, value in (data or {}).items():
        message = message.replace("{" + str(key) + "}", "" if value is None else str(value))
    return message