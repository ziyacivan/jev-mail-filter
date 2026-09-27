# jev-mail-filter

Gmail filters written in plain English, judged by [Jev](https://docs.typesafe.ai).
No server, no OAuth app: it's one Google Apps Script file.

```js
{ label: 'Jev/Needs reply', rule: 'A real person wrote this email to me personally and is waiting for my answer or action.' }
```

Every 10 minutes, each new inbox thread goes to Jev in **one request** with one yes/no question (Noul) per rule.
Rules scoring above `THRESHOLD` get their label, and `archive: true` rules also archive the thread.
The same request also asks for a 0–3 priority Score (`PRIORITY_LEVELS`). Threads at `STAR_AT` or above get starred.

## Setup (2 min)

1. Go to [script.google.com](https://script.google.com) → **New project**, then paste `Code.gs` in.
2. **Project Settings** → **Script Properties** → add `TYPESAFE_API_KEY`.
3. Edit `RULES` to match your own filters.
4. Run `run` once and grant the Gmail permissions. Check the labels it applied.
5. Run `install` once to schedule it every 10 minutes.

## Tips

- Jev reads rules literally. Write the exact condition, not a vibe.
- Start with `THRESHOLD = 0.7`, look at what it labels, then adjust.
- Processed threads get the `Jev/done` label. Remove it from a thread to reprocess it.
