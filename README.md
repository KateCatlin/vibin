# vibin

> A pre-launch sanity checker for vibe coders.

You ship fast. You skip the boring stuff. `vibin` is the safety net that runs the boring stuff *for* you — right before you go live.

Three checks. One command. Zero excuses for shipping something broken.

## What it does

### `vibin security`

Runs an AI-powered security review of the current project. It combines deterministic local scanners with an AI reviewer to catch common vibe-coding mistakes:

- Hardcoded API keys and secrets in source code
- `.env` files committed to git
- Missing-auth risk on sensitive routes
- SQL injection risks from dynamic query construction
- Overly permissive CORS
- Client-side exposure of server-only secrets, such as service-role keys
- Known-vulnerable npm dependencies

It prints a ranked markdown report with file references, evidence, and suggested fixes. It exits non-zero if anything critical is found, so it can gate a deploy.

```bash
vibin security
vibin security --output security-report.md
```

### `vibin ui`

Spins up or connects to your app, captures representative pages with Playwright, and asks an AI reviewer for honest design-crit-style feedback on:

- Beauty
- Modernity
- Simplicity
- Cross-page consistency

It also reports browser console errors and broken images found during the review.

```bash
vibin ui --url http://localhost:3000
vibin ui --start-command "npm run dev" --url http://localhost:3000
```

### `vibin users`

The "fake user" check. It launches an agentic browser session that clicks through the live site or localhost like a person would: finding controls by label, filling forms, navigating pages, and trying to complete a real goal.

It narrates what it tried, where it got stuck, and what felt unintuitive, with feedback like:

> *"I expected clicking Get Started to open signup, but it took me to pricing instead."*

```bash
vibin users --url http://localhost:3000 --goal "sign up and create a project"
vibin users --start-command "npm run dev" --goal "complete checkout"
```

### `vibin check`

Runs all three checks in sequence and produces one pre-launch report:

1. Security review
2. UI design critique
3. Fake-user journey

```bash
vibin check --url http://localhost:3000 --goal "sign up and create a project"
vibin check --start-command "npm run dev" --url http://localhost:3000 --output vibin-report.md
```


For local development from this repository:

```bash
npm install
npm run build
npm link
vibin --help
```

## Browser setup

The `ui` and `users` checks use Playwright. Install browser binaries once in the environment where you run `vibin`:

```bash
npx playwright install chromium
```

If your app is already running, pass `--url`. If you want `vibin` to start it, pass `--start-command`; `vibin` waits for the URL to respond and then cleans up the started process.

## AI backend

`vibin` is a thin orchestrator. It hands the actual thinking to whatever AI backend you already have set up:

1. **Copilot CLI** — preferred. If an official `copilot` CLI or `gh copilot` is available, `vibin` tries it first so you can reuse your existing login.
2. **OpenAI** — set `OPENAI_API_KEY`.
3. **Anthropic** — set `ANTHROPIC_API_KEY`.

You do not have to choose a model. `vibin` picks provider defaults and focuses on making the checks work.

## Options

Most commands support:

| Option | Commands | Description |
| --- | --- | --- |
| `--url <url>` | `ui`, `users`, `check` | App URL to review. Defaults to `http://localhost:3000`. |
| `--start-command <command>` | `ui`, `users`, `check` | Command used to start the app before browser checks. |
| `--goal <goal>` | `users`, `check` | Goal the fake user should try to complete. |
| `--output <path>` | all checks | Write the markdown report to a file. |
| `--cwd <path>` | all checks | Project directory to inspect. |

## Exit codes

- `0` — check completed without critical blockers.
- `1` — one or more critical findings or launch-blocking failures were found.
- `2` — operational failure, such as missing AI credentials, an unreachable app URL, or a browser startup problem.

## Why

Vibe coding is great. Vibe coding *and then accidentally committing your Stripe key* is not. `vibin` exists so you can keep moving fast without leaving a trail of broken signup flows, exposed secrets, and confusing UI behind you.

Built with Copilot CLI, for everyone building with Copilot CLI. 💚

## License

MIT
