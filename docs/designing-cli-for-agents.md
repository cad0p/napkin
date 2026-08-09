# Designing CLI Tools for AI Agents

Design decisions and principles discovered while building napkin as a memory system for AI agents.

## Score Hiding — Designing for Model Psychology

Traditional search tools show relevance scores to help users judge results. For agents, this backfires.

If an agent sees `score: 9.5` vs `score: 2.3`, it treats those numbers as ground truth and may refuse to read the lower-scored file — even if it contains the answer. Models anchor on numeric signals in ways humans don't.

By hiding scores from output by default, we force the agent to judge relevance from the snippets themselves, which it's actually good at. The score still drives result ordering — the agent just doesn't see the number.

This is a new kind of UX thinking: **designing for model psychology, not human psychology.** The same information (ranked results) is presented differently because the consumer is an LLM, not a person.

Scores are available via `--score` for debugging or human inspection.

## Context 0 — Every Token Costs

Google shows snippets with surrounding context because humans skim. They need landmarks to orient themselves on a page.

Agents don't skim. They read every token, and every irrelevant token costs money and dilutes attention. A `## Goal` heading pulled in as context around a match is noise to an agent — it processes it, it contributes to the context window, and it provides zero signal.

Match-only lines (context = 0) are denser and cheaper. The agent can always opt into more context with `--context-lines 2`, or just `napkin read` the file.

**Principle: default to minimal output. Let the agent ask for more, not filter out less.**

## Hints as Control Flow

The footer of `overview` and `search` output includes hints:

```
HINT: Use napkin search <query> to find specific content. Use napkin read <file> to open a file.
```

This is essentially prompt injection on yourself — embedding instructions into tool output to steer the agent's next action. It's a lightweight control flow mechanism that teaches the agent the progressive disclosure workflow without requiring it to know the full system design upfront.

Each level of disclosure tells the agent how to go deeper:
- **Overview** → hints toward `search` and `read`
- **Search** → hints toward `read` and `outline`

The agent learns the tool chain incrementally, from the tools themselves. **Progressive disclosure of the workflow itself.**

## Implications

These patterns suggest a broader principle: **tools designed for agents need different defaults than tools designed for humans.**

| Decision | For Humans | For Agents |
|----------|-----------|------------|
| Show relevance scores | Yes — helps judge results | No — causes anchoring bias |
| Context around matches | 2-3 lines — helps skimming | 0 lines — every token costs |
| Default result count | 10 — manageable to scan | 30 — agents scan cheaply |
| Guide text in output | Rarely — users read docs | Always — agents learn from output |
| Verbose vs minimal | Verbose — humans like detail | Minimal — expand on demand |

The core tension: humans want tools that *show* them things. Agents want tools that *tell* them the minimum, then get out of the way.
