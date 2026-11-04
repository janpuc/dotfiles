#!/bin/sh
# pi-subagents 0.84.0 drops a child in a Rex tab whose second contact_supervisor comes more than a
# minute after the first: a 60 s cleanup deletes the run's empty supervisor mailbox, the relay's
# write fails with ENOENT, and the parent reports "Reconnected bridge handshake timed out" while the
# child keeps working on its own (nicobailon/pi-subagents#3158, fixed on main, not yet released).
# This applies that fix to the installed 0.84.0: the relay recreates the mailbox before it writes.
# Delete this script once the pinned pi-subagents is newer than 0.84.0. A Pi that is running keeps
# the old code until /reload.
set -eu
dir="$HOME/.pi/agent/npm/node_modules/pi-subagents"
[ -f "$dir/package.json" ] || exit 0
version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$dir/package.json" | head -1)
[ "$version" = "0.84.0" ] || { echo "pi-subagents $version: the #3158 patch is for 0.84.0, skipped" >&2; exit 0; }
python3 -I - "$dir" <<'EOF'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
patches = [
    ("src/runs/shared/herdr-placed-run.js", "fs", "path", 'fs.writeFileSync(file, JSON.stringify(request), { mode: 0o600, flag: "wx" });'),
    ("bundle/chunk-J5YL7LYR.js", "fs3", "path5", 'fs3.writeFileSync(file, JSON.stringify(request), { mode: 384, flag: "wx" });'),
]
for rel, fs, path, write in patches:
    f = root / rel
    if not f.exists():
        sys.exit(f"pi-subagents #3158 patch: {rel} is missing; check the installed version")
    text = f.read_text()
    fix = (f'{fs}.mkdirSync({path}.join(this.supervisorDir, "requests"), {{ recursive: true, mode: 0o700 }}); '
           f'{fs}.mkdirSync({path}.join(this.supervisorDir, "replies"), {{ recursive: true, mode: 0o700 }}); ')
    if fix + write in text:
        continue
    if text.count(write) != 1:
        sys.exit(f"pi-subagents #3158 patch: expected one relay write in {rel}, found {text.count(write)}")
    f.write_text(text.replace(write, fix + write))
    print(f"pi-subagents #3158 patch applied to {rel}")
EOF
