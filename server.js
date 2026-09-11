const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const { Redis } = require('@upstash/redis');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BBDpRYPAZLEqkfQHjFWqsvUS2soRrkfJrkmayF7cNi2UAcG9IjF8Lhwx4isuh0LSRG7fOYZiB6yOncZu00sXeUI';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'tCezqUWx-rTz7ThUBvVi2TKfT7MbD4prVZ94E8bvLqI';
webpush.setVapidDetails('mailto:no-reply@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

if(!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN){
  console.warn('WARNING: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set. Data will NOT persist across deploys.');
}
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CODES_SET = 'schedule:codes';
const defaultEntry = () => ({ schedule: {0:[],1:[],2:[],3:[],4:[],5:[],6:[]}, subscriptions: [], lastNotified: null, upcomingNotified: {}, tzOffsetMinutes: null });

async function getEntry(code){
  const raw = await redis.get(`schedule:entry:${code}`);
  if(!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function setEntry(code, entry){
  await redis.set(`schedule:entry:${code}`, JSON.stringify(entry));
  await redis.sadd(CODES_SET, code);
}
async function ensureEntry(code){
  let entry = await getEntry(code);
  if(!entry){ entry = defaultEntry(); await setEntry(code, entry); }
  return entry;
}
async function listCodes(){
  const codes = await redis.smembers(CODES_SET);
  return codes || [];
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// --- Schedule sync ---
app.get('/api/schedule/:code', async (req, res) => {
  const entry = await getEntry(req.params.code);
  if(!entry) return res.status(404).json({ error: 'not found' });
  res.json({ schedule: entry.schedule });
});

app.post('/api/schedule/:code', async (req, res) => {
  const entry = await ensureEntry(req.params.code);
  entry.schedule = req.body.schedule || entry.schedule;
  if(typeof req.body.tzOffsetMinutes === 'number') entry.tzOffsetMinutes = req.body.tzOffsetMinutes;
  await setEntry(req.params.code, entry);
  res.json({ ok: true });
});

// --- Push subscription ---
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe/:code', async (req, res) => {
  const entry = await ensureEntry(req.params.code);
  const sub = req.body.subscription;
  if(!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
  const exists = entry.subscriptions.find(s => s.endpoint === sub.endpoint);
  if(!exists) entry.subscriptions.push(sub);
  await setEntry(req.params.code, entry);
  res.json({ ok: true });
});

app.post('/api/unsubscribe/:code', async (req, res) => {
  const entry = await ensureEntry(req.params.code);
  const endpoint = req.body.endpoint;
  entry.subscriptions = entry.subscriptions.filter(s => s.endpoint !== endpoint);
  await setEntry(req.params.code, entry);
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.send('Schedule sync + push server is running.');
});

// --- Time helpers ---
function parseTimeRange(timeStr){
  if(!timeStr) return null;
  const m = timeStr.match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/);
  if(!m) return null;
  const [, h1, mm1, h2, mm2] = m;
  return { start: parseInt(h1)*60 + parseInt(mm1), end: parseInt(h2)*60 + parseInt(mm2) };
}
function getLocalNowMinutes(tzOffsetMinutes){
  const localMs = Date.now() - (tzOffsetMinutes || 0) * 60000;
  const d = new Date(localMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function getTodayIndex(tzOffsetMinutes){
  const localMs = Date.now() - (tzOffsetMinutes || 0) * 60000;
  const d = new Date(localMs);
  const jsDay = d.getUTCDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}
function getLocalDateStr(tzOffsetMinutes){
  const localMs = Date.now() - (tzOffsetMinutes || 0) * 60000;
  const d = new Date(localMs);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
}
function findCurrentLesson(schedule, tzOffsetMinutes){
  const idx = getTodayIndex(tzOffsetMinutes);
  const list = schedule[idx] || schedule[String(idx)] || [];
  const nowMin = getLocalNowMinutes(tzOffsetMinutes);
  for(const lesson of list){
    const r = parseTimeRange(lesson.time);
    if(r && nowMin >= r.start && nowMin < r.end) return lesson;
  }
  return null;
}

// --- Debug ---
app.get('/api/debug/:code', async (req, res) => {
  const entry = await ensureEntry(req.params.code);
  const current = findCurrentLesson(entry.schedule || {}, entry.tzOffsetMinutes);
  const idx = getTodayIndex(entry.tzOffsetMinutes);
  res.json({
    code: req.params.code,
    subscriptionsCount: (entry.subscriptions || []).length,
    lastNotified: entry.lastNotified,
    tzOffsetMinutes: entry.tzOffsetMinutes,
    todayIndex: idx,
    lessonsToday: (entry.schedule[idx] || entry.schedule[String(idx)] || []).map(l => ({ id: l.id, subject: l.subject, time: l.time })),
    serverCurrentLesson: current ? { id: current.id, subject: current.subject, time: current.time } : null,
    upcomingNotified: entry.upcomingNotified || {},
    serverTimeNow: new Date().toString(),
    localTimeNowForCode: entry.tzOffsetMinutes != null ? new Date(Date.now() - entry.tzOffsetMinutes*60000).toISOString().slice(11,16) : 'unknown (no tz sent yet)'
  });
});

// --- Periodic check: send push when current lesson changes, and 10 min before a lesson starts ---
setInterval(async () => {
  let codes = [];
  try{ codes = await listCodes(); }catch(e){ console.error('listCodes failed', e); return; }

  for(const code of codes){
    let entry;
    try{ entry = await getEntry(code); }catch(e){ continue; }
    if(!entry || !entry.subscriptions || entry.subscriptions.length === 0) continue;

    const tz = entry.tzOffsetMinutes;
    const todayIdx = getTodayIndex(tz);
    const nowMin = getLocalNowMinutes(tz);
    const todayStr = getLocalDateStr(tz);
    const todaysLessons = entry.schedule[todayIdx] || entry.schedule[String(todayIdx)] || [];
    let changed = false;

    const current = findCurrentLesson(entry.schedule || {}, tz);
    const currentId = current ? current.id : null;
    if(currentId !== entry.lastNotified){
      entry.lastNotified = currentId;
      changed = true;
      if(current){
        const payload = JSON.stringify({
          title: 'Сейчас: ' + (current.subject || 'Урок'),
          body: [current.teacher, current.decoded || current.room].filter(Boolean).join(' · ') || (current.time || ''),
        });
        for(const sub of entry.subscriptions.slice()){
          try{ await webpush.sendNotification(sub, payload); }
          catch(e){ entry.subscriptions = entry.subscriptions.filter(s => s.endpoint !== sub.endpoint); }
        }
      }
    }

    if(!entry.upcomingNotified) entry.upcomingNotified = {};
    for(const lesson of todaysLessons){
      const r = parseTimeRange(lesson.time);
      if(!r) continue;
      const minutesUntil = r.start - nowMin;
      if(minutesUntil > 0 && minutesUntil <= 10 && entry.upcomingNotified[lesson.id] !== todayStr){
        entry.upcomingNotified[lesson.id] = todayStr;
        changed = true;
        const payload = JSON.stringify({
          title: 'Через ' + minutesUntil + ' мин: ' + (lesson.subject || 'Урок'),
          body: [lesson.teacher, lesson.decoded || lesson.room].filter(Boolean).join(' · ') || ('в ' + lesson.time),
        });
        for(const sub of entry.subscriptions.slice()){
          try{ await webpush.sendNotification(sub, payload); }
          catch(e){ entry.subscriptions = entry.subscriptions.filter(s => s.endpoint !== sub.endpoint); }
        }
      }
    }

    if(changed){
      try{ await setEntry(code, entry); }catch(e){ console.error('setEntry failed', e); }
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
