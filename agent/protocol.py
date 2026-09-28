"""Validate complete workspace tool batches before allowing any side effects."""

import json

from jsonschema import ValidationError, validate


class ToolProtocolError(ValueError):
    pass


def parse_decision(value, schema):
    try:
        decision = json.loads(value) if isinstance(value, str) else value
    except json.JSONDecodeError as error:
        raise ToolProtocolError(
            f"Response JSON: {error.msg} at line {error.lineno}, column {error.colno}."
        ) from None
    try:
        validate(decision, schema)
    except ValidationError as error:
        location = "/".join(str(part) for part in error.absolute_path) or "response"
        raise ToolProtocolError(f"Invalid response shape at {location}.") from None
    calls = []
    for index, call in enumerate(decision["tools"]):
        try:
            arguments = json.loads(call["arguments_json"])
        except json.JSONDecodeError as error:
            raise ToolProtocolError(
                f"Tool {index + 1} ({call['name']}) arguments_json: {error.msg} "
                f"at line {error.lineno}, column {error.colno}."
            ) from None
        if not isinstance(arguments, dict):
            raise ToolProtocolError(
                f"Tool {index + 1} ({call['name']}) arguments_json must encode an object."
            )
        calls.append({"name": call["name"], "arguments": arguments})
    return {**decision, "tools": calls}


def correction_prompt(error, attempts):
    if attempts >= 3:
        raise RuntimeError(
            "The agent returned malformed tool data three times. "
            "Workspace tools from those invalid batches were not executed. "
            "Send another message to continue."
        ) from None
    return json.dumps(
        {
            "tool_protocol_error": str(error),
            "instructions": (
                "Workspace tool calls in your last decision were not executed. "
                "Return a corrected decision matching the response schema. Each arguments_json "
                "must encode a valid JSON object; escape newlines, quotes and backslashes "
                "inside strings. Do not guess or change the intended command. "
                "Do not repeat successful calls from previous decisions or native tools "
                "that already ran. Their results remain in this conversation."
            ),
        }
    )
