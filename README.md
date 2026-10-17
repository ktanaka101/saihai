# saihai (采配)

English | [日本語](README.ja.md)

You just wield the baton. (A *saihai* is the baton a Japanese commander used to direct troops.)

saihai is a way of thinking, and a set of tools, for people to delegate work to AI and coordinate with it nimbly.

- **Delegate**: the human decides only the intent (what for, which way, and how much better), the lines not to cross (constraints), and when the AI should stop and ask (report conditions). The AI sets the concrete targets, the method, and how to check the result
- **Nimbly**: when the situation changes, the AI keeps going on its own judgment from the intent, without waiting for the human. It stops and asks only when something can't be undone, or when the human's answer would change the outcome
- **Coordinate**: with the intent shared, information flows vertically and laterally. Vertically (human and AI), the AI reads back its understanding before starting, and at the end reports what it decided and what it didn't check. Laterally (AI and AI), sessions that share something announce when they start and finish a change that makes it unusable, and the human decides only when they collide

For now, it starts from the goal prompt, the document you hand an AI when you delegate work to it, which covers delegation and vertical coordination. Its principle: **fix the purpose briefly; leave the method to the AI.**

- [How to write a goal prompt](guide.md) (in Japanese): the principle, what to write, bad and good examples, common failures, and what to put in your project's rules when several sessions share something
- [Template](template.md) (in Japanese): copy it and fill it in
- The goal-draft skill (a Claude Code plugin): from a one-sentence direction, the AI researches, writes a draft, and asks you only what needs deciding

The idea is grounded in mission command (Auftragstaktik). An AI can't build up a relationship of trust the way people do, so in place of trust, the goal prompt gives it information to infer the intent from (constraints, guidance, and assumptions that each carry a reason, plus hints that carry a confidence level) and a legitimate way out (when something can't be made to pass, stop and report instead of taking a shortcut).

## Status

Experimental (0.2.0).

- The author is trying it on their own projects. There is no track record elsewhere yet
- If your project already has an issue template or task rules (purpose, exclusions, acceptance criteria, and so on), that is often enough. In that case, use this as a lens for finding what was missing when delegated work goes wrong
- **Japanese only for now**: the guide, the template (headings such as `## 意図`), and the skill are in Japanese
- On 2026-10-14, saihai was restarted from how to write a goal prompt. The earlier tools (format checks, delegation briefs, observation, an inbox, a decision log, and more) were removed. They remain in the git history ([commit 572d280](https://github.com/ktanaka101/saihai/tree/572d280))
- Tools will be added back when real use runs into a problem
- For lateral coordination (AI sessions keeping each other informed), the guide has a short paragraph to put in your project's rules. It has only been tried on a local toy, not on a real project yet
- The format may change without notice

## Usage

### Copy the template

Copy [template.md](template.md), fill it in, and ask the implementing AI to read the file and follow 「実装する AI へ」 (the fixed instructions for the implementing AI). It is plain Markdown, so any coding agent can read it.

| Heading | Meaning |
|---|---|
| 意図 | Intent: 目的 (purpose), 理由 (reason), 望ましい最終状態 (desired end state: which way, how much better, and what must not be lost) |
| 受け入れ条件 | Acceptance criteria a human checks |
| 制約 | Constraints: what must and must not be done, each with a reason. If one has to be broken, the AI stops and asks |
| 指針 | Guidance: how you'd like it done, with a reason. The AI may adapt it within the intent, reporting why |
| 見立て | Hints: what you know or suspect, with a confidence level (高 high, 中 medium, 低 low) and its basis. It does not bind |
| 前提 | Assumptions: what is taken as true without checking. The AI reports when one turns out wrong |
| 報告条件 | Report conditions: when the AI must stop and ask |
| 非ゴール | Non-goals: what this goal leaves out |
| 実装する AI へ | Fixed instructions for the implementing AI: read back the plan first, check for itself what it can instead of handing it to the human, report decisions, report only after the checks finish with the conclusion and what needs deciding first, and stop and report instead of taking shortcuts. Keep it as is |
| AI が立てる部分 | The part the AI fills in before starting (in the file, or in its report when it can't edit the file): a hypothesis, the met and not-met conditions, and how to check them (automated checks, metrics in use), including at least one check by something other than the implementing AI that is shown to catch failures |

### Write it with AI in Claude Code

Install the plugin only in the projects where you want it. In the project's folder:

```bash
claude plugin marketplace add ktanaka101/saihai
```

```bash
claude plugin install saihai@saihai --scope local
```

With `--scope local`, the plugin is enabled only for you and only in that project (it is recorded in `.claude/settings.local.json`). For a team, use `--scope project`. For all of your projects, use `--scope user`.

Then say in one sentence which way and how much better you want things to get. For example:

> 毎月の支出の集計に手間がかかっていて、使いすぎに気づくのが月末になってしまう。週の途中には気づけるようにしたい。ゴールにして
>
> (Tallying my monthly spending takes effort, so I only notice overspending at the end of the month. I want to notice by midweek. Make it a goal.)

The AI researches, writes a draft (placed in `goals/`), and asks you only what needs deciding, with options. When you're done answering, ask it to implement.

## License

[MIT](LICENSE)
