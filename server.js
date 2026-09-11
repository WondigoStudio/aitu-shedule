const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BBDpRYPAZLEqkfQHjFWqsvUS2soRrkfJrkmayF7cNi2UAcG9IjF8Lhwx4isuh0LSRG7fOYZiB6yOncZu00sXeUI';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'tCezqUWx-rTz7ThUBvVi2TKfT7MbD4prVZ94E8bvLqI';

webpush.setVapidDetails('mailto:no-reply@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function loadData(){
  try{ return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e){ return {}; }
}
function saveData(data){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
// Shape: { [code]: { schedule: {0:[],...,6:[]}, subscriptions: [pushSub,...], lastNotified: id|null } }
let db = loadData();

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

function ensureCode(code){
  if(!db[code]) db[code] = { schedule: {0:[],1:[],2:[],3:[],4:[],5:[],6:[]}, subscriptions: [], lastNotified: null };
  return db[code];
}

// --- Schedule sync ---
app.get('/api/schedule/:code', (req, res) => {
  const entry = db[req.params.code];
  if(!entry) return res.status(404).json({ error: 'not found' });
  res.json({ schedule: entry.schedule });
});

app.post('/api/schedule/:code', (req, res) => {
  const entry = ensureCode(req.params.code);
  entry.schedule = req.body.schedule || entry.schedule;
  if(typeof req.body.tzOffsetMinutes === 'number') entry.tzOffsetMinutes = req.body.tzOffsetMinutes;
  saveData(db);
  res.json({ ok: true });
});

// --- Push subscription ---
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe/:code', (req, res) => {
  const entry = ensureCode(req.params.code);
  const sub = req.body.subscription;
  if(!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
  const exists = entry.subscriptions.find(s => s.endpoint === sub.endpoint);
  if(!exists) entry.subscriptions.push(sub);
  saveData(db);
  res.json({ ok: true });
});

app.post('/api/unsubscribe/:code', (req, res) => {
  const entry = ensureCode(req.params.code);
  const endpoint = req.body.endpoint;
  entry.subscriptions = entry.subscriptions.filter(s => s.endpoint !== endpoint);
  saveData(db);
  res.json({ ok: true });
});

app.get('/api/debug/:code', (req, res) => {
  const entry = ensureCode(req.params.code);
  const current = findCurrentLesson(entry.schedule || {}, entry.tzOffsetMinutes);
  res.json({
    code: req.params.code,
    subscriptionsCount: (entry.subscriptions || []).length,
    lastNotified: entry.lastNotified,
    tzOffsetMinutes: entry.tzOffsetMinutes,
    todayIndex: getTodayIndex(entry.tzOffsetMinutes),
    lessonsToday: (entry.schedule[getTodayIndex(entry.tzOffsetMinutes)] || entry.schedule[String(getTodayIndex(entry.tzOffsetMinutes))] || []).map(l => ({ id: l.id, subject: l.subject, time: l.time })),
    serverCurrentLesson: current ? { id: current.id, subject: current.subject, time: current.time } : null,
    serverTimeNow: new Date().toString(),
    localTimeNowForCode: entry.tzOffsetMinutes != null ? new Date(Date.now() - entry.tzOffsetMinutes*60000).toISOString().slice(11,16) : 'unknown (no tz sent yet)'
  });
});

app.get('/', (req, res) => {
  res.send('Schedule sync + push server is running.');
});

// --- Lesson time helpers (mirrors frontend logic) ---
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

function getLocalDateStr(tzOffsetMinutes){
  const localMs = Date.now() - (tzOffsetMinutes || 0) * 60000;
  const d = new Date(localMs);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
}

// --- Periodic check: send push when current lesson changes, and 10 min before a lesson starts ---
setInterval(() => {
  let changed = false;
  for(const code of Object.keys(db)){
    const entry = db[code];
    if(!entry.subscriptions || entry.subscriptions.length === 0) continue;
    const tz = entry.tzOffsetMinutes;
    const todayIdx = getTodayIndex(tz);
    const nowMin = getLocalNowMinutes(tz);
    const todayStr = getLocalDateStr(tz);
    const todaysLessons = entry.schedule[todayIdx] || entry.schedule[String(todayIdx)] || [];

    // "Lesson starting now" notification
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
        entry.subscriptions.forEach(sub => {
          webpush.sendNotification(sub, payload).catch(() => {
            entry.subscriptions = entry.subscriptions.filter(s => s.endpoint !== sub.endpoint);
          });
        });
      }
    }

    // "Lesson in 10 minutes" notification
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
        entry.subscriptions.forEach(sub => {
          webpush.sendNotification(sub, payload).catch(() => {
            entry.subscriptions = entry.subscriptions.filter(s => s.endpoint !== sub.endpoint);
          });
        });
      }
    }
  }
  if(changed) saveData(db);
}, 30000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
