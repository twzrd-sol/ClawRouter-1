# OPENCODE-REPORT — OpenClaw 2026.8.2 plugin collision/migration release gate

Worktree: `/home/twzrd/worktrees/clawrouter-openclaw-e2e` (branch `claude/openclaw-2026.8.2-collision-e2e`, 3 local commits on `0b1c755` = upstream/main).

## What was built

A release gate that exercises the **real** OpenClaw 2026.8.2 installation path end-to-end — real `openclaw` CLI, real `openclaw plugins install` of an `npm pack` tarball built from this repo, real `openclaw gateway run`, real HTTP probe of the x402 proxy — in a throwaway `HOME` under the OS tempdir. The operator's `~/.openclaw` is never touched (verified: unchanged after all runs).

## Files changed

| Commit | Files | What |
|---|---|---|
| `2d57472` | `src/index.ts`, `src/index.plugin-id-migration.test.ts` | **Fix**: the plugin-id migration now also retires the legacy `plugins.entries.clawrouter` key when the new key already exists. +4 unit tests. |
| `e69c3f5` | `test/openclaw-plugin-collision-e2e.ts`, `package.json` | **Release gate** `npm run test:e2e:openclaw-collision` + npm script wiring. |
| (next) | `CLAUDE.md`, `CONTRIBUTING.md`, `OPENCODE-REPORT.md` | Docs + this report. |

### The fix (why it was needed)

PR #307's migration only moved the legacy entry when `plugins.entries["blockrun-clawrouter"]` was absent. Through the real installer path that guard skips forever: `openclaw plugins install` commits `{enabled:true}` (manifest `enabledByDefault`) inside the install transaction, while the plugin's own config write is deferred to first gateway start (baseHash rollback protection — comment at `src/index.ts:498`). The stale legacy key therefore survived and kept re-targeting the user's pre-rename choice at OpenClaw's **bundled** router. Demonstrated on the real path with a seeded pre-rename opt-out (`enabled:false`): the installer force-enabled BlockRun's plugin AND the stale key disabled OpenClaw's bundled router — both clobbers.

The fix treats the exact installer-written shape (`{enabled:true}` only) as installer-derived and overwrites it with the legacy entry; any other value under the new key is post-rename user state and is kept. Either way the legacy key is retired so the migration completes on first gateway boot.

## How to run

```bash
npm run test:e2e:openclaw-collision   # ~3 min; needs network to install openclaw@2026.8.2 into the sandbox
```

- Requires free TCP/8402 (the proxy port is compiled into the plugin; `BLOCKRUN_PROXY_PORT` does not survive the gateway process, so the gate owns 8402 and fails fast if it is held).
- `OPENCLAW_E2E_OPENCLAW=/path/to/openclaw.mjs` — use an existing CLI instead of downloading.
- `OPENCLAW_E2E_VERSION=2026.9.1-beta.1` — pin another OpenClaw version.
- `OPENCLAW_E2E_KEEP=1` — keep the sandbox (install/gateway logs inside) for debugging.
- Sandbox is under `os.tmpdir()`, outside the repo, cleaned up on exit (incl. SIGINT/SIGTERM; gateway killed via process group).

## Commands / results

| Check | Result |
|---|---|
| `npx vitest run src/index.plugin-id-migration.test.ts` (new tests, pre-fix) | **4 failed / 4 passed** (red) |
| `npm run typecheck`, `npm test` post-fix | clean; **838/838** across 76 files |
| `npm run test:e2e:openclaw-collision` (fix present) | **16/16 green** — both plugin ids coexist (`clawrouter` bundled / `blockrun-clawrouter` global), legacy key migrates away, `models.providers.blockrun` wired to the proxy, `GET /health` returns `{status:"ok",wallet}`, provider registered (`providerIds` incl. `blockrun`); scenario B: opt-out restored, bundled router stays enabled, proxy stays down on boot 2 |
| Same gate, pre-fix `src/index.ts` (TDD red proof) | **11/16** — fails exactly the 5 migration/coexistence checks (legacy key never migrates; opt-out clobbered; bundled router disabled by stale key; proxy rises on boot 2 despite opt-out) |
| `npm run lint`, `prettier --check` | clean |
| Operator `~/.openclaw`, prod containers, ports | untouched; 8402 free; no temp dirs left (`/tmp/clawrouter-openclaw-e2e-*` removed by the gate) |

## Remaining uncertainty

1. **Installer-vs-user shape heuristic**: `{enabled:true}` under the new key is treated as installer-derived. A user who re-enabled the plugin post-rename via `openclaw plugins enable` (writes exactly `{enabled:true}`) *and* kept the legacy key until the first gateway boot could have their re-enable overwritten by the legacy choice. The window is one boot (the migration then deletes the legacy key permanently), and the legacy key is definitionally the pre-rename BlockRun choice, but it is a heuristic — flagged in code comments.
2. **Gateway-config rewrite race**: OpenClaw rewrites `openclaw.json` at gateway boot/shutdown (adds `meta`, `agents`, `tools`). Scenario assertions read the post-shutdown file, and the migration write survived in all runs; but if a future OpenClaw version persists a cached pre-migration config, the gate would catch it — that's what it is for.
3. **Scenario B boot 1** runs the proxy (plugin was loaded as enabled before the migration landed). The opt-out is proven by the persisted config plus boot 2; asserting "no proxy on boot 1" would contradict how OpenClaw sequences load/register.
4. The gate downloads `openclaw@2026.8.2` from npm each run (~1 min). No offline cache; acceptable for a release gate, overridable via env.
