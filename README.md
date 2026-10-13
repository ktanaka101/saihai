# saihai (采配)

English | [日本語](README.ja.md)

You just wield the baton. (A *saihai* is the baton a Japanese commander used to direct troops.)

Building software is a loop: set a goal → implement → observe reality → interpret and decide what's next. AI has made implementation fast, but the other three steps still need human attention, and they now set the pace of the loop. saihai is a framework that supports those three steps so that human attention goes only to decisions.

- **Goal setting**: From a one-sentence intent, an AI "chief of staff" drafts a goal document with research, a hypothesis, and constraints with reasons. You only answer the pending decisions
- **Implementation (left to AI)**: The implementing AI follows a delegation brief. It makes any decision that doesn't hit a report condition on its own and records it in a decision log. A gatekeeper merges the work into main
- **Observing reality**: Each hypothesis in a goal document carries observation expressions, and saihai judges it as confirmed or refuted automatically
- **Interpretation and next decision**: The only thing you open is the inbox, which lists at most five things to decide now. When a goal's hypothesis is judged, the chief of staff runs an after-action review (AAR) and proposes the next decision

The idea is grounded in mission command (Auftragstaktik). Humans write only the intent (purpose, reason, desired end state), the invariants, and the report conditions. Every constraint carries a reason and a strength (invariant, recommendation, or provisional), so the AI can weigh it against its reason and report when it deviates.

## Status

Experimental (0.1.0).

- So far, the only real use is the author building saihai itself with saihai. There is no track record on other projects yet
- saihai's own hypothesis (it reduces the human decisions each goal needs, while keeping the quality of its recommendations) is still being tested. `node bin/saihai.mjs observe` shows the current judgment
- **Japanese only for now**: the CLI messages, the skills, and the goal-document format (headings such as `## 意図`) are in Japanese, and the skills have only been tried with requests in Japanese
- The goal-document format and the commands may change without notice

## Requirements

- Node.js 22.8 or later (no dependencies)
- git
- [Claude Code](https://code.claude.com/) (saihai uses plugins, skills, and hooks)

## Getting started

Install the plugin only in the projects where you want it. In the project's folder:

```bash
claude plugin marketplace add ktanaka101/saihai
```

```bash
claude plugin install saihai@saihai --scope local
```

With `--scope local`, the plugin is enabled only for you and only in that project (it is recorded in `.claude/settings.local.json`). Other projects are not affected. If you use `/plugin install saihai@saihai` inside a session, choose "Install for you, in this repo only" when asked for the scope.

- `marketplace add` only registers, in your user settings, where plugins can be installed from. On its own, it does nothing in any project
- For a team, use `--scope project` (recorded in `.claude/settings.json`, committed and shared). For all of your projects, use `--scope user`

Then, in that project, say what you want in one sentence. For example:

> 毎月の支出の集計に手間がかかっていて、使いすぎに気づくのが月末になってしまう。早く気づけるようにしたい。ゴールにして
>
> (Tallying my monthly spending takes effort, so I only notice overspending at the end of the month. I want to notice sooner. Make it a goal.)

The chief of staff creates the folder for goal documents (`goals/`), does the research, writes a draft, and turns whatever you need to decide into pending decisions. To answer them, just say 「受信箱」 ("inbox"). The pending decisions come up as questions, and you pick an option or write your own answer. The chief of staff does the recording, so you never type commands.

You do only three things:

1. Say what you want in one sentence
2. Say 「受信箱」 and answer the questions (the AI's deviations and flagged concerns also come up here for you to review)
3. Say 「振り返って」 ("look back"), and the chief of staff observes, judges the hypotheses, and puts the next decisions in the inbox

Even if you install it at user scope, the plugin's hooks do nothing in projects that don't use saihai. saihai adds only `goals/`, `decisions/`, `observations/`, and `saihai.config.json` to a project. It doesn't touch CLAUDE.md or your settings.

### Let the gatekeeper merge into main (optional)

Add `"guard": true` to `saihai.config.json`, and the AI can no longer commit directly to main in that project. Only work that passes the gatekeeper's (`saihai gate`) checks is merged into main. By default, saihai doesn't change how your project usually works.

### Installing without the plugin

Without the plugin, clone saihai and run `init` in your project. This also adds a saihai section to CLAUDE.md, the skills, and the hooks to the project (existing files are never overwritten, only added to).

```bash
git clone https://github.com/ktanaka101/saihai.git ~/codes/saihai
```

```bash
node ~/codes/saihai/bin/saihai.mjs init
```

## Commands (used by the chief of staff)

You don't need to type these. The chief of staff uses them to record and check things. With the plugin, call them as `saihai`. Without it, call them as `node ~/codes/saihai/bin/saihai.mjs`.

| Command | What it does |
|---|---|
| `saihai inbox` | The inbox: what you should decide now (up to five items) and the stage of each goal |
| `saihai answer Q12 推奨` | Turns the answer to a pending decision into a precedent (`推奨` takes the recommendation; `自明な案` takes the obvious option; `--text "…"` gives your own answer) |
| `saihai confirm D3 D6` | Marks after-the-fact reviews you have looked at as confirmed |
| `saihai new --parent G0 --slug name --title "Title" --summary "Summary"` | Creates a goal document from the template |
| `saihai check` | Checks the goal documents and the decision log |
| `saihai brief G1` | Prints the delegation brief for the implementing AI (including the invariants and report conditions of ancestor goals) |
| `saihai log --goal G1 --kind 判断 ...` | Adds one entry to the decision log |
| `saihai observe` | Observes and judges hypotheses. `--save` keeps the result in the history. `--record metric=value` records a human observation |
| `saihai aar G1` | Gathers material for an after-action review (what should have happened and what did) |
| `saihai gate` | The gatekeeper: checks the result of merging with the latest main, and if it passes, merges into main and pushes |

## Goal documents

Each goal is one Markdown file, split into a human layer (40 lines at most) and an AI layer that holds records for the AI. The headings are in Japanese:

```markdown
## 意図
- 目的：…
- 理由：…
- 望ましい最終状態：…

## 仮説と判定
- 仮説：これを作れば、誰の何がどう良くなるはずか
- 当たりの判定：…（観測：`import_time_median <= 3`）
- 外れの判定：…（観測：`import_failures >= 1`）

## 具体例
- E1 `[機械]` 自動で確かめる受け入れの例

## 不変条件
- 必ず守ること — 理由：なぜ（関わる ID）

## 報告条件
- 実装を止めて人に聞く条件
```

| Heading | Meaning |
|---|---|
| 意図 | Intent: 目的 (purpose), 理由 (reason), 望ましい最終状態 (desired end state) |
| 仮説と判定 | Hypothesis and judgment: who should be better off and how, with 当たり (confirmed) and 外れ (refuted) conditions written as observation expressions |
| 具体例 | Examples: acceptance examples, checked by machine (`[機械]`) or by a human (`[人間]`) |
| 不変条件 | Invariants: must always hold, each with a reason. If one has to be broken, the AI stops and reports |
| 推奨 | Recommendations: followed in principle. The AI may deviate if it records why |
| 仮置き | Provisional: placeholder decisions the AI may change, as long as it records the change |
| 報告条件 | Report conditions: when the AI must stop implementing and ask a human |
| 非ゴール | Non-goals: what this goal deliberately leaves out |

The format is specified (in Japanese) in [G1](goals/G1-goal-format.md) and [G1.2](goals/G1.2-format-v2.md).

## Configuration (saihai.config.json)

```json
{
  "gate": {
    "checks": [{ "name": "tests", "cmd": ["npm", "test"] }],
    "push": true
  },
  "probes": {
    "import_time_median": { "command": "node scripts/measure.mjs", "examples": ["G1（仮説）"] }
  }
}
```

- `gate.checks`: The gatekeeper's checks, run after the built-in check of the goal documents. With `push: false`, the gatekeeper updates only your local main and doesn't push to the remote
- `probes`: Observation commands. The first number on standard output is the value and the second is the count. Use the probe's name (no spaces) in a hypothesis's observation expression to have it judged as confirmed or refuted

## saihai itself

This repository builds saihai with saihai. The goals are in [goals/](goals/) and the decision log is in [decisions/log.jsonl](decisions/log.jsonl), both in Japanese. Evaluation derivation (an evaluator AI that doesn't see the implementation, plus hidden scenarios) currently exists only for saihai itself.

### Development

- Check your work with `npm test` (Node.js tests, with at least 80% line coverage) and `node bin/saihai.mjs check`
- This repository's gatekeeper (`gate` in `saihai.config.json`) uses a store of hidden scenarios that lives outside the repository, on the author's machine. On anyone else's machine, the gatekeeper's hidden-scenario and audit checks will fail. Use the two commands above to check your work locally

## License

[MIT](LICENSE)
