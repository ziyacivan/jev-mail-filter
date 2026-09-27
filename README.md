# jev-mail-filter

Gmail filters written in plain English, judged by [Jev](https://docs.typesafe.ai).
No server, no OAuth app: it's one Google Apps Script file.

```js
{ label: 'Jev/Needs reply', rule: 'A real person wrote this email to me personally and is waiting for my answer or action.' }
```

Every 10 minutes, each new inbox thread goes to Jev in **one request** with one yes/no question (Noul) per rule.
Rules scoring above `THRESHOLD` get their label, and `archive: true` rules also archive the thread.
The same request also asks for a 0–3 priority Score (`PRIORITY_LEVELS`). Threads at `STAR_AT` or above get starred.

Emails that ask you to do something by a date ("by Friday", "before October 3", "tomorrow") become **Google Tasks** with that due date.
Jev only reads the date's parts (which month, which day, "tomorrow" or "next Monday"). Code does the calendar math from the email's sent date.
If any part is unsure (`MIN_DATE_CONFIDENCE`), no task is created.

## Setup (2 min)

1. Go to [script.google.com](https://script.google.com) → **New project**, then paste `Code.gs` in.
2. **Project Settings** → **Script Properties** → add `TYPESAFE_API_KEY`.
3. **Services** (＋ next to it in the left sidebar) → add **Google Tasks API**.
4. Edit `RULES` to match your own filters.
5. Run `run` once and grant the Gmail permissions. Check the labels it applied.
6. Run `install` once to schedule it every 10 minutes.

## Tips

- Jev reads rules literally. Write the exact condition, not a vibe.
- Start with `THRESHOLD = 0.7`, look at what it labels, then adjust.
- Processed threads get the `Jev/done` label. Remove it from a thread to reprocess it.
