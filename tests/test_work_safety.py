"""Only the Work credential refusal and wipe inventory safety, using temporary HOMEs."""
import base64
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

BIN = Path(__file__).resolve().parents[1] / "home/dot_local/bin"


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), str(BIN / ("executable_" + name)))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class WorkSafetyTests(unittest.TestCase):
    def test_model_wipe_refuses_symlinked_venvs_and_empty_home(self):
        template = BIN.parents[1] / ".chezmoiscripts/darwin/run_onchange_after_30-sisyphus-model-wipe.sh.tmpl"
        script = "\n".join(line for line in template.read_text().splitlines()
                           if not line.startswith("{{") and not line.startswith("# Approval:"))
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            marker = home / ".local/state/agents/model-wipe-approved"
            marker.parent.mkdir(parents=True)
            personal = home / "Development/comfyui/keep"
            personal.parent.mkdir(parents=True)
            personal.write_text("personal")
            (home / ".venvs").symlink_to(home / "Development")
            bin_dir = home / "bin"
            bin_dir.mkdir()
            sudo = bin_dir / "sudo"
            sudo.write_text('#!/bin/sh\nprintf "called" >>"$HOME/sudo-called"\nexit 1\n')
            sudo.chmod(0o755)
            env = dict(os.environ, HOME=temp, PATH=f"{bin_dir}:{os.environ['PATH']}")
            skipped = subprocess.run(["sh"], input=script, env=env, capture_output=True, text=True)
            self.assertEqual(skipped.returncode, 0)
            marker.touch()
            refused = subprocess.run(["sh"], input=script, env=env, capture_output=True, text=True)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("Unsafe model wipe path", refused.stderr)
            self.assertEqual(personal.read_text(), "personal")
            self.assertFalse((home / "sudo-called").exists())
            empty = subprocess.run(["sh"], input=script, env=dict(env, HOME=""), capture_output=True, text=True)
            self.assertNotEqual(empty.returncode, 0)
            self.assertIn("nonempty HOME", empty.stderr)

    def test_authorized_keys_preserves_invalid_or_empty_key_and_restricts_valid_key(self):
        template = (BIN.parents[1] / "dot_ssh/modify_authorized_keys.tmpl").read_text()
        blob = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
        valid = "ssh-ed25519 " + base64.b64encode(blob).decode() + " work-inbox"
        existing = "ssh-ed25519 operator-key jan\nold-restricted-key agents-work-inbox\n"
        with tempfile.TemporaryDirectory() as home:
            for key in ("", "not a key", "ssh-ed25519 AAAA", valid):
                script = template.replace('{{ if eq .chezmoi.hostname "aether" -}}', '').replace('{{ end -}}', '')
                script = script.replace('{{ .workInbox.publicKey | toJson | toJson }}', json.dumps(json.dumps(key)))
                script = script.replace('{{ .workInbox.sourceAddress | toJson | toJson }}', json.dumps(json.dumps("100.103.124.32")))
                result = subprocess.run(["python3", "-c", script], input=existing, capture_output=True,
                                        text=True, env=dict(os.environ, HOME=home))
                with self.subTest(key=key):
                    if not key:
                        self.assertEqual(result.returncode, 0)
                        self.assertEqual(result.stdout, existing)
                    elif key != valid:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(result.stdout, "")
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(result.stdout.splitlines()[0], existing.splitlines()[0])
                        managed = result.stdout.splitlines()[1]
                        for option in ('command="/home/ubuntu/.local/bin/agent-run --remote-inbox"',
                                       'from="100.103.124.32"', "no-pty", "no-port-forwarding",
                                       "no-agent-forwarding", "no-X11-forwarding", "no-user-rc"):
                            self.assertIn(option, managed)
                        self.assertEqual(len(result.stdout.splitlines()), 2)

    def test_work_creds_refuses_without_session_token_before_ssh(self):
        creds = load("work-creds-send")
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"HOME": home}), \
                patch.object(creds.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [], 0, "export AWS_ACCESS_KEY_ID=static\nexport AWS_SECRET_ACCESS_KEY=secret\n")) as run:
            with self.assertRaisesRegex(ValueError, "without AWS_SESSION_TOKEN"):
                creds.send("WBD/dev/ReadOnly")
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][0], "aws")

    def test_work_wipe_requires_really_and_never_lists_development(self):
        wipe = load("work-wipe")
        for host in ("hermes", "sisyphus"):
            with self.subTest(host=host), tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"HOME": temp}):
                home = Path(temp)
                for relative in ("Work/work/notes", "Development/keep", ".talos", ".aws", ".kube/cache"):
                    (home / relative).mkdir(parents=True)
                (home / ".kube/config").write_text("homelab")
                (home / ".kube/eu-west-1-tools-v3").write_text("work")
                sessions = home / ".pi/agent/sessions"
                sessions.mkdir(parents=True)
                work_session = sessions / ("--" + str(home / "Work/work").lstrip("/").replace("/", "-") + "--")
                work_session.mkdir()
                (work_session / "session.jsonl").write_text(json.dumps({"type": "session", "cwd": str(home / "Work/work")}) + "\n")
                ambiguous = sessions / ("--" + str(home / "Work-personal").lstrip("/").replace("/", "-") + "--")
                ambiguous.mkdir()
                (ambiguous / "session.jsonl").write_text(json.dumps({"type": "session", "cwd": str(home / "Work-personal")}) + "\n")
                personal = sessions / ("--" + str(home / "Development/keep").lstrip("/").replace("/", "-") + "--")
                personal.mkdir()
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    wipe.wipe(home, host)
                self.assertIn("requires --really", output.getvalue())
                self.assertNotIn(str(home / "Development"), output.getvalue())
                self.assertNotIn(str(home / ".talos"), output.getvalue())
                self.assertTrue((home / "Work/work/notes").is_dir())
                self.assertTrue(work_session.is_dir())
                with contextlib.redirect_stdout(io.StringIO()):
                    wipe.wipe(home, host, really=True)
                self.assertFalse((home / "Work").exists())
                self.assertFalse(work_session.exists())
                self.assertFalse((home / ".aws").exists())
                self.assertFalse((home / ".kube/eu-west-1-tools-v3").exists())
                self.assertEqual((home / ".kube/config").read_text(), "homelab")
                self.assertTrue((home / ".kube/cache").is_dir())
                self.assertTrue((home / "Development/keep").is_dir())
                self.assertTrue((home / ".talos").is_dir())
                self.assertTrue(personal.is_dir())
                self.assertTrue(ambiguous.is_dir())


if __name__ == "__main__":
    unittest.main()
