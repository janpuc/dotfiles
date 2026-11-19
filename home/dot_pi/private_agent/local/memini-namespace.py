"""Resolve only platform-owned namespaces. Unknown paths share the host scratch space."""
import json
from pathlib import Path


def namespace(home, cwd):
    home, cwd = Path(home).resolve(), Path(cwd).resolve()
    try:
        cwd.relative_to(home / "Work")
        return "work"
    except ValueError:
        pass
    try:
        project = cwd.relative_to(home / "Development").parts[0]
        registry = json.loads((home / ".config/agents/projects.json").read_text())
        entry = registry["projects"][project]
        if entry.get("host", registry.get("defaults", {}).get("host", "aether")) == "aether":
            return f"homelab/{project}"
    except (ValueError, IndexError, KeyError, OSError, TypeError):
        pass
    return "homelab/scratch"


if __name__ == "__main__":
    print(namespace(Path.home(), Path.cwd()))
