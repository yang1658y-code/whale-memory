# whale-memory-dsh

**A memory backend for [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh-compaction) that never lets a model rewrite your conversation.**

DSH ships with a compaction backend that summarizes old history with the model — the moment it summarizes, your original words are gone. This plugin replaces that with: **archive the original messages verbatim, leave only an index card in the context, and hand the original words back when they are relevant.**

Two halves, one shared store:

| half | entry | what it does |
|---|---|---|
| compaction | `index.js` | how old history *leaves* the context: verbatim archive + index card, no LLM involved |
| recall | `whale-memory-dsh/memory` | how old history *comes back*: on `agent/pre-step`, append one message with the recalled original words |

---

## Quick Start

Prerequisite: DSH desktop has been launched at least once, so `~/.dsh/profiles/<name>` exists.

```bash
cd dsh-adapter

# 1. dry run — read only, changes nothing
node 装.cjs

# 2. install: copy the plugin into the profile, register dependency + bundle
node 装.cjs --装
#    one profile  -> picked automatically
#    many profiles -> listed for you; pick with --profile=<name> (or DSH_PROFILE)

# 3. restart DSH desktop yourself (this plugin never restarts anything for you)

# 4. success looks like this line in the log:
#    whale-memory: 记忆注入已挂载（内核检索层可用）
```

**Your data lives in `~/.dsh/whale-memory/原文回溯/`, not inside `node_modules`.**
Upgrading, reinstalling or removing the package never touches it.

Uninstall (DSH falls back to its official summarizer — that is expected):

```bash
node 装.cjs --卸
```

## Config

Set these on this package's node in your DSH profile's `cordis.yml` (defaults come with `cordis.patch.yml`):

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `everyTurn` | `true` | only recall on steps that carry new user input |
| `maxInjectChars` | `900` | hard cap for the injected text |
| `contextPairs` | `1` | sentences of context on each side of the recalled line |

Chinese key aliases (`启用` / `每轮一次` / `最大注入字符` / `上下句数`) are still accepted, English wins when both are present.

## Where the data goes

`鲸鱼原文表` env → `原文回溯根目录` env → `鲸鱼数据目录` env → `~/.dsh/whale-memory/原文回溯` → package dir (last resort).

All of this is resolved in exactly one place: `lib/路径.js`.

## Caveats

- Keyword extraction is mechanical (bigram frequency), not semantic. It produces some noise, never opinions.
- The model cannot yet call a tool to fetch an archived line; the index only tells it where the line is.
- DSH is pre-release: `peerDependencies` are all `*`. If upstream changes the `summarize` signature, this plugin degrades to the official summarizer instead of crashing.

License: MIT. Full documentation (in Chinese): [README.md](./README.md).
