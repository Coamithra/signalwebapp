# Contributing: Tackling a Trello Card

Step-by-step workflow for picking up and completing any card from the
**Signal Web App** board (id `6a353dfe`). The board now lives in the **local Trello
backend** (already configured), so every `trello` command below uses `--backend local`.
Lists are **To Do → Doing → Done**.

---

## Quick ship (no card / small change)

Not every change is a Trello card. For a quick fix or doc tweak that doesn't warrant the
full runbook below, the default ship flow is **PR + auto self-merge**:

```
git checkout -b <prefix>/<short-name>     # off main
git add <files> && git commit -m "..."     # only the files you touched
git push -u origin <branch>
gh pr create --fill                        # PR record + URL, no clicking
gh pr merge --merge                        # self-merge (see note); use --merge, not --squash
git checkout main && git pull origin main  # fast-forward local main to the merge
```

**No approval needed.** `main` is an unprotected branch on this solo public repo, so
GitHub disabling the "Approve" button on your *own* PR is irrelevant — a required review
only applies under a branch-protection rule, and this repo has none. Don't stop to ask the
user to approve or open the PR by hand. (If the user says "just merge / direct", skip the
PR entirely and fast-forward `main`.)

---

## Worktree Quick Reference

Card work happens in an isolated **git worktree** under `.trees/` so multiple agents can
work on different cards simultaneously. The root checkout stays on `main` — never switch it
to a feature branch.

| Command | What it does |
|---------|-------------|
| `git worktree add .trees/<name> -b <branch> main` | Create a new worktree + branch from main |
| `git worktree list` | Show all active worktrees |
| `git worktree remove .trees/<name>` | Remove a worktree (clean up) |
| `git worktree prune` | Clean up stale worktree references |

**Key rules:**
- Each worktree gets its own branch; a branch can only be checked out in one worktree at a time.
- `.trees/` is gitignored. There are no per-worktree secrets to recreate (the app has no
  `.env` and no `node_modules` — it's zero-dep), so a fresh worktree is ready immediately.
- Windows note: if `git worktree remove` fails with "Permission denied", `cd` the shell out
  of the worktree first and kill any `node`/server you started from inside it, then retry.

---

## Phase 1: Pick Up the Card

> **Picking up the top card? Use the atomic `grab` command.** When you are told to "pick up the top card/ticket" (rather than a specific named card), claim it in one step:
>
> ```
> trello --backend local --board 6a353dfe grab --from "To Do" --to "Doing"
> ```
>
> This pops the top card of To Do, moves it to Doing, and prints the card it got you (it exits 1 when To Do is empty). It is safe to fire from several agents at once: each gets a distinct card, so no two collide on the same ticket. On the local backend `grab` is truly atomic (it takes a store lock), so there's no claim-comment wait. For a specific card you were named, skip this and use step 3 below.

1. **Pull latest main** — `git pull origin main` so you start from the newest code.
2. **Read the card** — the description is the spec. Larger features may have a longer note
   in `plans/<file>.md`; the card is the pointer.
3. **Move card to Doing** — `trello --backend local --board 6a353dfe card move <card_id> Doing`.
4. **Create worktree and branch** — branch off `main` with a descriptive prefix:
    - Bugs: `fix/<short-name>` (e.g. `fix/context-swap-race`)
    - Features: `feat/<short-name>` (e.g. `feat/inline-images`)
    - Refactoring: `refactor/<short-name>`
    - Docs only: `docs/<short-name>`
    ```
    git worktree add .trees/<branch> -b <branch> main
    cd .trees/<branch>
    git push -u origin <branch>
    ```
5. **All subsequent work happens inside `.trees/<branch>/`.**

## Phase 2: Research

Understand the bridge before changing it. The whole app rides on Signal Desktop's
**undocumented internals**, so the highest-value research is confirming what those
internals actually look like *in the running app*.

6. **Read the referenced code** — cards cite specific files. Read them; they drift.
7. **Trace the path** — for the bridge, the chain is `public/app.js` →
   `src/server.js` route → `src/bridge.js` method → `window.__sb.*` in
   `src/page-api.js` → Signal's own functions. Find where your change lands.
8. **Re-probe Signal's internals when in doubt** — write a tiny throwaway CDP script that
   connects to `localhost:9222`, finds the `background.html` page target, and
   `Runtime.evaluate`s in the **isolated** context (see `CLAUDE.md` for why). Confirm the
   shape of whatever you're about to depend on (redux slice, model method signature) rather
   than guessing — versions change. Delete the probe when done.
9. **Summarize findings** — root cause (bugs), the internal API you'll use (features), or
   the blast radius (refactors).

## Phase 3: Design

10. **Draft the approach** — for anything non-trivial, jot it in the card or a
    `plans/<file>.md`: what changes, in which of the four layers (frontend / server /
    bridge / page-api), the new request/response shape, and what's explicitly out of scope.
11. **Check for reusable patterns first** — the `el()` DOM helper, the `__sb` RPC
    convention, the SSE event shapes, the existing avatar/time/format helpers. Don't invent
    a parallel mechanism.
12. **Align with the user** — present the plan, get approval before writing code.

## Phase 4: Implement

13. **Make the changes** per the approved plan. Follow the conventions in `CLAUDE.md`:
    - **Zero runtime dependencies.** Node built-ins only; no `npm install`. Adding a dep
      needs a strong justification and user sign-off.
    - **ESM** throughout. The injected `page-api.js` runs inside Signal — keep it
      self-contained and defensive (try/catch, optional chaining on internals).
    - **`page-api.js` is the contract with Signal.** Anything that touches Signal's
      internals belongs there, behind a `window.__sb` method — keep the surface small so a
      Signal update only ever breaks one file. The install script must stay **idempotent**
      (re-defines `__sb`, installs the redux subscriber once).
    - **Frontend builds DOM with `createElement`, never `innerHTML`,** for message /
      conversation / contact content. Bodies are attacker-influenced (XSS).
    - **Server binds `127.0.0.1` only.** Never expose Signal on a public interface.
    - **Sending:** `enqueueMessageForSend` needs `attachments: []` (array) or it throws.
    - **Reading must stay non-disruptive** — `loadNewestMessages` doesn't move the user's
      real Signal window or send read receipts; keep it that way.
14. **Update docs** — if you add a `window.__sb` method, a route, an SSE event type, or
    change how the bridge resolves the context, update `CLAUDE.md`. It's the source of truth.

## Phase 5: Verify

There is no automated test suite yet, so verification is hands-on. **Do all send/receive
testing against "Note to Self"** so you never message a real contact.

15. **Smoke the server** — `npm start` with Signal running (`npm run launch-signal`). Hit
    `GET /api/status` → expect `{"status":"ready", ...}`. A 503 means Signal isn't reachable
    with the debug port.
16. **Exercise the change in a browser** — drive the tab with the `Claude_Preview` or
    `claude-in-chrome` tools (or just open `http://127.0.0.1:7700`). Verify the actual
    behavior, not just that the endpoint returns 200.
17. **Check the browser console** — no errors/exceptions after interacting.
18. **Verify realtime + reconnect if you touched them** — send via the API while a thread is
    open (it should appear via SSE with no refresh); kill+restart the server (the tab should
    go amber→green and repopulate on its own).
19. **Spot-check the diff** — typos, missing `await`, redux keys that don't exist, dead code.
20. **Flag manual-only checks** — anything that can't be verified without a real Signal
    update or a second device.

## Phase 6: Review & Ship

21. **Commit** — descriptive message, imperative subject, body explains *why* not *what*.
    Push to the feature branch.
22. **Peer review** — run `/review` (spawns a fresh agent against the branch diff vs `main`).
    Fix every finding before proceeding unless a fix is a major undertaking (then file a
    follow-up card).
23. **Pull main into the branch** — `git pull origin main`; resolve conflicts per the rules
    below.

### Merge Conflict Rules

23.1. **Default to main's version.** If a conflict is in code you didn't intentionally
change, accept main's side — someone else fixed/added something; don't silently revert it.
23.2. **Assume incoming changes are important** until you've read the diff and confirmed otherwise.
23.3. **Only keep your side for lines you specifically wrote.** Merge surgically — keep their
fixes, layer your change on top.
23.4. **If the merge is messy, restart from main** and reapply your change cleanly.
23.5. **Re-read the final result** in full — don't just trust the conflict markers.

24. **Re-verify after the merge** — re-run the Phase 5 smoke so the merge didn't break anything.
25. **Return to the root checkout** — `cd` back to the project root (where `main` lives).
26. **Open a PR and self-merge** — `gh pr create --fill` then `gh pr merge --merge` (real
    merge commit, not `--squash`, so `git branch -d` still works), then
    `git pull origin main` to fast-forward the root checkout. No approval needed (unprotected
    solo repo). Direct `git merge <branch> && git push` is the fallback if `gh` is unavailable.
27. **Clean up the worktree and branch**
    ```
    git worktree remove .trees/<branch>
    git worktree prune
    git branch -d <branch>
    git push origin --delete <branch>
    ```
28. **Delete the plan file** if the card had a `plans/<file>.md` — the plans directory is for
    *open* work only.
29. **Move card to Done** — `trello --backend local --board 6a353dfe card move <card_id> Done`.
30. **Comment on the card** — `trello --backend local --board 6a353dfe comment add <card_id> "<summary>"`:
    what changed, which files, commit hash(es), and what needs manual testing.
31. **Create follow-up cards** for anything out of scope that surfaced (pre-existing bugs,
    deferred edge cases). Don't let follow-up work disappear into commit messages.
32. **Write an overview** for the user to end the session: what changed, which files, why,
    and anything they should know (manual-test steps, follow-up cards, behavior shifts).
