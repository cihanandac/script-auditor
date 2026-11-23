# script-auditor

Watches the third-party JavaScript your pages load, has an LLM review every new or changed
script, alerts you on Slack when something looks like a compromise, and publishes a status
page that shows which scripts run on which page.

## Why

Most sites load code from a dozen vendors: tag managers, analytics, ads, consent banners,
widgets, games. When one of those vendors is hacked, the attacker's code runs on your
pages with full access to forms, cookies and logins. That's how Magecart-style card
skimming works.

The usual defences have gaps:

- A Content Security Policy only allows hosts. A hacked script comes from the vendor's
  usual host, so it passes.
- Subresource Integrity doesn't work for scripts that vendors update all the time.
- Hash-based monitors only tell you that a file changed, which happens every day for
  harmless reasons.

script-auditor fills that gap:

- It checks on a schedule, from a real browser, after accepting the consent banner, so it
  sees what visitors' browsers run.
- It reviews each change: it diffs the formatted code, counts risky APIs and lists new
  hosts, then asks an LLM whether the change is a routine update or a compromise.

## How a run works

1. **Crawl.** Chromium visits the configured pages in one session. It clicks the consent
   button, scrolls down so lazy embeds load, and records every script the page itself runs
   from a host outside your domains. Scripts inside cross-origin iframes, such as ad
   creatives, can't touch your page and are left out.
2. **Compare.** Each script is compared with what the previous run saw. Some differences
   are only noise and are absorbed silently:
   - scripts that change per request in numbers or IDs only, such as timestamps;
   - a switch back to a version already seen and not flagged;
   - URLs you configured to ignore.

   Everything else is a change: a new script, a new host, or changed content.

3. **Review.** Changes wait in a queue. For each one the auditor builds a diff of the
   prettier-formatted code, or for a new script the riskiest parts of its code. It counts
   risk indicators (eval, encoding, cookie and storage access, network calls, form and
   keystroke listeners, injected scripts, redirects, mining, obfuscation) and lists hosts
   the code newly talks to. The LLM gets all of this and returns a verdict:
   - `benign`
   - `suspicious`
   - `malicious`

   Verdicts are cached by content, and each run makes at most `llm.maxReviewsPerRun` calls.

4. **Report.** The auditor alerts on scripts at or above `alerts.minVerdict` and on scripts
   from never-seen hosts, through Slack and the job summary. It also reports problems such
   as pages that failed or a consent banner that wasn't found, so a quiet channel never
   means a broken audit.
5. **Publish.** The status site is regenerated from the state:
   - an overview;
   - one page per audited page, listing the scripts it runs;
   - one page per script, with its versions, verdicts and history.

The first run records everything as the baseline and alerts on nothing. Set
`llm.reviewBaseline: true` to review the baseline too. It also works when turned on later:
every recorded script that was never reviewed is queued, and the queue is worked through
over the following runs.

## Quick start with GitHub Actions

1. Create a repository (private is fine) and copy the contents of
   [`examples/github-template`](examples/github-template) into it:
   - `.github/workflows/script-auditor.yml`
   - `script-auditor.yml`
2. Edit `script-auditor.yml`: your pages, your consent button's selector, quiet hosts.
3. Add the repository secrets:
   - `OPENAI_API_KEY`
   - `SLACK_WEBHOOK_URL` (a [Slack incoming webhook](https://api.slack.com/messaging/webhooks))
4. Run the workflow once by hand (Actions tab, "Run workflow"). This first run records the
   baseline.
5. Optional: publish the status site.
   - Enable GitHub Pages with source "GitHub Actions".
   - Add the repository variable `SCRIPT_AUDITOR_PAGES=true`.
   - Set `site.url` in the config so notifications link to it.

   The site is also attached to every run as the `status-site` artifact.

The workflow runs hourly. The auditor keeps its data on the `script-auditor-data` branch.
That branch is rewritten on every run (always one commit), so it doesn't grow.

If the repository with the action is private, other repositories can only use it after
you allow it: in the action's repository, go to Settings > Actions > General > Access.

A run of 26 pages takes about 75 seconds of crawling, and 3 to 4 minutes on a GitHub
runner including installing Chromium. Public repositories get Actions minutes for free.
Private ones on the free plan get 2,000 minutes a month, so run every 2 or 3 hours there
(`cron: '17 */2 * * *'`) or audit fewer pages.

## Configuration

Only `pages` is required.
[`examples/github-template/script-auditor.yml`](examples/github-template/script-auditor.yml)
lists every option with its default. [`examples/ad-funded-site.yml`](examples/ad-funded-site.yml)
shows a site with ads and a consent banner: which pages to pick, consent selectors and the
ad-auction hosts to keep quiet.

| Option                       | What it does                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `pages`                      | URLs to visit, optionally with a `name`. Pick one page per kind of embed.        |
| `firstPartyDomains`          | Your domains; their scripts are not audited. Default: each page's domain.        |
| `consent.selector`           | The "accept all" button. Shadow DOM is pierced.                                  |
| `hosts.quiet`                | Hosts (globs) that may appear without a new-host alert, e.g. ad bidders.         |
| `hosts.ignoreContentChanges` | Script URLs (globs) whose content changes are not reviewed.                      |
| `llm`                        | `provider` (`openai` or `none`), `model`, `apiKeyEnv`, `baseUrl`, review limits. |
| `alerts`                     | `minVerdict` (`suspicious` or `malicious`), `newHosts`.                          |
| `notify`                     | Notifiers; `slack` with `webhookUrlEnv` and `on: [alert, error, change]`.        |
| `site`                       | `enabled`, `title`, public `url`.                                                |
| `retention`                  | How long unseen scripts, history events and versions are kept.                   |

Secrets never go into the config file. It only names the environment variables that hold
them.

`llm.baseUrl` works with any endpoint that speaks the OpenAI Responses API.

## Running locally

```bash
npm ci && npm run build
npx playwright install chromium
```

Print the third-party scripts per page. This stores nothing and needs no API key:

```bash
node dist/cli.js inventory --config script-auditor.yml
```

Run a full audit. Without `--dry-run`, Slack messages are actually sent:

```bash
OPENAI_API_KEY=... node dist/cli.js run --config script-auditor.yml --dry-run
```

`run` keeps its data in `.script-auditor-data/` and writes the site to `site/`. See
`node dist/cli.js --help`.

Exit codes:

- `0`: done
- `1`: failed
- `2`: configuration problem
- `3`: alerts, only with `--fail-on-alert`

## Good to know

- **The visits are real page views.** They count in analytics and ad impressions. The
  user agent ends in `ScriptAuditor/0.1` (`crawl.userAgentSuffix`) so you can filter it
  out. Choose the schedule with that in mind.
- **It's one layer of defence.** Skimmers can hide from automated browsers or only target
  checkout pages, and a model can be wrong. Audit the pages that matter, such as login and
  checkout, and combine the auditor with a CSP.
- **Literal-only changes are trusted.** A change where only numbers, hex hashes and long
  ID-like tokens (16+ characters) differ, and no new host appears, is not reviewed.
  Tracking IDs such as `UA-12345-1`, `G-ABC123`, `AW-123456789` and quoted pixel IDs are
  still compared, because swapping one sends the data to someone else's account.
- **Script code is treated as untrusted input to the LLM.** The prompt fences it and tells
  the model to ignore instructions planted in it. OpenAI requests are sent with
  `store: false`.
- **A GitHub Pages site is public**, even for private repositories (unless you have
  GitHub Enterprise). If the list of your vendors and their verdicts should stay internal,
  use the run artifact instead of Pages.
- **GitHub may pause the schedule.** Scheduled workflows can start late, and GitHub
  disables them in public repositories without activity for 60 days. Re-enable them in
  the Actions tab.

## Roadmap

- GitLab CI component and GitLab Pages
- More LLM providers (Anthropic, Azure OpenAI, Gemini, local models)
- More notifiers (Discord, Microsoft Teams, email, generic webhook)
- Syntax-aware diffs that ignore renamed variables in rebuilt bundles
- A prebuilt container image so runs don't install Chromium each time

## Development

```bash
npm ci
npx playwright install chromium
npm run check   # typecheck, prettier, tests
```

Tests use a local test site with a real browser, including a simulated compromise of a
vendor script.
