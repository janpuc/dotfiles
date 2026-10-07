"""Drive one Pi RPC session through prompt → compact → prompt for tests/pi/smoke.zsh.

Usage: rpc_compact.py QUESTION -- PI_COMMAND...   (run from the session's cwd)
Prints a JSON summary: session file, compaction result and the answers.
"""

import json
import subprocess
import sys

question = sys.argv[1]
cmd = sys.argv[sys.argv.index("--") + 1 :]
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)


def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def until(pred):
    answer = ""
    for line in proc.stdout:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant":
            answer = " ".join(c.get("text", "") for c in event["message"].get("content", []) if c.get("type") == "text") or answer
        if pred(event):
            return event, answer
    raise SystemExit("pi exited early")


summary = {}
send({"id": "q1", "type": "prompt", "message": question})
_, summary["before"] = until(lambda e: e.get("type") == "agent_settled")
send({"id": "q2", "type": "prompt", "message": "Write three short sentences about tides."})
until(lambda e: e.get("type") == "agent_settled")
send({"id": "c", "type": "compact"})
event, _ = until(lambda e: e.get("type") == "response" and e.get("command") == "compact")
summary["compacted"] = bool(event.get("success"))
summary["compact_error"] = event.get("error")
send({"id": "q3", "type": "prompt", "message": question})
_, summary["after"] = until(lambda e: e.get("type") == "agent_settled")
send({"id": "s", "type": "get_state"})
event, _ = until(lambda e: e.get("type") == "response" and e.get("command") == "get_state")
summary["session_file"] = event.get("data", {}).get("sessionFile")
summary["session_id"] = event.get("data", {}).get("sessionId")
proc.stdin.close()
proc.wait(timeout=60)
print(json.dumps(summary))
