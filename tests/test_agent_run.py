"""Offline tests for the project runner, with no Rex or GitHub mutations."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
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
                        patch.object(agent, "ROOT", self.home / "Development"),
                        patch.dict(os.environ, {
                            "HOME": str(self.home), "PATH": os.environ["PATH"],
                            "XDG_CONFIG_HOME": str(self.home / ".config"),
                            "XDG_STATE_HOME": str(self.home / ".local/state"),
                            "XDG_DATA_HOME": str(self.home / ".local/share"),
                            "GIT_CONFIG_GLOBAL": str(self.home / ".gitconfig"),
                            "GIT_CONFIG_NOSYSTEM": "1",
                            "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
                            "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid",
                        }, clear=True)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_remote_inbox_forced_command_rejects_other_operations(self):
        with patch.object(agent, "HOST", "aether"):
            for command in ("", "bash", "deliver main", "fetch; id", "ls", "--launch ls"):
                with self.subTest(command=command), patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": command}):
                    with self.assertRaisesRegex(ValueError, "only deliver or fetch"):
                        agent.remote_inbox({"projects": {}})

    def test_main_endpoint_runs_only_three_exact_commands_on_sisyphus(self):
        for host, command in [("sisyphus", ""), ("sisyphus", "bash"), ("sisyphus", "agent ls; id"),
                              ("sisyphus", "agent ls "), ("sisyphus", "chezmoi apply"),
                              ("sisyphus", "agent restart main"), ("aether", "agent ls")]:
            with self.subTest(host=host, command=command), patch.object(agent, "HOST", host), \
                    patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": command}), \
                    patch.object(agent.subprocess, "run") as run:
                with self.assertRaisesRegex(ValueError, "main endpoint accepts only"):
                    agent.main_endpoint()
                run.assert_not_called()
        expected = {"agent ls": ["--launch", "ls"], "agent restart all": ["--launch", "restart", "all"],
                    "chezmoi update": ["chezmoi", "--no-tty", "update"]}
        for command, tail in expected.items():
            with self.subTest(command=command), patch.object(agent, "HOST", "sisyphus"), \
                    patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": command}), patch.object(agent.os, "chdir"), \
                    patch.object(agent.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
                self.assertEqual(agent.main_endpoint(), 0)
                args, kwargs = run.call_args
                self.assertEqual(args[0][-len(tail):], tail)
                self.assertIs(kwargs["stdin"], subprocess.DEVNULL)

    def test_aether_projects_queue_replies_to_work(self):
        config = {"defaults": {"host": "aether"}, "projects": {
            "main": {}, "home": {}, "work": {"host": "sisyphus"}}}
        local_projects = {name: project for name, project in config["projects"].items() if name != "work"}
        request = "20261119T075914-25fd7a"
        with patch.object(agent, "HOST", "aether"), patch.object(agent, "REGISTRY", config), \
                patch.object(agent, "remote_call") as remote, contextlib.redirect_stdout(io.StringIO()):
            for project in local_projects:
                with self.subTest(project=project), patch.dict(os.environ, {"PI_PROJECT": project}):
                    folder = agent.inbox(project)
                    folder.mkdir(parents=True, exist_ok=True)
                    (folder / f"{request}.json").write_text(json.dumps({
                        "id": request, "from": "work", "to": project, "status": "accepted", "text": "Help"}))
                    agent.reply(local_projects, project, request, "Verified")
            remote.assert_not_called()
            queue = agent.platform_state() / "remote-inbox/work"
            items = [json.loads(path.read_text()) for path in queue.glob("*.json")]
            self.assertEqual({item["from"] for item in items}, set(local_projects))
            self.assertTrue(all(item["to"] == "work" and item["inReplyTo"] == request for item in items))
            with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": "fetch"}), \
                    patch.object(agent.sys, "stdin", io.StringIO('{}')), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                agent.remote_inbox(config)
            self.assertEqual(len(json.loads(output.getvalue())), 2)

    def test_remote_inbox_validates_delivery(self):
        config = {"defaults": {"host": "aether"}, "projects": {
            "home": {}, "../escape": {}, "work": {"host": "sisyphus"}}}
        item = {"id": "20261119T075914-25fd7a", "from": "work", "to": "home", "text": "Help", "status": "new"}
        agent.record_initialization("home", "adopted")
        with patch.object(agent, "HOST", "aether"), patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": "deliver"}):
            for changes in ({"from": "main"}, {"to": "../escape"}, {"to": "work"}, {"id": "../escape"},
                            {"text": "x" * agent.REMOTE_LIMIT}):
                with self.subTest(changes=list(changes)), \
                        patch.object(agent.sys, "stdin", io.StringIO(json.dumps(dict(item, **changes)))):
                    with self.assertRaises(ValueError):
                        agent.remote_inbox(config)
            agent.record_initialization("home", "adopted", "initializing")
            with patch.object(agent.sys, "stdin", io.StringIO(json.dumps(item))):
                with self.assertRaisesRegex(ValueError, "not initialized"):
                    agent.remote_inbox(config)
            agent.record_initialization("home", "adopted")
            with patch.object(agent.sys, "stdin", io.StringIO(json.dumps(item))), \
                    contextlib.redirect_stdout(io.StringIO()):
                agent.remote_inbox(config)
            self.assertTrue((agent.inbox("home") / f"{item['id']}.json").is_file())

    def test_remote_inbox_fetch_refuses_symlinks(self):
        queue = agent.work_reply_queue()
        queue.mkdir(parents=True)
        outside = self.home / "private.json"
        outside.write_text('{"secret": "not a reply"}')
        link = queue / "20261119T075914-25fd7a.json"
        link.symlink_to(outside)
        with patch.object(agent, "HOST", "aether"), patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": "fetch"}), \
                patch.object(agent.sys, "stdin", io.StringIO('{}')):
            with self.assertRaisesRegex(ValueError, "queue entry"):
                agent.remote_inbox({})
        link.unlink()
        queue.rmdir()
        queue.symlink_to(self.home)
        with self.assertRaisesRegex(ValueError, "Unsafe work reply queue"):
            agent.work_reply_queue()

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
            if args[:3] == ("api", "call", "session.create"):
                layout = json.loads(args[3])
                self.assertEqual(len(layout["initial_windows"]), 2)
                self.assertNotIn("window_label", layout["initial_windows"][0])
                self.assertEqual(layout["initial_windows"][0]["layout"]["block"]["options"]["command"][0], "fish")
                sessions.append({"label": "home", "session_id": "session:home"})
                windows.extend([{"window_id": "window:pi", "layers": [{"blocks": [{"block_id": "block:pi"}]}]},
                                {"window_id": "window:shell", "label": "shell", "layers": []}])
                return {"session_id": "session:home", "initial_windows": [{"window_id": "window:pi"}, {"window_id": "window:shell"}]}
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
             patch.object(agent, "bootstrap", return_value=self.folder), \
             patch.object(agent, "run") as command:
            agent.ensure("home", {"workspace": "janpuc/home-workspace"})
            alive = True
            agent.ensure("home", {"workspace": "janpuc/home-workspace"})
            self.assertEqual([w.get("label") for w in windows], [None, "shell"])
            self.assertEqual(sum(c[:3] == ("api", "call", "session.create") for c in calls), 1)
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

    def test_pi_wrapper_runs_package_launcher_and_keeps_project_path(self):
        bin_dir = self.home / "bin"
        bin_dir.mkdir()
        launcher = bin_dir / "pi-launcher"
        launcher.write_text('#!/bin/sh\nprintf "%s\\n%s\\n" "$PATH" "$*"\n')
        launcher.chmod(0o755)
        mise = bin_dir / "mise"
        mise.write_text(f'#!/bin/sh\ncase "$2" in pi) echo "{launcher}";; esac\n')
        mise.chmod(0o755)
        env = dict(agent.os.environ, PI_PROJECT="home", PATH=f"{bin_dir}:/usr/bin:/bin")
        result = subprocess.run(["sh", str(SOURCE.parents[2] / "dot_pi/private_agent/local/bin/executable_pi"), "--session-id", "home-1"],
                                env=env, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.splitlines(), [env["PATH"], "--session-id home-1"])

    def test_task_close_never_deletes_task_worktree_or_session_data(self):
        folder = agent.bootstrap("empty", {})
        projects = {"empty": {}}
        with patch.object(agent, "ensure"), patch.object(agent, "start_task"):
            agent.task_command(projects, {}, ["new", "empty", "--slug", "safe-close", "Keep all artifacts"])
        task = folder / "tasks/safe-close"
        state = agent.task_state(folder, "safe-close")
        worktree = folder / ".worktrees/code/safe-close"
        worktree.mkdir(parents=True)
        (worktree / "uncommitted").write_text("must survive")
        session = self.home / ".pi/agent/sessions/task.jsonl"
        session.parent.mkdir(parents=True)
        session.write_text("session history")
        (task / "draft.csv").write_text("irreplaceable data")
        before = {path: path.read_bytes() for path in (worktree / "uncommitted", session, task / "draft.csv", task / "STATE.md")}
        with patch.object(agent, "ensure"), patch.object(agent, "start_task"):
            agent.task_command(projects, {}, ["close", "empty", "safe-close"])
        self.assertEqual(agent.read_task(folder, "safe-close")["status"], "closing")
        with self.assertRaises(OSError):
            agent.finalize_task("empty", "safe-close")
        self.assertFalse((state / "closed").exists())
        result = "# safe-close\n\n" + "\n".join(f"## {h}\nVerified.\n" for h in ("Outcome", "Changes", "Verification", "Learned", "Open"))
        (task / "RESULT.md").write_text(result)
        agent.finalize_task("empty", "safe-close")
        request = next(agent.inbox("empty").glob("*.json"))
        item = json.loads(request.read_text())
        self.assertEqual(item["kind"], "fold")
        self.assertEqual(item["status"], "new")
        request.write_text(json.dumps(dict(item, status="accepted")))
        agent.finalize_task("empty", "safe-close")
        self.assertEqual(len(list(agent.inbox("empty").glob("*.json"))), 1)
        self.assertEqual(json.loads(request.read_text())["status"], "accepted")
        self.assertEqual(agent.read_task(folder, "safe-close")["status"], "closed")
        self.assertIn("status: closed", (task / "BRIEF.md").read_text())
        self.assertEqual((task / "RESULT.md").read_text(), result)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)

    def test_memini_namespace_never_derives_an_unregistered_name(self):
        path = SOURCE.parents[2] / "dot_pi/private_agent/local/memini-namespace.py"
        namespace_loader = importlib.machinery.SourceFileLoader("memini_namespace", str(path))
        namespace_spec = importlib.util.spec_from_loader(namespace_loader.name, namespace_loader)
        module = importlib.util.module_from_spec(namespace_spec)
        namespace_loader.exec_module(module)
        registry = self.home / ".config/agents/projects.json"
        registry.parent.mkdir(parents=True)
        registry.write_text(json.dumps({"projects": {"home": {"host": "aether"}}}))
        for cwd, expected in [("Development/home", "homelab/home"),
                              ("Development/home/tasks/audit", "homelab/home"),
                              ("Development/unknown/repo", "homelab/scratch"),
                              ("Development", "homelab/scratch"),
                              ("outside/repo", "homelab/scratch"), (".", "homelab/scratch"),
                              ("Work/draft", "work")]:
            with self.subTest(cwd=cwd):
                self.assertEqual(module.namespace(self.home, self.home / cwd), expected)
        registry.write_text("invalid JSON")
        self.assertEqual(module.namespace(self.home, self.home / "Development/home"), "homelab/scratch")

    def bare_remote(self):
        source = self.home / "source"
        agent.git(self.home, "init", "--initial-branch=main", source)
        (source / "file.txt").write_text("first\n")
        agent.git(source, "add", "--", "file.txt")
        agent.git(source, "commit", "-m", "First commit")
        remote = self.home / "remote.git"
        agent.git(source, "clone", "--bare", "--", source, remote)
        return source, remote

    def test_registration_local_only_and_missing_member_requires_restore(self):
        folder = agent.bootstrap("empty", {})
        agent.register_repository(folder, "empty", "local")
        member = agent.members(folder)[0]
        self.assertEqual(member["url"], "local-only://empty/local")
        self.assertTrue(member["localOnly"])
        agent.git(folder, "commit", "-m", "Register local member")
        self.assertEqual(agent.recorded_commit(folder, member), agent.git(folder / "local", "rev-parse", "HEAD"))
        shutil.rmtree(folder / "local")
        with self.assertRaisesRegex(ValueError, "local-only.*restore needed"):
            agent.restore_member(folder, member)
        self.assertFalse((folder / "local").exists())

    def test_missing_remote_restored_at_recorded_commit_without_touching_others(self):
        source, remote = self.bare_remote()
        folder = agent.bootstrap("empty", {"repos": [
            {"name": "code", "url": str(remote)}, {"name": "other", "url": str(remote)}]})
        member = agent.members(folder)[0]
        original = agent.recorded_commit(folder, member)
        other = folder / "other"
        agent.git(other, "checkout", "--detach", "HEAD")
        (other / "file.txt").write_text("keep other work\n")
        before = agent.git(other, "status", "--porcelain")
        (source / "file.txt").write_text("new remote head\n")
        agent.git(source, "commit", "-am", "Advance remote")
        agent.git(source, "push", str(remote), "main")
        shutil.rmtree(folder / "code")
        for entry in agent.members(folder):
            agent.restore_member(folder, entry)
        self.assertEqual(agent.git(folder / "code", "rev-parse", "HEAD"), original)
        self.assertEqual(agent.git(folder / "code", "branch", "--show-current"), "agent-restored")
        self.assertEqual((folder / "code/file.txt").read_text(), "first\n")
        self.assertEqual(agent.git(other, "status", "--porcelain"), before)
        self.assertEqual(agent.git(other, "rev-parse", "HEAD"), original)
        self.assertEqual(agent.git(other, "branch", "--show-current"), "")
        self.assertEqual((other / "file.txt").read_text(), "keep other work\n")

    def test_dirty_and_detached_members_untouched(self):
        _, remote = self.bare_remote()
        folder = agent.bootstrap("empty", {"repos": [{"name": "code", "url": str(remote)}]})
        target = folder / "code"
        original = agent.git(target, "rev-parse", "HEAD")
        agent.git(target, "checkout", "--detach", original)
        (target / "file.txt").write_text("uncommitted\n")
        (target / "untracked.txt").write_text("keep me\n")
        before = agent.git(target, "status", "--porcelain")
        agent.restore_member(folder, agent.members(folder)[0])
        self.assertEqual(agent.git(target, "status", "--porcelain"), before)
        self.assertEqual(agent.git(target, "rev-parse", "HEAD"), original)
        self.assertEqual(agent.git(target, "branch", "--show-current"), "")
        self.assertEqual((target / "file.txt").read_text(), "uncommitted\n")
        self.assertEqual((target / "untracked.txt").read_text(), "keep me\n")

    def test_missing_initialized_and_unadopted_workspaces_refuse_bootstrap(self):
        folder = agent.bootstrap("empty", {})
        shutil.rmtree(folder)
        with self.assertRaisesRegex(ValueError, "restore needed"):
            agent.bootstrap("empty", {})
        self.assertFalse(folder.exists())
        self.assertTrue(agent.initialization_path("empty").is_file())
        agent.git(self.folder, "init", "--initial-branch=main")
        (self.folder / "untouched.txt").write_text("legacy data\n")
        with self.assertRaisesRegex(ValueError, "adoption required"):
            agent.bootstrap("home", {})
        self.assertEqual((self.folder / "untouched.txt").read_text(), "legacy data\n")
        self.assertFalse(agent.initialization_path("home").exists())


if __name__ == "__main__":
    unittest.main()
