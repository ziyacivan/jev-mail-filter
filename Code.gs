// Jev Gmail filter: label (and optionally archive) mail using rules written in plain English.
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
const DONE_LABEL = 'Jev/done'; // marks threads already processed
const BODY_CHARS = 2000;      // Jev prefers small, relevant state

function run() {
  const done = getLabel(DONE_LABEL);
  const threads = GmailApp.search(`in:inbox -label:${DONE_LABEL.replace('/', '-')} newer_than:2d`, 0, 30);
  for (const thread of threads) {
    const msg = thread.getMessages().pop();
    const answers = ask({
      from: msg.getFrom(),
      subject: msg.getSubject(),
      body: msg.getPlainBody().slice(0, BODY_CHARS),
    });
    RULES.forEach((r, i) => {
      if (answers[`r${i}`].noul < THRESHOLD) return;
      thread.addLabel(getLabel(r.label));
      if (r.archive) thread.moveToArchive();
    });
    if (answers.priority.score >= STAR_AT) msg.star();
    thread.addLabel(done);
  }
}

// One request per email: one Noul per rule plus a priority Score, all answered in parallel.
function ask(email) {
  const questions = {};
  RULES.forEach((r, i) => {
    questions[`r${i}`] = { type: 'noul', instructions: `Considering \`email\`: ${r.rule}` };
  });
  questions.priority = {
    type: 'score',
    instructions: 'How important and time-sensitive is `email` for me, the recipient?',
    criteria: PRIORITY_LEVELS,
  };
  const key = PropertiesService.getScriptProperties().getProperty('TYPESAFE_API_KEY');
  for (let attempt = 0; ; attempt++) {
    const res = UrlFetchApp.fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${key}` },
      payload: JSON.stringify({ model: 'jev-latest', state: { email }, questions }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText()).answers;
    // Throwing leaves the thread without DONE_LABEL, so the next run retries it.
    if ((code !== 429 && code !== 529) || attempt >= 3) throw new Error(`TypeSafe ${code}: ${res.getContentText()}`);
    Utilities.sleep(1000 * 2 ** attempt);
  }
}

function getLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// Run once to process mail every 10 minutes.
function install() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('run').timeBased().everyMinutes(10).create();
}
