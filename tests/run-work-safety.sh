#!/bin/sh
# The Work safety tests on a worker, for darwin paths Linux cannot run (renamex_np rollback):
# agent job run hermes dotfiles -- ./tests/run-work-safety.sh
set -eu
cd "$(dirname "$0")/.."
exec python3 -m unittest -v tests.test_work_safety
