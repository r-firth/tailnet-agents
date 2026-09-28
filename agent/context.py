"""Bound model input, never the durable records kept in Vecgra."""

import json

MAX_CONTEXT_BYTES = 240_000
MAX_TOOL_BYTES = 48_000
MAX_EVENT_BYTES = 16_000


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def size(value):
    return len(encode(value).encode("utf-8"))


def excerpt(text, budget):
    marker = "\n[Context excerpt; full value retained in memory]\n"
    if size(marker) > budget:
        return "…" if budget >= 5 else None
    low, high = 0, len(text)
    while low < high:
        count = (low + high + 1) // 2
        head = count * 3 // 4
        tail = count - head
        candidate = text[:head] + marker + (text[-tail:] if tail else "")
        if size(candidate) <= budget:
            low = count
        else:
            high = count - 1
    head = low * 3 // 4
    tail = low - head
    return text[:head] + marker + (text[-tail:] if tail else "")


def compact(value, budget=MAX_TOOL_BYTES, depth=0):
    """Keep small fields (IDs, status, URLs) intact; share space among large ones."""
    if size(value) <= budget:
        return value
    if isinstance(value, str):
        return excerpt(value, budget)
    if depth >= 12 or not isinstance(value, (dict, list)):
        return excerpt(encode(value), budget)
    if isinstance(value, list) and len(value) > 40:
        value = [*value[:40], {"_context_omitted_items": len(value) - 40}]
    entries = list(value.items()) if isinstance(value, dict) else list(enumerate(value))
    empty = (
        {key: None for key, _ in entries}
        if isinstance(value, dict)
        else [None] * len(entries)
    )
    remaining = budget - (size(empty) - 4 * len(entries))
    if remaining < 64 * len(entries):
        return excerpt(encode(value), budget)
    allocations = {}
    lengths = [(key, size(child)) for key, child in entries]
    for index, (key, length) in enumerate(sorted(lengths, key=lambda item: item[1])):
        allocation = min(length, remaining // (len(entries) - index))
        allocations[key] = allocation
        remaining -= allocation
    children = [
        (key, compact(child, allocations[key], depth + 1)) for key, child in entries
    ]
    result = (
        dict(children) if isinstance(value, dict) else [child for _, child in children]
    )
    return result if size(result) <= budget else excerpt(encode(result), budget)


def tool_context(receipts):
    return encode(compact({"tool_receipts": receipts}, MAX_TOOL_BYTES))


def conversation_context(task):
    history = task["history"]
    latest_user = next(
        (
            i
            for i in range(len(history) - 1, -1, -1)
            if history[i]["kind"] == "message.user"
        ),
        None,
    )
    context = {
        "history": [],
        "needs_title": task.get("needs_title", False),
        "conversation": compact(task.get("conversation"), 16_000),
        "devices": compact(task["devices"], 24_000),
        "sessions": compact(task["sessions"], 16_000),
        "context_note": "Large tool results are excerpts. Full records remain in memory; event IDs and scopes identify their source. Excerpts and omitted history are not evidence that an action succeeded.",
        "omitted_history_events": len(history),
    }
    remaining = MAX_CONTEXT_BYTES - size(context) - 256
    selected = {}
    if latest_user is not None:
        # The server validates user messages at 64 KB. Reserve the current
        # request before spending any space on old output or tool receipts.
        event = history[latest_user]
        if size(event) > remaining:
            raise ValueError("The latest message is too large for the agent context")
        selected[latest_user] = event
        remaining -= size(event) + 1
    for index in range(len(history) - 1, max(-1, len(history) - 101), -1):
        if index == latest_user:
            continue
        event = history[index]
        projected = {key: value for key, value in event.items() if key != "payload"}
        projected["payload"] = compact(event.get("payload"), MAX_EVENT_BYTES)
        length = size(projected) + 1
        if length > remaining:
            continue
        selected[index] = projected
        remaining -= length
    context["history"] = [selected[index] for index in sorted(selected)]
    context["omitted_history_events"] = len(history) - len(selected)
    return encode(context)
