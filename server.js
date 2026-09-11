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
  const entry = ensureCode(req.params.code);
  res.json({ schedule: entry.schedule });
});

app.post('/api/schedule/:code', (req, res) => {
  const entry = ensureCode(req.params.code);
  entry.schedule = req.body.schedule || entry.schedule;
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
  const current = findCurrentLesson(entry.schedule || {});
  res.json({
    code: req.params.code,
    subscriptionsCount: (entry.subscriptions || []).length,
    lastNotified: entry.lastNotified,
    todayIndex: getTodayIndex(),
    lessonsToday: (entry.schedule[getTodayIndex()] || entry.schedule[String(getTodayIndex())] || []).map(l => ({ id: l.id, subject: l.subject, time: l.time })),
    serverCurrentLesson: current ? { id: current.id, subject: current.subject, time: current.time } : null,
    serverTimeNow: new Date().toString()
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
function getTodayIndex(){
  const jsDay = new Date().getDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}
function findCurrentLesson(schedule){
  const idx = getTodayIndex();
  const list = schedule[idx] || schedule[String(idx)] || [];
  const nowMin = new Date().getHours()*60 + new Date().getMinutes();
  for(const lesson of list){
    const r = parseTimeRange(lesson.time);
    if(r && nowMin >= r.start && nowMin < r.end) return lesson;
  }
  return null;
}

// --- Periodic check: send push when current lesson changes ---
setInterval(() => {
  let changed = false;
  for(const code of Object.keys(db)){
    const entry = db[code];
    if(!entry.subscriptions || entry.subscriptions.length === 0) continue;
    const current = findCurrentLesson(entry.schedule || {});
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
  }
  if(changed) saveData(db);
}, 30000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
