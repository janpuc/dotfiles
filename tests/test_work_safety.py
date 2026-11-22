"""Only the Work credential refusal and wipe inventory safety, using temporary HOMEs."""
import base64
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import re
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

    @staticmethod
    def authorized_keys_script(host, values):
        """Render the modifier's branch for one host without chezmoi."""
        template = (BIN.parents[1] / "private_dot_ssh/modify_authorized_keys.tmpl").read_text()
        head, rest = template.split('{{ if eq .chezmoi.hostname "aether" -}}\n')
        aether, rest = rest.split('{{ else if eq .chezmoi.hostname "sisyphus" -}}\n')
        sisyphus, rest = rest.split('{{ else if eq .chezmoi.hostname "hermes" -}}\n')
        hermes, tail = rest.split("{{ end -}}\n")
        script = head + {"aether": aether, "sisyphus": sisyphus, "hermes": hermes}.get(host, "") + tail
        script = script.replace("{{ .chezmoi.homeDir }}", "/Users/jan.pucilowski")
        return re.sub(r"\{\{ (\S+) \| toJson \| toJson \}\}",
                      lambda match: json.dumps(json.dumps(values[match.group(1)])), script)

    def run_authorized_keys(self, host, values, existing, home):
        return subprocess.run(["python3", "-c", self.authorized_keys_script(host, values)], input=existing,
                              capture_output=True, text=True, env=dict(os.environ, HOME=home))

    def test_authorized_keys_preserves_invalid_or_empty_key_and_restricts_valid_key(self):
        blob = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
        valid = "ssh-ed25519 " + base64.b64encode(blob).decode() + " work-inbox"
        existing = "ssh-ed25519 operator-key jan\nold-restricted-key agents-work-inbox\n"
        with tempfile.TemporaryDirectory() as home:
            for key in ("", "not a key", "ssh-ed25519 AAAA", valid):
                result = self.run_authorized_keys("aether", {
                    ".workInbox.publicKey": key, ".workInbox.sourceAddress": "100.103.124.32"}, existing, home)
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
                        for option in ('command="/Users/jan.pucilowski/.local/bin/agent --remote-inbox"',
                                       'from="100.103.124.32"', "no-pty", "no-port-forwarding",
                                       "no-agent-forwarding", "no-X11-forwarding", "no-user-rc"):
                            self.assertIn(option, managed)
                        self.assertEqual(len(result.stdout.splitlines()), 2)

    def test_authorized_keys_on_sisyphus_forces_main_endpoint_and_keeps_operator_keys(self):
        blob = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
        valid = "ssh-ed25519 " + base64.b64encode(blob).decode()
        existing = "ssh-rsa operator-key mac-models\nstale agents-main\n"
        keys = {".agentSsh.mainSisyphus.sourceAddress": "100.108.252.49",
                ".agentSsh.hermesSisyphus.sourceAddress": "100.68.4.107"}
        with tempfile.TemporaryDirectory() as home:
            empty = self.run_authorized_keys("sisyphus", dict(keys, **{
                ".agentSsh.mainSisyphus.publicKey": "", ".agentSsh.hermesSisyphus.publicKey": ""}), existing, home)
            self.assertEqual((empty.returncode, empty.stdout), (0, existing))
            bad = self.run_authorized_keys("sisyphus", dict(keys, **{
                ".agentSsh.mainSisyphus.publicKey": "ssh-rsa AAAA", ".agentSsh.hermesSisyphus.publicKey": ""}),
                existing, home)
            self.assertNotEqual(bad.returncode, 0)
            self.assertEqual(bad.stdout, "")
            result = self.run_authorized_keys("sisyphus", dict(keys, **{
                ".agentSsh.mainSisyphus.publicKey": valid + " main", ".agentSsh.hermesSisyphus.publicKey": valid}),
                existing, home)
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = result.stdout.splitlines()
            self.assertEqual(len(lines), 3)
            self.assertEqual(lines[0], "ssh-rsa operator-key mac-models")
            main = next(line for line in lines if line.endswith(" agents-main"))
            for option in ('command="/Users/jan.pucilowski/.local/bin/agent --main-endpoint"', 'from="100.108.252.49"', "no-pty", "no-port-forwarding",
                           "no-agent-forwarding", "no-X11-forwarding", "no-user-rc"):
                self.assertIn(option, main)
            hermes = next(line for line in lines if line.endswith(" agents-hermes"))
            self.assertIn('from="100.68.4.107"', hermes)
            self.assertNotIn("command=", hermes)
            self.assertNotIn("stale", result.stdout)
            other = self.run_authorized_keys("bc250", {}, existing, home)
            self.assertEqual((other.returncode, other.stdout), (0, existing))

    def test_authorized_keys_on_hermes_forces_worker_endpoint_and_keeps_operator_keys(self):
        blob = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
        valid = "ssh-ed25519 " + base64.b64encode(blob).decode() + " aether-worker-hermes"
        existing = "ssh-ed25519 operator-key jan\nstale agents-aether-worker\n"
        address = {".agentSsh.aetherHermes.sourceAddress": "100.108.252.49"}
        with tempfile.TemporaryDirectory() as home:
            empty = self.run_authorized_keys("hermes", dict(address, **{".agentSsh.aetherHermes.publicKey": ""}), existing, home)
            self.assertEqual((empty.returncode, empty.stdout), (0, existing))
            result = self.run_authorized_keys("hermes", dict(address, **{".agentSsh.aetherHermes.publicKey": valid}), existing, home)
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = result.stdout.splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(lines[0], "ssh-ed25519 operator-key jan")
            self.assertTrue(lines[1].endswith(" agents-aether-worker"))
            for option in ('command="/Users/jan.pucilowski/.local/bin/agent --worker-endpoint"', 'from="100.108.252.49"',
                           "no-pty", "no-port-forwarding", "no-agent-forwarding", "no-X11-forwarding", "no-user-rc"):
                self.assertIn(option, lines[1])

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

    @staticmethod
    def migrated_digest(wipe, home):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            wipe.wipe(home, "hermes", migrated=True)
        return re.search(r"Inventory: ([0-9a-f]{64})", output.getvalue()).group(1)

    def test_work_wipe_migrated_keeps_credentials_and_runs_only_on_hermes(self):
        wipe = load("work-wipe")
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"HOME": temp}):
            home = Path(temp)
            for relative in ("Work/work/notes", "Work/infra", "Development/keep", ".aws", ".granted", ".kube/clusters"):
                (home / relative).mkdir(parents=True)
            (home / "Work/work/notes/STATE.md").write_text("state")
            env = home / ".local/state/ai/projects"
            env.mkdir(parents=True)
            (env / "work.env").write_text("x")
            sessions = home / ".pi/agent/sessions"
            sessions.mkdir(parents=True)
            work_session = sessions / ("--" + str(home / "Work/work").lstrip("/").replace("/", "-") + "--")
            work_session.mkdir()
            (work_session / "s.jsonl").write_text(json.dumps({"type": "session", "cwd": str(home / "Work/work")}) + "\n")
            personal = sessions / ("--" + str(home / "Development/keep").lstrip("/").replace("/", "-") + "--")
            personal.mkdir()
            with self.assertRaisesRegex(ValueError, "only for hermes"):
                wipe.wipe(home, "sisyphus", migrated=True)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                wipe.wipe(home, "hermes", migrated=True)
            listed = output.getvalue()
            self.assertIn("Dry run only, --really --inventory <hash> moves this aside", listed)
            self.assertIn(str(home / "Work/work"), listed)
            self.assertIn(str(work_session), listed)
            self.assertRegex(listed, r"Entries: 6, bytes: \d+, newest change: 20")
            for kept in (".aws", ".granted", ".kube", ".local/state/ai", "Development"):
                self.assertNotIn(str(home / kept), listed)
            self.assertTrue((home / "Work/work/notes/STATE.md").exists())
            digest = re.search(r"Inventory: ([0-9a-f]{64})", listed).group(1)
            with self.assertRaisesRegex(ValueError, "inventory changed"):
                wipe.wipe(home, "hermes", really=True, migrated=True)
            (home / "Work/work/notes/NEW.md").write_text("intake after the review")
            with self.assertRaisesRegex(ValueError, "inventory changed"):
                wipe.wipe(home, "hermes", really=True, migrated=True, inventory=digest)
            self.assertTrue((home / "Work/work/notes/STATE.md").exists())
            (home / "Work/work/notes/NEW.md").unlink()
            again = io.StringIO()
            with contextlib.redirect_stdout(again):
                wipe.wipe(home, "hermes", migrated=True)
            digest = re.search(r"Inventory: ([0-9a-f]{64})", again.getvalue()).group(1)
            state = home / "Work/work/notes/STATE.md"
            # A replacement with the same size and times is a different file and refuses.
            before, folder = state.stat(), state.parent.stat()
            swap = home / "Work/work/notes/swap"
            swap.write_text("STATE")
            os.utime(swap, ns=(before.st_atime_ns, before.st_mtime_ns))
            os.rename(swap, state)
            os.utime(state.parent, ns=(folder.st_atime_ns, folder.st_mtime_ns))
            with self.assertRaisesRegex(ValueError, "inventory changed"):
                wipe.wipe(home, "hermes", really=True, migrated=True, inventory=digest)
            digest = self.migrated_digest(wipe, home)
            # Intake after the check but before the move is caught once moved aside: all goes back.
            real_summary = wipe.summary
            calls = []
            def intake_before_move(units):
                result = real_summary(units)
                calls.append(1)
                if len(calls) == 1:
                    (home / "Work/work/notes/LATE.md").write_text("late intake")
                return result
            with patch.object(wipe, "summary", intake_before_move), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "changed while it was moved aside.*everything is back"):
                    wipe.wipe(home, "hermes", really=True, migrated=True, inventory=digest)
            self.assertEqual(state.read_text(), "STATE")
            self.assertEqual((home / "Work/work/notes/LATE.md").read_text(), "late intake")
            self.assertTrue(work_session.is_dir())
            self.assertEqual(list(home.glob(".work-wipe-*")), [])
            (home / "Work/work/notes/LATE.md").unlink()
            digest = self.migrated_digest(wipe, home)
            # A move that fails part way puts back what it already moved.
            real_rename = os.rename
            def fail_second(source, target):
                if Path(target).name == "1":
                    raise OSError("session folder vanished")
                return real_rename(source, target)
            with patch.object(wipe.os, "rename", fail_second), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "session folder vanished.*everything is back"):
                    wipe.wipe(home, "hermes", really=True, migrated=True, inventory=digest)
            self.assertEqual(state.read_text(), "STATE")
            self.assertTrue(work_session.is_dir())
            self.assertEqual(list(home.glob(".work-wipe-*")), [])
            # A failed MOVED.txt write rolls back too.
            real_write = Path.write_text
            def no_manifest(path, *args, **kwargs):
                if path.name == "MOVED.txt":
                    raise OSError("disk full")
                return real_write(path, *args, **kwargs)
            with patch.object(wipe.Path, "write_text", no_manifest), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "disk full.*everything is back"):
                    wipe.wipe(home, "hermes", really=True, migrated=True, inventory=digest)
            self.assertEqual(state.read_text(), "STATE")
            self.assertTrue(work_session.is_dir())
            self.assertEqual(list(home.glob(".work-wipe-*")), [])
            # Rollback never replaces what appeared at an original path, it keeps both and says where.
            def replaced_meanwhile(units):
                calls.append(1)
                if len(calls) == 2:
                    (home / "Work/NEW.md").write_text("new intake")
                    # The unit moved aside turned out to be a file, swapped in after the check.
                    [moved_session] = [actual for actual, _, own in units if own]
                    os.rename(moved_session, home / "stash")
                    moved_session.write_text("swapped in")
                    work_session.write_text("a file where the session folder was")
                    return "mismatch"
                return real_summary(units)
            calls.clear()
            with patch.object(wipe, "summary", replaced_meanwhile), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "changed while it was moved aside.*stay where they are") as caught:
                    wipe.wipe(home, "hermes", really=True, migrated=True, inventory=digest)
            [aside] = home.glob(".work-wipe-*")
            self.assertIn(f"{aside / '0'} (was {home / 'Work'})", str(caught.exception))
            self.assertIn(f"{aside / '1'} (was {work_session})", str(caught.exception))
            self.assertEqual(work_session.read_text(), "a file where the session folder was")
            self.assertEqual((home / "Work/NEW.md").read_text(), "new intake")
            self.assertEqual((aside / "0/work/notes/STATE.md").read_text(), "STATE")
            # Put the test tree back by hand, as Jan would from the reported paths.
            work_session.unlink()
            (home / "Work/NEW.md").unlink()
            (home / "Work").rmdir()
            (aside / "1").unlink()
            os.rename(home / "stash", work_session)
            os.rename(aside / "0", home / "Work")
            aside.rmdir()
            digest = self.migrated_digest(wipe, home)
            # Intake after the move lands in the new empty ~/Work. A writer that kept a folder open
            # writes into the moved tree after the check. Both survive, nothing is deleted.
            held = os.open(home / "Work/work/notes", os.O_RDONLY)
            calls.clear()
            def intake_after_move(units):
                calls.append(1)
                if len(calls) == 2:
                    (home / "Work/AFTER.md").write_text("after the move")
                result = real_summary(units)
                if len(calls) == 2:
                    late = os.open("HELD.md", os.O_WRONLY | os.O_CREAT, 0o600, dir_fd=held)
                    os.write(late, b"held open")
                    os.close(late)
                return result
            try:
                with patch.object(wipe, "summary", intake_after_move), contextlib.redirect_stdout(io.StringIO()) as moved:
                    wipe.wipe(home, "hermes", really=True, migrated=True, inventory=digest)
            finally:
                os.close(held)
            self.assertIn("Nothing is deleted yet", moved.getvalue())
            self.assertEqual([p.name for p in (home / "Work").iterdir()], ["AFTER.md"])
            [aside] = home.glob(".work-wipe-*")
            self.assertEqual((aside / "0/work/notes/STATE.md").read_text(), "STATE")
            self.assertEqual((aside / "0/work/notes/HELD.md").read_text(), "held open")
            self.assertTrue((aside / "1").is_dir())
            self.assertEqual((aside / "MOVED.txt").read_text(), f"0\t{home / 'Work'}\n1\t{work_session}\n")
            self.assertFalse(work_session.exists())
            for kept in (".aws", ".granted", ".kube/clusters", ".local/state/ai/projects/work.env", "Development/keep"):
                self.assertTrue((home / kept).exists(), kept)
            self.assertTrue(personal.is_dir())


if __name__ == "__main__":
    unittest.main()
