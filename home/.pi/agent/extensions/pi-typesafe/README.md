# pi-typesafe

> **Local fork of [DevMortimer/pi-typesafe](https://github.com/DevMortimer/pi-typesafe) v0.7.1**, vendored into this
> repo's Pi extensions directory and migrated onto Pi core's native classifier support. Differences from upstream:
>
> - Judgments run through `ctx.modelRegistry.classify`; the vendored TypeSafe SDK, custom transport, backend registry,
>   and local key store are gone. Credentials and HTTP behavior are Pi's.
> - The classifier is fixed per session: `PI_TYPESAFE_MODEL=<provider>/<id>` (split at the first `/`), default
>   `opencode/jev-1.13`. An unknown model fails closed; no model is inferred from content.
> - `state` must be a JSON object, and questions use core shapes: `bool` (criteria `{ true, false }` required),
>   `choice` (criteria label map), and `score` (criteria level list). Legacy `noul` questions are normalized to `bool`.
> - Spend caps, the persisted v1 token ledger, consent gating, and calibration are retained. There is no login command:
>   authenticate the provider through Pi itself.
> - `index.ts` is the Pi entry point; the former `lib.ts` typed API and `ask` helper were removed.


[![CI](https://github.com/DevMortimer/pi-typesafe/actions/workflows/ci.yml/badge.svg)](https://github.com/DevMortimer/pi-typesafe/actions/workflows/ci.yml)

[Jev](https://typesafe.ai) inside [Pi](https://pi.dev). Jev is TypeSafe's judgment model: send it some state and typed questions and it returns probabilities instead of prose, in well under a second, for a fraction of a cent. This package gives Pi three things built on it:

- **A tool for the agent.** `typesafe_evaluate` hands small structured judgments (classify, triage, compare, score) to Jev and returns calibrated numbers in one batched call.
- **A playground.** `/typesafe test` and `/typesafe playground` run requests from the terminal without touching the model's context.
- **A typed API for other extensions.** One client, one key store, one login prompt, so extensions such as [pi-warden](https://github.com/DevMortimer/pi-warden) do not each ask for a key — and so a long run can tell you whether Jev was reachable and what it cost.

![Pi triaging three bug reports with one batched TypeSafe call: the prompt, the rendered TypeSafe answers, and the agent's verdict](https://raw.githubusercontent.com/DevMortimer/pi-typesafe/main/docs/preview.png)

Independent project. Not affiliated with TypeSafe AI or the Pi authors.

## In one minute

1. Authenticate the classifier provider in Pi (for the default model, the `opencode` provider). pi-typesafe has no
   login of its own: it uses Pi's resolved credentials at request time.
2. `/typesafe test` sends one built-in sample request and shows the answers.
3. `/typesafe enable` lets the agent call the tool for this session, after you confirm the data notice.

For CI or scripts set `PI_TYPESAFE_ENABLED=1` to opt in without the confirm prompt, and make sure the provider that
serves the configured classifier is authenticated. Do not paste keys into chat, command arguments, or project files.

## The three question types

Jev answers three kinds of question about the state you send. Every question in a request runs in parallel and in isolation, so adding questions barely changes the latency.

| Type | Asks | Returns |
| --- | --- | --- |
| **Choice** | Which of these options fits? | the chosen key, a probability per option, confidence |
| **Score** | Where on this ordered rubric does it sit? | a position (may be fractional) and confidence |
| **Bool** | Is this statement true? | a probability from 0 to 1 |

```json
{
  "state": { "message": "I was charged twice. Please help today." },
  "questions": {
    "team": { "type": "choice", "instructions": "Which team should handle this?",
              "criteria": { "billing": "Charges and payments", "technical": "Software failures", "other": "None of these" } },
    "urgent": { "type": "bool", "instructions": "Does the sender request help today?",
                "criteria": { "true": "Requests help today", "false": "Does not request help today" } },
    "frustration": { "type": "score", "instructions": "How frustrated does the sender sound?",
                     "criteria": ["Neutral request", "Frustrated but civil", "Explicit anger or threats"] }
  }
}
```

`bool` criteria are sent to the classifier verbatim; an omitted `true`/`false` description becomes an empty string, not
an invented "Yes"/"No". Legacy `noul` questions (with optional criteria) still normalize to `bool` for older callers.

Read probabilities and confidence alongside the answer. Confidence describes how concentrated the distribution is; it is not proof of correctness or permission to act.

## The agent tool

`typesafe_evaluate` is registered at startup but **disabled until you run `/typesafe enable`** in the session. For automated or headless runs, set `PI_TYPESAFE_ENABLED=1` explicitly.

The tool accepts JSON `state` plus 1 to 32 questions and returns answers, model, token usage, and elapsed time. Good uses: triaging a list of issues in one call, deciding which of several files a change belongs to, checking whether a reply answers the question that was asked, scoring candidates against a rubric you wrote. Bad uses: anything that needs reasoning across steps, or a single question that mixes several judgments.

## Writing questions that work

The question text is the whole program. Jev answers exactly what is asked, so ambiguity shows up as a middling probability rather than an error.

- **Ask about what the state says, not what you would conclude.** A report that says "happens every time" scored `P(yes) = 0.36` for `Is the bug reproducible from the text?` because that can also mean "could a reader reproduce it using only this text?". `Does the reporter state that the problem occurs consistently?` is the intended question.
- **Describe situations in Score levels, not degrees.** `"Workaround exists"` is checkable; `"medium"` is not.
- **Include a no-match option** in a Choice (`other`, `unclear`) when nothing may fit; the model cannot pick an option you omitted.
- **One judgment per question.** Split independent dimensions into separate questions and batch them in one request; they run in parallel and cannot see each other.
- **Name the state fields you mean** with backticks (`` `report.body` ``) when the state has several parts.

The [TypeSafe docs](https://docs.typesafe.ai/primitives) cover each primitive in detail.

## Availability and spend

`/typesafe status` reports whether the tool is enabled, session and persisted counters, any reached cap, and the
configured model. There is no local key store to inspect: Pi resolves provider credentials at request time, so an
unauthenticated provider surfaces as a failed judgment rather than a missing-key banner.

- **What has this run cost?** `getSpend()` returns session counters, today's persisted counters, and the cap currently reached. Cost is estimated from input tokens only, because output is free.
- **When does it stop?** `maxRequests` bounds a client instance. Three caps bound a local day, survive restarts, and stop a request before it is submitted:

| Option | Environment | Bounds |
| --- | --- | --- |
| `maxRequestsPerDay` | `PI_TYPESAFE_MAX_REQUESTS_PER_DAY` | requests |
| `maxInputTokensPerDay` | `PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY` | input tokens |
| `maxUsdPerDay` | `PI_TYPESAFE_MAX_USD_PER_DAY` | estimated spend |

The environment may lower an explicit cap but never raise it. A reached cap raises a `budget` error naming the cap, the amount used, and the day.

Need more than one request? `evaluateAll(request)` asks any number of questions about one state (over 32 are chunked and fanned out), and `evaluateMany(requests)` runs several requests at once. Both preserve order, bound concurrency, never throw, and stop submitting once the budget is gone. The `calibrate` module turns labelled cases into thresholds with AUC, a sweep, and a replay runner.

## Commands

| Command | Effect |
| --- | --- |
| `/typesafe status` | Opt-in state, session and today's counters, cost estimate, any reached cap, configured model |
| `/typesafe enable` | Confirm the data notice and allow agent tool calls this session |
| `/typesafe disable` | Stop future agent tool calls |
| `/typesafe test` | Send one built-in sample request |
| `/typesafe playground` | Edit request JSON in Pi's editor, confirm, view results |

Playground and test results are shown in the terminal only; they do not enter the model's context.

## Questions people ask

**Do I need a key to install?**
Install works without one; nothing is sent until you enable the tool and authenticate the provider that serves the
configured classifier. The default is `opencode/jev-1.13`; set `PI_TYPESAFE_MODEL=<provider>/<id>` to change it.

**What does a request cost?**
Whatever the provider bills for the input tokens of your state and questions; output is free in the common Jev setup. A few hundred tokens cost well under a hundredth of a cent. The per-session cap is 20 attempts, and `maxUsdPerDay` stops a long run at a number you choose.

**Why not just ask the main model?**
The main model can answer any of these questions in prose. It is slower, costs more per call, and grades its own work. Jev returns a calibrated number your code or the agent can branch on, in a quarter of a second, from a separate model. That matters most when the same question is asked many times: every tool call, every file, every issue in a list.

**What is sent?**
Only the state and questions you (or the agent, once enabled) submit, to whichever provider serves the configured classifier model. No files, conversation history, or telemetry. Error messages never include upstream response bodies, headers, keys, or your submitted state.

**Limits?**
Per request: 32 questions and 64 KiB of JSON. Per session: 20 attempts, 15-second timeout, no automatic retries. Per day: no cap unless you set one. Session limits reset when a session starts or reloads; daily counters live in `~/.pi/agent/pi-typesafe/usage.json` and roll over at local midnight.

## For extension authors

`createTypeSafe(ctx)` now wraps Pi core's classifier support, so it needs an `ExtensionContext` and uses the same
provider auth as every other request. The `ask` helper, typed `lib.ts` exports, backend options, and `ui` entry point
were removed; use `evaluate`, `evaluateMany`, `evaluateAll`, the usage ledger, and `calibrate` directly.

```ts
import { createTypeSafe } from "./pi-typesafe/client.js";

const typesafe = createTypeSafe(ctx, { maxRequests: 5, maxUsdPerDay: 1 });  // resolves PI_TYPESAFE_MODEL
const result = await typesafe.evaluate({
  state: { title: "Login fails after update", body: "..." },
  questions: {
    area: { type: "choice", instructions: "Which area does this report concern?", criteria: { auth: "Sign-in", ui: "Layout", other: "None of these" } },
    duplicate: { type: "bool", instructions: "Does the report describe the same defect as `known_issue`?", criteria: { true: "Same defect", false: "Different or unclear" } },
    severity: { type: "score", instructions: "How severe is the defect?", criteria: ["Cosmetic", "Workaround exists", "Blocking"] },
  },
});
// `evaluate` rejects on validation, budget, or a non-stop result; `evaluateMany`/`evaluateAll` never throw.
```

Your extension owns its own user consent and budget; `/typesafe enable` applies only to this package's tool. `index.ts`
stays the Pi entry point and loads only `extension.ts`, so importing the package from another extension is not supported;
import the modules you need by path.

## Development

This fork is vendored into the dotfiles extensions tree, so it has no package of its own. From
`home/.pi/agent/extensions`:

```bash
npm install                       # dependencies for every extension
node pi-typesafe/test.ts          # offline seam tests (jiti required; bundled with pi)
tsc --noEmit -p tsconfig.json     # typecheck all extensions
```

The remaining `@typesafe-ai/sdk` references were removed; runtime type imports come from `@earendil-works/pi-ai` and
are erased before the extension loads.

## License

MIT
