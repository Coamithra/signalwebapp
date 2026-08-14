#!/usr/bin/env bash
# Restart the server (free the port, then start it). Thin wrapper: the logic
# lives in reboot.mjs so there is one implementation, and so `npm run reboot`
# never has to resolve `bash` — on Windows that can find WSL's bash.exe in
# System32 instead of Git's and fail with `execvpe(/bin/bash) failed`.
exec node "$(dirname "${BASH_SOURCE[0]}")/reboot.mjs" "$@"
