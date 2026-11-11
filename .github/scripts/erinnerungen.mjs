// Findet fällige Erinnerungen in Lenas Daten und schickt sie als Mitteilung an alle angemeldeten Geräte.
import webpush from 'web-push';

const OWNER = 'Larsen140', DATA_REPO = 'lenas-tagebuch-daten';
const DATA_FILE = 'lenas-tagebuch.json', SUBS_FILE = 'push-abos.json', SENT_FILE = 'erinnerungen-gesendet.json';
const VAPID_PUBLIC = 'BOoCkVQJDPO3JN1-SehY6M6JMyG3Shk2CVS5Htu9Ydte2NNA2XrVfZ8C5Aaztai0eqLpBh5-fIts6WgIR-VLrvo';
const MAX_LATE = 3 * 3600e3;   // ältere verpasste Erinnerungen nicht mehr senden
const EARLY = 90e3;            // bis zu 90 s vorher ist ok
const { DATA_TOKEN, VAPID_PRIVATE_KEY } = process.env;
const api = f => `https://api.github.com/repos/${OWNER}/${DATA_REPO}/contents/${f}`;
const headers = () => ({ Authorization: `Bearer ${DATA_TOKEN}`, Accept: 'application/vnd.github+json' });

export async function readJson(file, fallback, fetchFn = fetch) {
  const r = await fetchFn(api(file), { headers: headers() });
  if (r.status === 404) return { data: fallback, sha: null };
  if (!r.ok) throw new Error(`${file} nicht lesbar (${r.status})`);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function writeJson(file, data, sha, message, fetchFn = fetch) {
  const body = { message, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64') };
  if (sha) body.sha = sha;
  return fetchFn(api(file), { method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const fmtTime = (ms, tz) => new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: tz || 'Europe/Berlin' }).format(ms);
const dayKey = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Berlin' }).format(ms);
// date = 'JJJJ-MM-TT' des Eintrags, verglichen mit „heute" in Lenas Zeitzone
export function whenText(date, tz, nowMs) {
  const today = dayKey(nowMs, tz);
  const shift = n => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  if (date === today) return 'Heute';
  if (date === shift(1)) return 'Morgen';
  if (date === shift(2)) return 'Übermorgen';
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d, 12));
}

// Welche Erinnerungen sind jetzt dran? (reine Funktion, damit testbar)
export function dueReminders(data, sent, nowMs) {
  const out = [];
  for (const e of data.events || []) {
    if (e.deleted || !e.remindAt || !e.title) continue;
    if (e.remindAt > nowMs + EARLY || e.remindAt < nowMs - MAX_LATE) continue;
    // Termin hat schon begonnen (z. B. zu spät eingetragen) → keine Erinnerung mehr; ganztägige gelten den ganzen Tag
    if (!e.allDay && e.startAt && e.startAt < nowMs - 60e3) continue;
    const key = `e:${e.id}:${e.remindAt}`; if (sent[key]) continue;
    const when = whenText(e.date, e.tz, nowMs);
    const time = e.allDay ? 'ganztägig' : `um ${fmtTime(e.startAt, e.tz)}`;
    out.push({ key, payload: { title: `📅 ${e.title}`, body: `${when} ${time}${e.place ? ' · ' + e.place : ''}`,
      url: `./?open=cal&day=${e.date}`, tag: key } });
  }
  for (const t of data.todos || []) {
    if (t.deleted || t.done || !t.remindAt || !t.text) continue;
    if (t.remindAt > nowMs + EARLY || t.remindAt < nowMs - MAX_LATE) continue;
    const key = `t:${t.id}:${t.remindAt}`; if (sent[key]) continue;
    const when = whenText(t.due, t.tz, nowMs).replace(/^Heute$/, 'heute').replace(/^Morgen$/, 'morgen').replace(/^Übermorgen$/, 'übermorgen');
    out.push({ key, payload: { title: '✅ Aufgabe', body: `${t.text} – fällig ${/^[a-zü]/.test(when) ? when : 'am ' + when}`, url: './?open=todo', tag: key } });
  }
  return out;
}

async function main() {
  if (!DATA_TOKEN || !VAPID_PRIVATE_KEY) { console.log('⚠️  Secrets fehlen – keine Erinnerungen gesendet.'); return; }
  const nowMs = Date.now();
  const { data } = await readJson(DATA_FILE, { events: [], todos: [] });
  const sentFile = await readJson(SENT_FILE, {});
  const sent = sentFile.data || {};
  const due = dueReminders(data, sent, nowMs);
  if (!due.length) { console.log('Gerade keine Erinnerung fällig.'); return; }

  const subsFile = await readJson(SUBS_FILE, []);
  const subs = subsFile.data || [];
  if (!subs.length) { console.log('Kein Gerät angemeldet.'); return; }
  webpush.setVapidDetails('https://larsen140.github.io/Lenas-Tagebuch/', VAPID_PUBLIC, VAPID_PRIVATE_KEY.trim());

  const gone = new Set();
  for (const r of due) {
    let ok = false;
    for (const s of subs) {
      if (gone.has(s.endpoint)) continue;
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(r.payload), { TTL: 3600, urgency: 'high' }); ok = true; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.add(s.endpoint); else console.log('Fehler', e.statusCode || '', e.body || e.message); }
    }
    console.log(`${ok ? '✓' : '✗'} ${r.payload.title} – ${r.payload.body}`);
    sent[r.key] = nowMs;
  }
  // gesendete merken (Einträge älter als 4 Tage aufräumen)
  for (const [k, v] of Object.entries(sent)) if (v < nowMs - 4 * 864e5) delete sent[k];
  await writeJson(SENT_FILE, sent, sentFile.sha, 'Erinnerungen gesendet');
  if (gone.size) await writeJson(SUBS_FILE, subs.filter(s => !gone.has(s.endpoint)), subsFile.sha, 'Abgemeldete Geräte entfernt');
}

if (process.argv[1] && process.argv[1].endsWith('erinnerungen.mjs')) main().catch(e => console.log('Fehler:', e.message));
