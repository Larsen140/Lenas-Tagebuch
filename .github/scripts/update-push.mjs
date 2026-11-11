// Liest den neuesten Eintrag aus dem Updates-Tab und schickt ihn als Push-Nachricht an alle angemeldeten Geräte.
import webpush from 'web-push';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const OWNER = 'Larsen140', DATA_REPO = 'lenas-tagebuch-daten', FILE = 'push-abos.json';
const VAPID_PUBLIC = 'BOoCkVQJDPO3JN1-SehY6M6JMyG3Shk2CVS5Htu9Ydte2NNA2XrVfZ8C5Aaztai0eqLpBh5-fIts6WgIR-VLrvo';
const LABEL = { neu: 'Neu ✨', besser: 'Verbessert', fix: 'Bugfix' };
const { DATA_TOKEN, VAPID_PRIVATE_KEY, BEFORE, MANUAL } = process.env;

export function topEntry(html) {
  const m = html.match(/const CHANGELOG = \[\s*\{ v: '([^']+)'[^\[]*items: \[\s*\['(\w+)', '((?:[^'\\]|\\.)*)'\]/);
  return m ? { v: m[1], type: m[2], text: m[3].replace(/\\(.)/g, '$1') } : null;
}

async function main() {
  if (!DATA_TOKEN || !VAPID_PRIVATE_KEY) {
    console.log('⚠️  Secrets DATA_TOKEN und/oder VAPID_PRIVATE_KEY fehlen noch – keine Nachricht gesendet.');
    return;
  }
  const cur = topEntry(fs.readFileSync('index.html', 'utf8'));
  if (!cur) { console.log('Kein Eintrag im Updates-Tab gefunden.'); return; }
  const manual = MANUAL === 'true';
  if (!manual) {
    let prev = null;
    if (BEFORE && !/^0+$/.test(BEFORE)) { try { prev = topEntry(execSync(`git show ${BEFORE}:index.html`, { maxBuffer: 50e6 }).toString()); } catch {} }
    if (prev && prev.v === cur.v) { console.log(`Version ${cur.v} unverändert (stilles Update) – keine Nachricht.`); return; }
  }

  const api = `https://api.github.com/repos/${OWNER}/${DATA_REPO}/contents/${FILE}`;
  const headers = { Authorization: `Bearer ${DATA_TOKEN}`, Accept: 'application/vnd.github+json' };
  const r = await fetch(api, { headers });
  if (r.status === 404) { console.log('Noch kein Gerät für Benachrichtigungen angemeldet.'); return; }
  if (!r.ok) throw new Error(`Daten-Repo nicht lesbar (${r.status}) – stimmt der DATA_TOKEN?`);
  const file = await r.json();
  const subs = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));

  webpush.setVapidDetails('https://larsen140.github.io/Lenas-Tagebuch/', VAPID_PUBLIC, VAPID_PRIVATE_KEY.trim());
  const payload = JSON.stringify(manual
    ? { title: 'Lenas Tagebuch', body: `Test: Benachrichtigungen funktionieren ✨ (Version ${cur.v})`, url: './?open=updates', tag: 'test' }
    : { title: `Neues Update – Version ${cur.v}`, body: `${LABEL[cur.type] || ''}: ${cur.text}`, url: './?open=updates', tag: 'update-' + cur.v });

  const keep = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 86400, urgency: 'normal' });
      console.log(`✓ gesendet an ${s.device || 'Gerät'}`); keep.push(s);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) console.log(`✗ ${s.device || 'Gerät'} ist nicht mehr angemeldet – wird entfernt`);
      else { console.log(`✗ ${s.device || 'Gerät'}: Fehler ${e.statusCode || ''} ${e.body || e.message}`); keep.push(s); }
    }
  }
  if (keep.length !== subs.length) {
    const body = { message: 'Abgemeldete Geräte entfernt', sha: file.sha, content: Buffer.from(JSON.stringify(keep, null, 1)).toString('base64') };
    await fetch(api, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
}

if (process.argv[1] && process.argv[1].endsWith('update-push.mjs')) main().catch(e => { console.log('Fehler:', e.message); });
