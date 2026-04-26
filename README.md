# vibin

> A pre-launch sanity checker for vibe coders.

`vibin` is a Node.js CLI that runs the boring pre-launch checks you might skip when you are moving fast: security scanning, AI-assisted UI critique, and a fake-user browser journey.

Run one check, or run the full pre-launch suite before you ship.

## Requirements

- Node.js 20 or newer
- An AI backend:
  - Copilot CLI (`copilot`) or GitHub CLI with Copilot (`gh copilot`), or
  - `OPENAI_API_KEY`, or
  - `ANTHROPIC_API_KEY`
- Chromium browser binaries for browser-based checks (`ui`, `users`, and `check`)

## Download and install

### Use without installing

```bash
npx @vibin-cli/vibin@latest --help
```

### Install globally

```bash
npm install -g @vibin-cli/vibin
vibin --help
```

### Install from this repository

```bash
git clone https://github.com/KateCatlin/vibin.git
cd vibin
npm install
npm run build
npm link
vibin --help
```

## Browser setup

The `ui`, `users`, and `check` commands use Playwright. Install Chromium once in the environment where you run `vibin`:

```bash
npx playwright install chromium
```

## AI backend setup

`vibin` resolves an AI backend in this order:

1. `copilot` CLI, if available
2. `gh copilot`, if available
3. OpenAI, when `OPENAI_API_KEY` is set
4. Anthropic, when `ANTHROPIC_API_KEY` is set
5. OpenAI or Anthropic credentials saved by `vibin` in your user-local config

If no AI backend is configured and you run `vibin` in an interactive terminal, `vibin` starts a setup wizard. The first recommendation is GitHub Copilot CLI, because that lets `vibin` use your Copilot access without storing provider API keys. The wizard walks you through installing GitHub CLI if needed, running `gh auth login`, installing the Copilot extension with `gh extension install github/gh-copilot`, and verifying `gh copilot --help`.

You can dismiss Copilot setup and use an OpenAI or Anthropic API key instead. API keys entered through the wizard are written only to a user-local config file outside the project you are checking:

- macOS: `~/Library/Application Support/vibin/credentials.json`
- Windows: `%APPDATA%\vibin\credentials.json`
- Linux/Unix: `$XDG_CONFIG_HOME/vibin/credentials.json` or `~/.config/vibin/credentials.json`

The credentials directory is created with user-only permissions where supported, and the credentials file is written with `0600` permissions. Do not put provider API keys in source code, README files, shell history, committed `.env` files, or generated reports.

Optional model overrides:

```bash
export OPENAI_MODEL=gpt-5.5
export ANTHROPIC_MODEL=claude-opus-4-7
```

When using OpenAI API keys, `vibin` defaults to `gpt-5.5`. When using Anthropic API keys, `vibin` defaults to `claude-opus-4-7`. When using Copilot CLI or `gh copilot`, `vibin` does not set a model; it uses whatever default your installed Copilot tooling uses.

If no AI backend is available, `vibin` exits with an operational failure.

## Quick start

From the project you want to check:

```bash
vibin security
vibin ui
vibin users --goal "sign up and create a project"
vibin check --goal "sign up and create a project"
```

Browser checks default to `http://localhost:3000` so the happy path stays short. When possible, `vibin` checks which local project owns that server and stops if the default localhost app is being served from a different directory.

To have `vibin` start your app, pass a start command:

```bash
vibin check --start-command "npm run dev" --url http://localhost:3000
```

`vibin` waits up to 20 seconds for the URL to respond, runs the browser checks, and then stops the process it started.

If the app never becomes reachable, `vibin` explains what it checked in plain English. For localhost URLs, it can tell the difference between "nothing is listening on this port" and "the app answered with a server error," then suggests the next command to try, such as adding `--start-command "npm run dev"` or changing `--url` to the port your app actually uses.

## Commands

### `vibin security`

Runs deterministic local security scanners, then asks the configured AI backend for a ranked security review.

It checks for:

- Hardcoded secret-like values, including common Stripe, GitHub, AWS, Slack, and SendGrid token formats
- `.env` files tracked by git
- Server-only secrets referenced from likely client-side files
- Overly permissive CORS configuration
- Possible SQL injection from dynamic query construction
- Sensitive-looking route files that may need an auth review
- Known vulnerable npm dependencies via `npm audit --json`

Examples:

```bash
vibin security
vibin security --output security-report.md
vibin --cwd ../my-app security -o security-report.md
```

### `vibin ui`

Opens the app with Playwright, captures page snapshots, records browser console errors and broken images, then asks AI for design feedback on beauty, modernity, simplicity, and cross-page consistency.

Examples:

```bash
vibin ui
vibin ui --url http://localhost:3000
vibin ui --start-command "npm run dev" --url http://localhost:3000
vibin ui --start-command "npm run dev" -o ui-report.md
```

### `vibin users`

Launches a fake-user browser session that attempts a goal one step at a time. The AI chooses realistic actions such as clicking, filling fields, waiting, navigating, selecting options, or stopping when the flow is complete or confusing.

Examples:

```bash
vibin users --goal "sign up and create a project"
vibin users --url http://localhost:3000 --goal "sign up and create a project"
vibin users --start-command "npm run dev" --url http://localhost:3000 --goal "complete checkout"
vibin users --start-command "npm run dev" -o users-report.md
```

### `vibin check`

Runs the full pre-launch suite in sequence:

1. `security`
2. `ui`
3. `users`

It prints one combined markdown report with an executive summary, launch blockers, and the detailed report for each check.

Examples:

```bash
vibin check --goal "sign up and create a project"
vibin check --url http://localhost:3000 --goal "sign up and create a project"
vibin check --start-command "npm run dev" --url http://localhost:3000 --output vibin-report.md
```

## Options

Global option:

| Option | Description |
| --- | --- |
| `--cwd <path>` | Project directory to inspect. Defaults to the current working directory. Use it before the command, for example `vibin --cwd ../my-app security`. |
| `--quiet` | Hide progress messages. Use it before the command, for example `vibin --quiet check`. |
| `--no-color` | Disable ANSI colors in terminal output. `NO_COLOR` and `FORCE_COLOR` are also respected. |

Command options:

| Option | Commands | Description |
| --- | --- | --- |
| `--url <url>` | `ui`, `users`, `check` | Running app URL. Defaults to `http://localhost:3000`; pass it explicitly to review a local server even if it appears to belong to a different project. |
| `--start-command <command>` | `ui`, `users`, `check` | Command used to start this project before browser checks. |
| `--goal <goal>` | `users`, `check` | Fake-user goal to attempt. Defaults to `understand the product and complete the primary call to action`. |
| `-o, --output <path>` | all commands | Write the markdown report to a file. |

## Output

Every command prints emoji-forward progress messages to stderr while it works, then prints a markdown report to stdout. Terminal readouts use color when supported; add `--no-color` or set `NO_COLOR` to disable ANSI colors. Add `--output` or `-o` to also write the plain markdown report to a file. Use `--quiet` to hide progress messages.

Statuses are:

- `✅ PASS` — no medium-or-higher findings were found
- `⚠️ WARN` — medium or high findings were found
- `⛔ FAIL` — at least one critical finding was found
- `💥 ERROR` — the check could not complete due to an unexpected error

## Exit codes

- `0` — command completed without a failing result
- `1` — a check produced a failing result
- `2` — operational failure, such as missing AI credentials, unreachable app URL, or browser startup problems

## Development

```bash
npm install
npm run build
npm test
npm run check
npm run smoke
```

## License

MIT
