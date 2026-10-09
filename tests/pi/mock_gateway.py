"""Minimal OpenAI-compatible chat endpoint standing in for LiteLLM in tests/pi/integration.test.zsh.

Behaviour per model comes from <dir>/gateway.json:
  {"<model>": {"status": 429, "message": "...", "fail_times": N}}   fail N times (default: always)
  {"<model>": {"script": [{"tool": "bash", "args": {...}}, ...]}}   one tool call per step; step = tool
                                                                    results so far, then "RESULT: <last result>"
  {"<model>": {"batch": [{"tool": "read", "args": {...}}, ...]}}  calls in one assistant message
  {"<model>": {"reply": "text"}}                                      a fixed answer
Models without an entry stream back "MOCK-OK <model>". Every request is appended to <dir>/gateway.log.
"""

import json
import os
import sys
import time

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

    def json_response(self, payload, status=200):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/v1/namespaces/briefing"):
            return self.json_response({"namespace": "homelab/plain", "scope_header": "Scope: homelab/plain",
                "pinned": [{"id": "brief", "content": "PI-SMOKE synthetic briefing evidence", "tier": "semantic"}],
                "facts": [], "procedures": [], "recent": []})
        if self.path.startswith("/healthz"):
            return self.json_response({"deps": {"llm": {"configured": False}}})
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        global rules_seen
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path == "/v1/handshake":
            return self.json_response({"namespace": "homelab/plain", "namespace_source": "mock", "read_set": [], "settings": {}})
        if self.path == "/v1/search":
            with open(os.path.join(DIR, "gateway.log"), "a") as f:
                f.write(json.dumps({"model": "memini-search"}) + "\n")
            return self.json_response({"results": [{"memory": {"id": "recall", "content": "PI-SMOKE synthetic recall evidence", "tier": "semantic"}, "score": 0.99}]})
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
                "memory_context": "synthetic recall evidence" in text and "synthetic briefing evidence" in text,
                "tools": sorted(t.get("function", {}).get("name", "") for t in body.get("tools", []) or []),
                "t": time.time(),
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
        if (rule or {}).get("delay_ms"):
            time.sleep(min(3000, rule["delay_ms"]) / 1000)
        messages = body.get("messages", [])
        results = [m for m in messages if m.get("role") == "tool"]
        script = (rule or {}).get("script")
        batch = (rule or {}).get("batch")
        steps = batch if batch is not None and not results else [script[len(results)]] if script is not None and len(results) < len(script) else []
        usage = {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15}
        if steps:
            calls = [{"index": i, "id": f"call_{len(results) + i}", "type": "function",
                      "function": {"name": step["tool"], "arguments": json.dumps(step.get("args", {}))}} for i, step in enumerate(steps)]
            chunks = (
                {"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": calls}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], "usage": usage},
            )
        else:
            if (rule or {}).get("reply") is not None:
                reply = rule["reply"]
            elif script is not None or batch is not None:
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
