// Jev Gmail filter: label, star, archive, turn deadlines into tasks, flag phishing, send a morning digest
// and resurface mail still waiting on a reply, using rules written in plain English.
// Setup: see README.md. Put your key in Project Settings → Script Properties as TYPESAFE_API_KEY.

// One rule per label. Several may match one email. `rule` is a yes/no condition, be literal.
const RULES = [
  { label: 'Jev/Receipts',   rule: 'This email is a receipt, invoice, or order/shipping confirmation for a purchase.' },
  { label: 'Jev/Newsletter', rule: 'This email is a newsletter, marketing promotion, or bulk mailing rather than a personal message.', archive: true },
  { label: 'Jev/Needs reply', rule: 'A real person wrote this email to me personally and is waiting for my answer or action.' },
  { label: 'Jev/Security',   rule: 'This email is a login alert, password reset, verification code, or account security notice.' },
];
const THRESHOLD = 0.7;        // Noul probability needed to apply a label; tune on your own mail
const STAR_AT = 2;            // star threads whose priority score (0-3) reaches this
const PRIORITY_LEVELS = [
  'Automated or bulk mail with nothing for me to do: promotions, newsletters, routine notifications.',
  'Worth a glance but no action needed: receipts, status updates, FYIs.',
  'Needs my reply or action soon: a question, request, deadline, or problem that affects me.',
  'Urgent: needs me today, such as a same-day deadline, money or account access at risk, or someone blocked waiting on me.',
];
// Deadlines become Google Tasks. Jev reads the date's parts; code does the calendar math.
const MIN_DATE_CONFIDENCE = 0.6; // weakest part confidence needed to create a task
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']; // Date.getDay() order
// Phishing: suspicious = (sender domain isn't the claimed brand's, or Reply-To goes to another domain)
//            AND (asks for credentials/payment, or threatens).
// Suspicious mail gets this label and is never starred or turned into a task.
const SUSPICIOUS_LABEL = 'Jev/Suspicious';
const BODY_CHARS = 2000;      // Jev prefers small, relevant state
// Morning digest: one email a day listing what came in, most important first, each with the sentence that matters.
const DIGEST_HOUR = 8;
const DIGEST_SUBJECT = 'Jev digest';
// Waiting on them: mail I sent that asks for something and got no reply in WAIT_DAYS gets this label and goes back to the inbox.
const WAIT_DAYS = 3;
const WAITING_LABEL = 'Jev/Waiting on them';

// Each run handles every thread whose newest message arrived after the saved cursor, oldest first,
// so new replies in old threads are judged too. The cursor advances after each thread; a failure retries from there.
function run() {
  const props = PropertiesService.getScriptProperties();
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  let cursor = Number(props.getProperty('CURSOR')) || Date.now() - 2 * 86400e3; // first run: last 2 days
  // ponytail: 100 newest threads per run; a bigger backlog skips its oldest threads
  const threads = GmailApp.search(`{in:inbox in:sent} after:${Math.floor(cursor / 1000)}`, 0, 100)
    .map(thread => ({ thread, msg: thread.getMessages().filter(m => !m.isDraft()).pop() }))
    .filter(({ msg }) => msg && msg.getDate().getTime() > cursor)
    .sort((a, b) => a.msg.getDate() - b.msg.getDate());
  for (const { thread, msg } of threads) {
    if (me && msg.getFrom().toLowerCase().includes(me)) {
      if (!msg.getSubject().startsWith(DIGEST_SUBJECT)) handleMine(thread, msg);
    } else {
      if (props.getProperty(`WAIT_${thread.getId()}`)) { // they replied
        props.deleteProperty(`WAIT_${thread.getId()}`);
        thread.removeLabel(getLabel(WAITING_LABEL));
      }
      handle(thread, msg);
    }
    cursor = msg.getDate().getTime();
    props.setProperty('CURSOR', String(cursor));
  }
}

function handle(thread, msg) {
  const email = {
    from: msg.getFrom(),
    reply_to: msg.getReplyTo() || undefined,
    subject: msg.getSubject(),
    body: ownText(msg).slice(0, BODY_CHARS),
  };
  const sentences = splitSentences(email.body);
  const answers = ask(email, sentences);
  RULES.forEach((r, i) => {
    if (answers[`r${i}`].noul < THRESHOLD) return;
    thread.addLabel(getLabel(r.label));
    if (r.archive) thread.moveToArchive();
  });
  if (isSuspicious(answers, email)) return thread.addLabel(getLabel(SUSPICIOUS_LABEL));
  if (answers.priority.score >= STAR_AT) msg.star();
  const due = resolveDeadline(answers, msg.getDate());
  if (due) addTask(thread, msg, due);
  if (answers.priority.score < 0.5) return; // bulk mail stays out of the digest
  const pick = answers.key_sentence && sentences[answers.key_sentence.choice];
  PropertiesService.getScriptProperties().setProperty(`DIGEST_${thread.getId()}`, JSON.stringify({
    subject: email.subject.slice(0, 150),
    from: email.from.replace(/\s*<.*>/, '').slice(0, 60),
    sentence: (pick || '').slice(0, 300),
    priority: answers.priority.score,
  }));
}

// My own latest message: if it asks them for something, remember it until they reply.
function handleMine(thread, msg) {
  const key = `WAIT_${thread.getId()}`;
  const email = { to: msg.getTo(), subject: msg.getSubject(), body: ownText(msg).slice(0, BODY_CHARS) };
  const asks = callJev({ email }, {
    asks: { type: 'noul', instructions: 'Does `email`, which I sent, ask the recipient a question or request something from them?' },
  }).asks.noul;
  const props = PropertiesService.getScriptProperties();
  if (asks < THRESHOLD) return props.deleteProperty(key);
  props.setProperty(key, JSON.stringify({ subject: email.subject.slice(0, 150), to: email.to.slice(0, 100), at: msg.getDate().getTime() }));
}

// Sends the daily digest, then clears it. Threads still waiting on a reply are listed every day until they get one.
function digest() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const entries = prefix => Object.keys(all).filter(k => k.startsWith(prefix)).map(k => ({ id: k.slice(prefix.length), ...JSON.parse(all[k]) }));
  const items = entries('DIGEST_').sort((a, b) => b.priority - a.priority);
  const waiting = [];
  for (const w of entries('WAIT_')) {
    const age = (Date.now() - w.at) / 86400e3;
    if (age > 30) props.deleteProperty(`WAIT_${w.id}`); // give up on it
    else if (age >= WAIT_DAYS) waiting.push(w);
  }
  for (const w of waiting.filter(w => !w.flagged)) {
    const thread = GmailApp.getThreadById(w.id);
    if (thread) thread.addLabel(getLabel(WAITING_LABEL)).moveToInbox();
    props.setProperty(`WAIT_${w.id}`, JSON.stringify({ ...w, id: undefined, flagged: true }));
  }
  if (items.length || waiting.length) {
    GmailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      `${DIGEST_SUBJECT}: ${items.length} new, ${waiting.length} waiting on a reply`, digestText(items, waiting), { htmlBody: digestHtml(items, waiting) });
  }
  items.forEach(i => props.deleteProperty(`DIGEST_${i.id}`));
}

function digestText(items, waiting) {
  const line = i => `- ${i.subject} (${i.from})${i.sentence ? `\n  ${i.sentence}` : ''}`;
  return [...items.map(line), waiting.length ? '\nWaiting on a reply:' : '', ...waiting.map(w => `- ${w.subject} (to ${w.to})`)].join('\n');
}

function digestHtml(items, waiting) {
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const link = (id, text) => `<a href="https://mail.google.com/mail/#all/${id}">${esc(text)}</a>`;
  const tag = p => (p >= 2.5 ? 'Urgent' : p >= 1.5 ? 'Needs you' : 'FYI');
  const rows = items.map(i => `<p><b>[${tag(i.priority)}]</b> ${link(i.id, i.subject)} <span style="color:#666">· ${esc(i.from)}</span>` +
    (i.sentence ? `<br><span style="color:#444">${esc(i.sentence)}</span>` : '') + '</p>');
  const wait = waiting.map(w => `<p>${link(w.id, w.subject)} <span style="color:#666">· to ${esc(w.to)}, ${Math.floor((Date.now() - w.at) / 86400e3)} days ago</span></p>`);
  return rows.join('') + (wait.length ? `<h3>Waiting on a reply</h3>${wait.join('')}` : '');
}

// The message's own text, without the quoted earlier messages a reply carries.
function ownText(msg) {
  return msg.getPlainBody()
    .split(/^(?:On\s[\s\S]{0,200}?wrote:|[^\n]{0,200}şunu yazdı:)\s*$/m)[0]
    .split('\n').filter(l => !l.startsWith('>')).join('\n');
}

// Candidate sentences for the digest; Jev picks one, so the digest only ever quotes the email.
function splitSentences(text) {
  return text.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim())
    .flatMap(p => p.split(/(?<=[.!?])\s+/))
    .filter(t => t.length >= 15 && t.length <= 300)
    .slice(0, 40);
}

// Replies quote earlier mail, so the same deadline can be read twice: one task per thread and due date.
function addTask(thread, msg, due) {
  const day = Utilities.formatDate(due, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const link = `https://mail.google.com/mail/#all/${thread.getId()}`;
  const next = new Date(due.getTime() + 86400e3);
  const existing = Tasks.Tasks.list('@default', {
    dueMin: `${day}T00:00:00.000Z`,
    dueMax: Utilities.formatDate(next, Session.getScriptTimeZone(), 'yyyy-MM-dd') + 'T00:00:00.000Z',
    showHidden: true,
  }).items || [];
  if (existing.some(t => (t.notes || '').includes(link))) return;
  Tasks.Tasks.insert({ title: msg.getSubject(), notes: `${msg.getFrom()}\n${link}`, due: `${day}T00:00:00.000Z` }, '@default');
}

// One request per email: one Noul per rule, a priority Score, the deadline parts, phishing signals
// and the digest sentence, all answered in parallel.
function ask(email, sentences = []) {
  const questions = { ...deadlineQuestions(), ...phishingQuestions(email) };
  RULES.forEach((r, i) => {
    questions[`r${i}`] = { type: 'noul', instructions: `Considering \`email\`: ${r.rule}` };
  });
  questions.priority = {
    type: 'score',
    instructions: 'How important and time-sensitive is `email` for me, the recipient?',
    criteria: PRIORITY_LEVELS,
  };
  if (sentences.length) questions.key_sentence = {
    type: 'choice',
    instructions: 'Which one sentence should I read to know what `email` is about? If the sender asks me for something, ' +
      'pick the sentence with that request. Otherwise pick the sentence with the most important news or facts, not a greeting, sign-off, or remark like "no action needed".',
    criteria: { ...Object.fromEntries(sentences.map((t, i) => [String(i), t])), none: 'None of these sentences states a request or main point.' },
  };
  return callJev({ email }, questions);
}

function callJev(state, questions) {
  const key = PropertiesService.getScriptProperties().getProperty('TYPESAFE_API_KEY');
  for (let attempt = 0; ; attempt++) {
    const res = UrlFetchApp.fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${key}` },
      payload: JSON.stringify({ model: 'jev-latest', state, questions }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText()).answers;
    // Throwing stops the run before the cursor passes this thread, so the next run retries it.
    if ((code !== 429 && code !== 529) || attempt >= 3) throw new Error(`TypeSafe ${code}: ${res.getContentText()}`);
    Utilities.sleep(1000 * 2 ** attempt);
  }
}

function phishingQuestions(email) {
  return {
    phish_sender_ok: {
      type: 'noul',
      instructions: {
        sender_domain: domainOf(email.from),
        question: 'Is `sender_domain` an official domain of the company, bank, or online service that `email` presents itself as coming from?',
      },
      criteria: {
        true: 'The domain belongs to that organization, or the email does not present itself as coming from any organization.',
        false: 'The email presents itself as coming from an organization, but the domain is not one of its own, such as a lookalike or unrelated domain.',
      },
    },
    phish_credentials: { type: 'noul', instructions: 'Does `email` ask me to log in, enter a password or verification code, or give payment or card details?' },
    phish_pressure: { type: 'noul', instructions: 'Does `email` threaten a bad outcome, such as a suspended account, lost money, or legal action, unless I act right away?' },
  };
}

function isSuspicious(a, email) {
  const replyElsewhere = !!email.reply_to && domainOf(email.reply_to) !== domainOf(email.from);
  return (a.phish_sender_ok.noul < 1 - THRESHOLD || replyElsewhere) && (a.phish_credentials.noul >= THRESHOLD || a.phish_pressure.noul >= THRESHOLD);
}

function domainOf(address) {
  return (address || '').split('@').pop().replace(/>.*$/, '').trim().toLowerCase();
}

function deadlineQuestions() {
  const role = 'the deadline by which `email` asks me to do or send something';
  const none = 'The email states no such deadline, or it is not this kind of date.';
  const choice = (instructions, options) => ({
    type: 'choice', instructions, criteria: Object.fromEntries([...options.map(o => [o, null]), ['none', none]]),
  });
  return {
    has_deadline: { type: 'noul', instructions: 'Does `email` ask me to do or send something by a specific day or date?' },
    d_mode: {
      type: 'choice',
      instructions: `How is ${role} written? 'absolute' = a calendar date naming a month (e.g. 'October 3', 'the 14th of March'); ` +
        "'relative' = relative to when the email was sent (today, tomorrow, the day after tomorrow, or a weekday such as 'by Friday'); " +
        "'none' = the email states no such deadline.",
      criteria: { absolute: null, relative: null, none: null },
    },
    d_month: choice(`If ${role} is a calendar date, which month is it in?`, MONTHS),
    d_day: choice(`If ${role} is a calendar date, which day of the month (1-31)?`, Array.from({ length: 31 }, (_, i) => String(i + 1))),
    d_anchor: choice(`If ${role} is relative to when the email was sent, which day is it? 'today', 'tomorrow', ` +
      "'day_after' (the day after tomorrow), or 'weekday' (a named day of the week).", ['today', 'tomorrow', 'day_after', 'weekday']),
    d_weekday: choice(`If ${role} names a day of the week, which one?`, WEEKDAYS),
    d_week: choice(`If ${role} names a weekday, which week is it in? 'next' for 'next Friday' or 'Friday next week'; ` +
      "'current' for 'this Friday'; 'none' for a bare weekday with no qualifier ('by Friday').", ['current', 'next']),
  };
}

// Turns the deadline answers into a Date, counting relative days from when the email was sent.
// Returns null when there is no deadline, the parts don't make a date, or any used part is unsure.
function resolveDeadline(a, sent) {
  if (a.has_deadline.noul < THRESHOLD) return null;
  const day = n => new Date(sent.getFullYear(), sent.getMonth(), sent.getDate() + n);
  const used = [a.d_mode];
  let due = null;
  if (a.d_mode.choice === 'absolute') {
    used.push(a.d_month, a.d_day);
    const m = MONTHS.indexOf(a.d_month.choice);
    due = new Date(sent.getFullYear(), m, +a.d_day.choice);
    if (m < 0 || due.getMonth() !== m) return null; // 'none', or an impossible date like February 30
    if (due < day(-31)) due.setFullYear(due.getFullYear() + 1); // no year in mail: "January 5" sent in December
  } else if (a.d_mode.choice === 'relative') {
    used.push(a.d_anchor);
    const anchor = a.d_anchor.choice;
    if (anchor === 'today') due = day(0);
    else if (anchor === 'tomorrow') due = day(1);
    else if (anchor === 'day_after') due = day(2);
    else if (anchor === 'weekday') {
      used.push(a.d_weekday, a.d_week);
      const w = WEEKDAYS.indexOf(a.d_weekday.choice), today = sent.getDay();
      if (w < 0) return null;
      const monday = -((today + 6) % 7), fromMonday = (w + 6) % 7;
      if (a.d_week.choice === 'next') due = day(monday + 7 + fromMonday);
      else if (a.d_week.choice === 'current') due = day(monday + fromMonday);
      else due = day((w - today + 7) % 7); // bare weekday: next one on or after the sent day
    }
  }
  return due && Math.min(...used.map(x => x.confidence)) >= MIN_DATE_CONFIDENCE ? due : null;
}

function getLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// Run once to process mail every 10 minutes and send the digest every morning.
function install() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('run').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('digest').timeBased().atHour(DIGEST_HOUR).everyDays(1).create();
}
