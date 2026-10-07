"""Minimal OpenAI-compatible chat endpoint standing in for LiteLLM in tests/pi/integration.test.zsh.

Behaviour per model comes from <dir>/gateway.json:
  {"<model>": {"status": 429, "message": "...", "fail_times": N}}   fail N times (default: always)
  {"<model>": {"script": [{"tool": "bash", "args": {...}}, ...]}}   one tool call per step; step = tool
                                                                    results so far, then "RESULT: <last result>"
  {"<model>": {"reply": "text"}}                                      a fixed answer (e.g. a router's JSON)
Models without an entry stream back "MOCK-OK <model>". Every request is appended to <dir>/gateway.log.
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIR = sys.argv[1]
counts: dict[str, int] = {}
rules_seen = None  # failure counters restart whenever gateway.json changes


def has_image(messages) -> bool:
    for m in messages:
        c = m.get("content")
        if isinstance(c, list) and any(p.get("type") in ("image_url", "image") for p in c if isinstance(p, dict)):
            return True
    return False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def decisions(self, body):
        """OpenAI Decisions API: gateway.json {"decisions": {"answer": {...}} | {"status": N}}."""
        try:
            rule = json.loads(open(os.path.join(DIR, "gateway.json")).read()).get("decisions", {})
        except (OSError, ValueError):
            rule = {}
        with open(os.path.join(DIR, "gateway.log"), "a") as f:
            q = (body.get("questions") or [{}])[0]
            f.write(json.dumps({
                "model": "decisions:" + body.get("model", "?"),
                "auth": bool(self.headers.get("Authorization")),
                "marker": "PI-SMOKE" in json.dumps(body.get("input", "")),
                "choices": [c.get("value") for c in q.get("choices", [])],
            }) + "\n")
        status = rule.get("status", 200 if "answer" in rule else 500)
        payload = json.dumps({"answers": [rule["answer"]]} if status == 200 else {"error": {"message": "mock"}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        global rules_seen
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path.rstrip("/").endswith("/decisions"):
            return self.decisions(body)
        model = body.get("model", "?")
        try:
            raw = open(os.path.join(DIR, "gateway.json")).read()
        except OSError:
            raw = "{}"
        if raw != rules_seen:
            rules_seen = raw
            counts.clear()
        counts[model] = counts.get(model, 0) + 1
        text = json.dumps(body.get("messages", []))
        with open(os.path.join(DIR, "gateway.log"), "a") as f:
            f.write(json.dumps({
                "model": model,
                "auth": bool(self.headers.get("Authorization")),
                "images": has_image(body.get("messages", [])),
                "reasoning_effort": body.get("reasoning_effort"),
                "marker": "PI-SMOKE" in text,
                "tools": sorted(t.get("function", {}).get("name", "") for t in body.get("tools", []) or []),
            }) + "\n")
        try:
            rules = json.loads(raw)
        except ValueError:
            rules = {}
        rule = rules.get(model)
        if rule and "message" in rule and counts[model] <= rule.get("fail_times", 10**9):
            payload = json.dumps({"error": {"message": rule["message"], "type": "mock", "code": rule.get("status")}}).encode()
            self.send_response(rule.get("status", 500))
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        messages = body.get("messages", [])
        results = [m for m in messages if m.get("role") == "tool"]
        script = (rule or {}).get("script")
        usage = {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15}
        if script is not None and len(results) < len(script):
            step = script[len(results)]
            call = {"index": 0, "id": f"call_{len(results)}", "type": "function",
                    "function": {"name": step["tool"], "arguments": json.dumps(step.get("args", {}))}}
            chunks = (
                {"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [call]}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], "usage": usage},
            )
        else:
            if (rule or {}).get("reply") is not None:
                reply = rule["reply"]
            elif script is not None:
                last = results[-1].get("content", "") if results else ""
                if isinstance(last, list):
                    last = " ".join(p.get("text", "") for p in last if isinstance(p, dict))
                reply = f"RESULT: {last}"
            else:
                reply = f"MOCK-OK {model}"
            chunks = (
                {"choices": [{"index": 0, "delta": {"role": "assistant", "content": reply}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage},
            )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for chunk in chunks:
            chunk.update({"id": "mock", "object": "chat.completion.chunk", "created": 0, "model": model})
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(os.path.join(DIR, "gateway.port"), "w") as f:
    f.write(str(server.server_port))
server.serve_forever()
