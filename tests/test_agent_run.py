"""Offline tests for the project runner, with no Rex or GitHub mutations."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "home/dot_local/bin/executable_agent-run"
loader = importlib.machinery.SourceFileLoader("agent_run", str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
agent = importlib.util.module_from_spec(spec)
loader.exec_module(agent)


class AgentRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.folder = self.home / "Development/home"
        self.folder.mkdir(parents=True)
        self.state = self.folder / ".agent"
        self.state.mkdir()
        self.patches = [patch.object(agent, "HOME", self.home),
                        patch.object(agent, "ROOT", self.home / "Development")]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_default_generation_and_runner_lock(self):
        self.assertEqual(agent.generation(self.folder), 1)
        with (self.state / "run.lock").open("a") as lock:
            agent.fcntl.flock(lock, agent.fcntl.LOCK_EX)
            self.assertTrue(agent.running(self.folder))
        self.assertFalse(agent.running(self.folder))
        (self.state / "generation").write_text("0\n")
        with self.assertRaises(ValueError):
            agent.generation(self.folder)

    def test_reconcile_creates_once_and_restarts_in_existing_tab(self):
        sessions = []
        windows = []
        calls = []
        alive = False

        def fake_rex(*args):
            calls.append(args)
            if args[:2] == ("ls", "--json"):
                return {"sessions": sessions}
            if args[:2] == ("session", "inspect"):
                return {"windows": windows}
            if args[0] == "new":
                sessions.append({"label": "home", "session_id": "session:home"})
                windows.append({"label": "pi", "layers": [{"blocks": [{"block_id": "block:pi"}]}]})
                return {"session_id": "session:home"}
            if args[:2] == ("window", "new"):
                windows.append({"label": args[4], "layers": []})
                return {}
            if args[:2] == ("block", "call"):
                return {"child": None, "foreground": None, "last_exit": {"exit_code": 0}}
            if args[0] == "run":
                self.assertIn("--split=right", args)
                self.assertIn("--keep-open", args)
                return {"block_ids": ["block:replacement"]}
            if args[:2] == ("client", "ls"):
                return {"clients": []}
            raise AssertionError(args)

        with patch.object(agent, "rex", side_effect=fake_rex), \
             patch.object(agent, "running", side_effect=lambda _: alive), \
             patch.object(agent, "run") as command:
            agent.ensure("home", {"workspace": "janpuc/home-workspace"})
            alive = True
            agent.ensure("home", {"workspace": "janpuc/home-workspace"})
            self.assertEqual([w["label"] for w in windows], ["pi", "shell"])
            self.assertEqual(sum(c[0] == "new" for c in calls), 1)
            self.assertEqual(sum(c[0] == "run" for c in calls), 0)
            alive = False
            agent.ensure("home", {"workspace": "janpuc/home-workspace"})
            self.assertEqual(sum(c[0] == "run" for c in calls), 1)
            command.assert_called_once_with("rex", "block", "close", "-s", "session:home", "block:pi")
            self.assertEqual(len(windows), 2)

    def test_rotation_loop_passes_handoff_only_for_new_session(self):
        secrets = self.home / ".local/state/ai/projects/home.env"
        secrets.parent.mkdir(parents=True)
        token = 'test-$HOME-żółć-\\$quoted'
        secrets.write_text("HA_TOKEN=" + json.dumps(token, ensure_ascii=False).replace("$", r"\$") + "\n")
        (self.state / "handoff-1.md").write_text("first handoff")
        defaults = {"model": "provider/model", "thinking": "high", "meminiPrefix": "homelab"}
        calls = []

        def fake_pi(args, env):
            calls.append((args, env))
            if len(calls) == 1:
                self.assertEqual((self.state / "generation").read_text(), "1\n")
                (self.state / "handoff-2.md").write_text("second handoff")
                agent.atomic_write(self.state / "rotate-requested", "2\n")
            return subprocess.CompletedProcess(args, 0)

        cwd = Path.cwd()
        self.addCleanup(lambda: agent.os.chdir(cwd))
        with patch.object(agent, "run", return_value=subprocess.CompletedProcess([], 0, '{"HA_URL":"https://hass.example"}')), \
             patch.object(agent.subprocess, "run", side_effect=fake_pi):
            self.assertEqual(agent.loop("home", {"secrets": {"HA_TOKEN": "op://test"}}, defaults), 0)
        self.assertEqual(calls[0][0][-1], "first handoff")
        self.assertEqual(calls[1][0][-1], "second handoff")
        self.assertIn("home-2", calls[1][0])
        self.assertEqual(calls[0][1]["HA_TOKEN"], token)
        self.assertEqual(calls[0][1]["HA_URL"], "https://hass.example")
        self.assertEqual(calls[0][1]["MEMINI_NAMESPACE"], "homelab/home")
        self.assertEqual(calls[0][1]["PATH"].split(":")[0], str(self.home / ".local/share/mise/shims"))
        self.assertFalse((self.state / "rotate-requested").exists())
        session_dir = self.home / ".pi/agent/sessions" / ("--" + str(self.folder).lstrip("/").replace("/", "-") + "--")
        session_dir.mkdir(parents=True)
        (session_dir / "timestamp_home-2.jsonl").touch()
        # A restart after reboot finishes removal of an already-committed request.
        (self.state / "rotate-requested").write_text("2\n")
        with patch.object(agent, "run", return_value=subprocess.CompletedProcess([], 0, "{}")), \
             patch.object(agent.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as pi:
            agent.loop("home", {"secrets": {"HA_TOKEN": "op://test"}}, defaults)
            self.assertNotIn("second handoff", pi.call_args.args[0])

    def test_rotation_validates_request_and_handoff_without_changing_generation(self):
        (self.state / "generation").write_text("1\n")
        request = self.state / "rotate-requested"
        for value in ["", "garbage", "0", "1", "3"]:
            with self.subTest(value=value):
                request.write_text(value)
                with self.assertRaises(ValueError):
                    agent.consume_rotation(self.folder)
                self.assertEqual((self.state / "generation").read_text(), "1\n")
                self.assertEqual(request.read_text(), value)
        request.write_text("2\n")
        with self.assertRaisesRegex(ValueError, "without a handoff"):
            agent.consume_rotation(self.folder)
        self.assertEqual((self.state / "generation").read_text(), "1\n")
        self.assertTrue(request.exists())

    def test_rotation_recovers_request_before_or_after_generation_commit(self):
        request = self.state / "rotate-requested"
        (self.state / "generation").write_text("1\n")
        (self.state / "handoff-2.md").write_text("handoff")
        request.write_text("2\n")
        original_replace = Path.replace

        def fail_commit(path, target):
            if target == self.state / "generation":
                raise OSError("injected generation commit failure")
            return original_replace(path, target)

        with patch.object(Path, "replace", new=fail_commit):
            with self.assertRaisesRegex(OSError, "injected"):
                agent.consume_rotation(self.folder)
        self.assertEqual((self.state / "generation").read_text(), "1\n")
        self.assertEqual(request.read_text(), "2\n")
        self.assertFalse((self.state / "generation.tmp").exists())
        original_unlink = Path.unlink

        def fail_remove(path, *args, **kwargs):
            if path == request:
                raise OSError("injected request removal failure")
            return original_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", new=fail_remove):
            with self.assertRaisesRegex(OSError, "injected"):
                agent.consume_rotation(self.folder, recovering=True)
        self.assertEqual((self.state / "generation").read_text(), "2\n")
        self.assertEqual(request.read_text(), "2\n")
        self.assertTrue(agent.consume_rotation(self.folder, recovering=True))
        self.assertFalse(request.exists())
        self.assertEqual(agent.generation(self.folder), 2)
        self.assertFalse(agent.consume_rotation(self.folder))

    def test_startup_consumes_pending_request_before_launching_pi(self):
        (self.state / "generation").write_text("1\n")
        (self.state / "handoff-2.md").write_text("second handoff")
        (self.state / "rotate-requested").write_text("2\n")
        defaults = {"model": "provider/model", "thinking": "high", "meminiPrefix": "homelab"}
        cwd = Path.cwd()
        self.addCleanup(lambda: agent.os.chdir(cwd))
        with patch.object(agent, "run", return_value=subprocess.CompletedProcess([], 0, "{}")), \
             patch.object(agent.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as pi:
            self.assertEqual(agent.loop("home", {}, defaults), 0)
            self.assertEqual(pi.call_count, 1)
            self.assertIn("home-2", pi.call_args.args[0])
            self.assertEqual(pi.call_args.args[0][-1], "second handoff")
        self.assertEqual(agent.generation(self.folder), 2)
        self.assertFalse((self.state / "rotate-requested").exists())

    def test_pi_wrapper_keeps_project_path_with_absolute_node(self):
        bin_dir = self.home / "bin"
        bin_dir.mkdir()
        node = bin_dir / "node"
        node.write_text('#!/bin/sh\nprintf "%s\\n%s\\n" "$PATH" "$*"\n')
        node.chmod(0o755)
        mise = bin_dir / "mise"
        mise.write_text(f'#!/bin/sh\ncase "$2" in node) echo "{node}";; pi) echo /real/pi;; esac\n')
        mise.chmod(0o755)
        env = dict(agent.os.environ, PI_PROJECT="home", PATH=f"{bin_dir}:/usr/bin:/bin")
        result = subprocess.run(["sh", str(SOURCE.parents[2] / "dot_pi/private_agent/local/bin/executable_pi"), "--session-id", "home-1"],
                                env=env, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.splitlines(), [env["PATH"], "/real/pi --session-id home-1"])


if __name__ == "__main__":
    unittest.main()
