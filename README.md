# vibin

> A pre-launch sanity checker for vibe coders.

You ship fast. You skip the boring stuff. `vibin` is the safety net that runs the boring stuff *for* you — right before you go live.

Three checks. One command. Zero excuses for shipping something broken.

## What it does

### `vibin security`

An AI security review of your project. Catches the stuff vibe coders forget:

- Hardcoded API keys & secrets in source
- `.env` files committed to git
- Missing auth on sensitive routes
- SQL injection & sketchy input handling
- Wide-open CORS
- Client-side exposure of server-only secrets
- Known-vulnerable dependencies

Outputs a ranked list of issues with file references and suggested fixes. Exits non-zero on anything critical, so you can drop it in a deploy hook.

### `vibin ui`

Spins up your app, screenshots the main routes, and has a vision model review them for:

- Broken layouts & weird spacing
- Bad contrast & accessibility red flags
- Mobile responsiveness fails
- Leftover `Lorem ipsum` / `TODO` text
- Broken images & console errors

Outputs a markdown report with screenshots + annotated feedback.

### `vibin users`

The "fake user" check. An agentic browser session actually clicks through your site trying to accomplish a real goal — sign up, create something, check out — and tells you where it got stuck.

> *"I clicked 'Get Started' and expected a signup form but landed on the pricing page. Confusing."*

Outputs a user-testing report with screenshots at every friction point.

### `vibin check`

Runs all three. One command, one report. The thing you actually run before `git push`.

## Install

```bash
npm install -g vibin
```

## Usage

```bash
cd your-project
vibin check
```

Or run individual checks:

```bash
vibin security
vibin ui --url http://localhost:3000
vibin users --goal "sign up and create a project"
```

## How it works

`vibin` is a thin orchestrator. It hands the actual thinking to whatever AI agent you've already got set up:

1. **Copilot CLI** (preferred) — if you have the official `copilot` CLI installed, `vibin` uses your existing login. Nothing to configure.
2. **Bring your own key** — set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` and `vibin` will use that instead.

You don't have to think about which model is running. You just have to think about whether your app is ready to ship.

## Why

Vibe coding is great. Vibe coding *and then accidentally committing your Stripe key* is not. `vibin` exists so you can keep moving fast without leaving a trail of broken signup flows, exposed secrets, and inaccessible buttons behind you.

Built with Copilot CLI, for everyone building with Copilot CLI. 💚

## License

MIT
