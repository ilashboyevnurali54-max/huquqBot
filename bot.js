require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = (process.env.WEBAPP_URL || '').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 3000);
const MCQ_COUNT = Number(process.env.MCQ_COUNT || 35);
const SHORT_COUNT = Number(process.env.SHORT_COUNT || 10);
const TEACHERS = (process.env.TEACHER_IDS || '').split(',').map(s => Number(s.trim())).filter(Boolean);
const isTeacher = id => TEACHERS.includes(id);

if (!BOT_TOKEN) { console.error('BOT_TOKEN .env faylida yo\'q'); process.exit(1); }
const bot = new Telegraf(BOT_TOKEN);

// ================= Ma'lumotlar bazasi (data.json) =================
const DB_FILE = './data.json';
let db = { questions: { mcq: [], short: [] }, code: null, published: false, active: false, students: {} };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mcqScore = s => db.questions.mcq.reduce((n, q, i) => n + (s.answers[i] === q.correct ? 1 : 0), 0);

// ================= Mini ilova uchun API =================
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Telegram initData imzosini tekshirish
function auth(req, res, next) {
  try {
    const p = new URLSearchParams(req.get('X-Init-Data') || '');
    const hash = p.get('hash');
    p.delete('hash');
    const check = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
    if (!hash || hash.length !== calc.length || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(calc)))
      return res.status(401).json({ error: 'Avtorizatsiya xatosi. Mini ilovani bot orqali oching.' });
    if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400)
      return res.status(401).json({ error: 'Sessiya eskirgan. Mini ilovani qayta oching.' });
    const user = JSON.parse(p.get('user'));
    if (!isTeacher(user.id)) return res.status(403).json({ error: 'Bu bo\'lim faqat o\'qituvchi uchun.' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Avtorizatsiya xatosi.' });
  }
}

const fail = msg => { throw new Error(msg); };
function cleanMcq(b) {
  const q = String(b.q || '').trim();
  if (!q) fail('Savol matnini yozing.');
  if (q.length > 600) fail('Savol juda uzun (600 belgigacha).');
  const options = {};
  for (const k of ['A', 'B', 'C', 'D']) {
    const v = String((b.options || {})[k] || '').trim();
    if (!v) fail(`${k} variantini yozing.`);
    if (v.length > 300) fail(`${k} varianti juda uzun.`);
    options[k] = v;
  }
  if (!['A', 'B', 'C', 'D'].includes(b.correct)) fail('To\'g\'ri javobni belgilang.');
  return { q, options, correct: b.correct };
}
function cleanShort(b) {
  const q = String(b.q || '').trim();
  if (!q) fail('Savol matnini yozing.');
  if (q.length > 600) fail('Savol juda uzun (600 belgigacha).');
  return { q };
}
const CLEAN = { mcq: cleanMcq, short: cleanShort };
const LIMIT = { mcq: MCQ_COUNT, short: SHORT_COUNT };

const guard = fn => (req, res) => {
  try {
    if (!CLEAN[req.params.type] && req.params.type !== undefined) fail('Noto\'g\'ri tur.');
    fn(req, res);
  } catch (e) { res.status(400).json({ error: e.message }); }
};
const locked = () => db.published && fail('Test e\'lon qilingan, savollarni o\'zgartirib bo\'lmaydi. Botda «🆕 Yangi test» ni bosing.');
const state = () => ({
  mcq: db.questions.mcq, short: db.questions.short,
  published: db.published, active: db.active, code: db.code,
  limits: { mcq: MCQ_COUNT, short: SHORT_COUNT }
});

app.get('/api/state', auth, (req, res) => res.json(state()));

app.post('/api/q/:type', auth, guard((req, res) => {
  locked();
  const t = req.params.type, list = db.questions[t];
  if (list.length >= LIMIT[t]) fail(`Bu turdagi savollar ${LIMIT[t]} tadan oshmasligi kerak.`);
  list.push(CLEAN[t](req.body)); save();
  res.json(state());
}));

app.put('/api/q/:type/:i', auth, guard((req, res) => {
  locked();
  const t = req.params.type, i = Number(req.params.i);
  if (!db.questions[t][i]) fail('Savol topilmadi.');
  db.questions[t][i] = CLEAN[t](req.body); save();
  res.json(state());
}));

app.delete('/api/q/:type/:i', auth, guard((req, res) => {
  locked();
  const t = req.params.type, i = Number(req.params.i);
  if (!db.questions[t][i]) fail('Savol topilmadi.');
  db.questions[t].splice(i, 1); save();
  res.json(state());
}));

app.post('/api/publish', auth, guard((req, res) => {
  locked();
  const { mcq, short } = db.questions;
  if (mcq.length !== MCQ_COUNT || short.length !== SHORT_COUNT)
    fail(`Test to'liq emas: test ${mcq.length}/${MCQ_COUNT}, yozma ${short.length}/${SHORT_COUNT}.`);
  db.code = String(crypto.randomInt(100000, 1000000));
  db.published = true; db.active = true; save();
  res.json({ code: db.code });
  broadcastCode().then(r => bot.telegram.sendMessage(req.user.id,
    `✅ <b>Test tayyor va e'lon qilindi!</b>\n🔑 Test kodi: <code>${db.code}</code>\n\n${report(r)}`, { parse_mode: 'HTML' }))
    .catch(e => console.error(e));
}));

app.use((err, req, res, next) => res.status(400).json({ error: 'Noto\'g\'ri so\'rov.' }));

// ================= O'quvchilarga kod yuborish =================
async function broadcastCode() {
  const all = Object.entries(db.students);
  const targets = all.filter(([, s]) => s.name && !s.done);
  const unnamed = all.filter(([, s]) => !s.name).length;
  let sent = 0; const errors = [];
  for (const [id, st] of targets) {
    try {
      await bot.telegram.sendMessage(id,
        `📢 <b>Huquq testi boshlandi!</b>\n\n🔑 Test kodi: <code>${db.code}</code>\n\nBoshlash uchun tugmani bosing yoki kodni shu yerga yozing.`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('▶️ Testni boshlash', 'begin')]]) });
      sent++;
    } catch (e) {
      console.error('Yuborilmadi:', id, e.message);
      errors.push(`${st.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return { sent, total: targets.length, unnamed, errors };
}
const report = r =>
  `📨 ${r.sent} ta o'quvchiga test kodi yuborildi (ro'yxatda ${r.total} ta).` +
  (r.errors.length ? `\n\n❌ Yuborilmadi (${r.errors.length}):\n${esc(r.errors.slice(0, 15).join('\n'))}` : '') +
  (r.unnamed ? `\n\n⚠️ ${r.unnamed} ta o'quvchi ismini to'liq kiritmagan, ularga yuborilmadi.` : '');

// ================= Savol berish =================
async function sendQuestion(ctx, s) {
  const { mcq, short } = db.questions;
  const total = mcq.length + short.length;
  const i = s.idx;
  if (i >= total) return finish(ctx, s);
  if (i < mcq.length) {
    const q = mcq[i];
    const text = `📝 ${i + 1}/${total} (test)\n\n${q.q}\n\n` + Object.entries(q.options).map(([k, v]) => `${k}) ${v}`).join('\n');
    await ctx.reply(text, Markup.inlineKeyboard(Object.keys(q.options).map(k => Markup.button.callback(k, `ans:${i}:${k}`))));
  } else {
    await ctx.reply(`✍️ ${i + 1}/${total} (qisqa yozma javob)\n\n${short[i - mcq.length].q}\n\nJavobingizni matn ko'rinishida yozing.`);
  }
}

async function finish(ctx, s) {
  s.done = true; s.state = 'done'; save();
  const score = mcqScore(s), n = db.questions.mcq.length;
  await ctx.reply(`✅ Test yakunlandi!\n\nTest savollari bo'yicha natija: ${score}/${n}\nQisqa yozma javoblaringizni o'qituvchi tekshiradi.`);
  TEACHERS.forEach(t => bot.telegram.sendMessage(t, `✅ ${s.name} testni tugatdi. Test: ${score}/${n}`).catch(() => {}));
}

// ================= O'quvchi =================
bot.start(async ctx => {
  const id = ctx.from.id;
  if (isTeacher(id)) {
    return ctx.reply(
      `👨‍🏫 O'qituvchi paneli\n\nSavollar: test ${db.questions.mcq.length}/${MCQ_COUNT}, yozma ${db.questions.short.length}/${SHORT_COUNT}\nHolat: ${statusText()}\n\nPastdagi tugmalardan foydalaning.`,
      panelKb());
  }
  const s = db.students[id];
  if (s && s.name) {
    return ctx.reply(`Siz ro'yxatdan o'tgansiz: ${s.name}\n` + (db.active ? 'Test ochiq! Kodni yozing yoki /test ni bosing.' : 'Test boshlanishini kuting.'));
  }
  db.students[id] = { name: null, state: 'registering', idx: 0, answers: [], done: false };
  save();
  ctx.reply(`Assalomu alaykum! 👋\nHuquq fanidan test botiga xush kelibsiz.\n\nIsm va familiyangizni yozing (masalan: Aliyev Vali):`);
});

async function beginTest(ctx) {
  const s = db.students[ctx.from.id];
  if (!s || !s.name) return ctx.reply('Avval /start orqali ro\'yxatdan o\'ting.');
  if (!db.published || !db.active) return ctx.reply('⏳ Test hali boshlanmagan. O\'qituvchi boshlashini kuting.');
  if (s.done) return ctx.reply('Siz testni allaqachon topshirgansiz.');
  if (s.state === 'testing') return sendQuestion(ctx, s);
  s.state = 'testing'; s.idx = 0; s.answers = []; s.startedAt = new Date().toISOString(); save();
  await ctx.reply(`Test boshlandi! Omad, ${s.name}! 🍀`);
  sendQuestion(ctx, s);
}
bot.command('test', beginTest);
bot.action('begin', async ctx => { await ctx.answerCbQuery(); beginTest(ctx); });

bot.action(/^ans:(\d+):([A-D])$/, async ctx => {
  const s = db.students[ctx.from.id];
  const i = Number(ctx.match[1]);
  if (!s || s.state !== 'testing' || !db.active || s.idx !== i) return ctx.answerCbQuery('Bu savol allaqachon javoblangan');
  s.answers[i] = ctx.match[2]; s.idx++; save();
  await ctx.answerCbQuery(`Javob: ${ctx.match[2]}`);
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
  sendQuestion(ctx, s);
});

bot.on('text', async (ctx, next) => {
  if (isTeacher(ctx.from.id) || ctx.message.text.startsWith('/')) return next();
  const s = db.students[ctx.from.id];
  if (!s) return ctx.reply('/start ni bosing.');
  const text = ctx.message.text.trim();

  if (s.state === 'registering') {
    if (text.split(/\s+/).length < 2 || text.length > 60) return ctx.reply('Iltimos, ism va familiyani to\'liq yozing (masalan: Aliyev Vali).');
    s.name = text; s.state = 'registered'; save();
    TEACHERS.forEach(t => bot.telegram.sendMessage(t, `🆕 Ro'yxatdan o'tdi: ${s.name}`).catch(() => {}));
    return ctx.reply(`✅ Rahmat, ${s.name}! Ro'yxatdan o'tdingiz.\n` +
      (db.active ? `Test ochiq — test kodini yozing.` : 'O\'qituvchi testni boshlaganda sizga kod keladi.'));
  }

  if (s.state === 'testing' && db.active) {
    if (s.idx < db.questions.mcq.length) return ctx.reply('Bu savolga yuqoridagi A/B/C/D tugmalaridan birini bosing.');
    s.answers[s.idx] = text; s.idx++; save();
    return sendQuestion(ctx, s);
  }
  if (s.state === 'testing' && !db.active) return ctx.reply('Test o\'qituvchi tomonidan to\'xtatilgan.');

  // Test kodini yozish
  if (/^\d{6}$/.test(text)) {
    if (db.published && db.active && text === db.code) return beginTest(ctx);
    return ctx.reply('❌ Test kodi noto\'g\'ri yoki test hozir yopiq.');
  }
});

// ================= O'qituvchi =================
const BTN = {
  add: "📝 Savol qo'shish", code: '🔑 Test kodi',
  list: "👥 Ro'yxat", res: '📊 Natijalar',
  stop: "⛔ Testni to'xtatish", fresh: '🆕 Yangi test',
  wipe: "🗑 O'quvchilarni o'chirish"
};
const panelKb = () => Markup.keyboard([[BTN.add, BTN.code], [BTN.list, BTN.res], [BTN.stop, BTN.fresh], [BTN.wipe]]).resize();
const statusText = () => db.published ? (db.active ? '🟢 test ochiq' : '🔴 test to\'xtatilgan') : '🛠 tayyorlanmoqda';
const onlyTeacher = fn => ctx => isTeacher(ctx.from.id) ? fn(ctx) : ctx.reply('Bu buyruq faqat o\'qituvchi uchun.');

const openApp = ctx => {
  const { mcq, short } = db.questions;
  if (!WEBAPP_URL.startsWith('https://'))
    return ctx.reply('⚠️ Mini ilova ishlashi uchun .env faylida WEBAPP_URL (https:// bilan boshlanadigan manzil) ko\'rsatilishi kerak.');
  return ctx.reply(
    `📝 Savollar tahrirlagichi\n\nTest savollari: ${mcq.length}/${MCQ_COUNT}\nYozma savollar: ${short.length}/${SHORT_COUNT}\nHolat: ${statusText()}`,
    Markup.inlineKeyboard([[Markup.button.webApp('📝 Mini ilovani ochish', WEBAPP_URL)]]));
};

const showCode = ctx => {
  const { mcq, short } = db.questions;
  if (!db.published)
    return ctx.reply(`🛠 Test hali tayyor emas.\nTest savollari: ${mcq.length}/${MCQ_COUNT}\nYozma savollar: ${short.length}/${SHORT_COUNT}\n\n«${BTN.add}» orqali savollarni qo'shing. Hammasi to'lgach, mini ilovada «Testni tayyor qilish» ni bosing — kod shu yerda paydo bo'ladi.`);
  const done = Object.values(db.students).filter(s => s.done).length;
  const named = Object.values(db.students).filter(s => s.name).length;
  const kb = db.active
    ? [[Markup.button.callback('📨 Kodni qayta yuborish', 'resend')]]
    : [[Markup.button.callback('▶️ Qayta ochish va yuborish', 'reopen')]];
  return ctx.reply(`🔑 Test kodi: <code>${db.code}</code>\nHolat: ${statusText()}\nO'quvchilar: ${named} ta, tugatganlar: ${done} ta`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
};

const stopTest = ctx => { db.active = false; save(); ctx.reply('⛔ Test to\'xtatildi. Qayta ochish uchun «🔑 Test kodi» ni bosing.'); };

const listStudents = ctx => {
  const list = Object.values(db.students).filter(s => s.name);
  if (!list.length) return ctx.reply('Hali hech kim ro\'yxatdan o\'tmagan.');
  const done = list.filter(s => s.done).length;
  ctx.reply(`Ro'yxat (${list.length} ta, tugatgan: ${done}):\n` + list.map((s, n) =>
    `${n + 1}. ${s.name} ${s.done ? '✅' : s.state === 'testing' ? '✏️' : '⏳'}`).join('\n'));
};

const sendResults = async ctx => {
  const { mcq, short } = db.questions;
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['№', 'Ism familiya', 'Holat', `Test (/${mcq.length})`, ...mcq.map((_, i) => `T${i + 1}`), ...short.map((_, i) => `Yozma${i + 1}`)];
  const key = ['', "To'g'ri javob", '', '', ...mcq.map(x => x.correct), ...short.map(x => x.q)];
  const rows = Object.values(db.students).filter(s => s.name).map((s, n) => [
    n + 1, s.name, s.done ? 'tugatdi' : s.state === 'testing' ? 'jarayonda' : 'boshlamadi', mcqScore(s),
    ...mcq.map((_, i) => s.answers[i] || ''),
    ...short.map((_, i) => s.answers[mcq.length + i] || '')
  ]);
  const csv = '\uFEFF' + [head, key, ...rows].map(r => r.map(q).join(',')).join('\n');
  await ctx.replyWithDocument({ source: Buffer.from(csv, 'utf8'), filename: 'natijalar.csv' });
};

const askConfirm = (text, yes, no) => ctx => ctx.reply(text,
  Markup.inlineKeyboard([[Markup.button.callback('Ha', yes), Markup.button.callback('Bekor', no)]]));

bot.hears(BTN.add, onlyTeacher(openApp));
bot.hears(BTN.code, onlyTeacher(showCode));
bot.hears(BTN.list, onlyTeacher(listStudents));
bot.hears(BTN.res, onlyTeacher(sendResults));
bot.hears(BTN.stop, onlyTeacher(stopTest));
bot.hears(BTN.fresh, onlyTeacher(askConfirm('Barcha savollar va o\'quvchilarning javoblari o\'chiriladi (ro\'yxatdagi ismlar qoladi). Yangi test boshlaysizmi?', 'fresh_yes', 'no')));
bot.hears(BTN.wipe, onlyTeacher(askConfirm('Ro\'yxatdagi barcha o\'quvchilar o\'chiriladi. Ishonchingiz komilmi?', 'wipe_yes', 'no')));
bot.command('royxat', onlyTeacher(listStudents));
bot.command('natijalar', onlyTeacher(sendResults));
bot.command('kod', onlyTeacher(showCode));

const teacherAction = (name, fn) => bot.action(name, async ctx => {
  if (!isTeacher(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await fn(ctx);
});
teacherAction('resend', async ctx => {
  if (!db.active) return ctx.reply('Test yopiq.');
  await ctx.reply('⏳ Yuborilmoqda...');
  ctx.reply(report(await broadcastCode()), { parse_mode: 'HTML' });
});
teacherAction('reopen', async ctx => {
  db.active = true; save();
  await ctx.reply('🟢 Test qayta ochildi. Yuborilmoqda...');
  ctx.reply(report(await broadcastCode()), { parse_mode: 'HTML' });
});
teacherAction('fresh_yes', ctx => {
  db.questions = { mcq: [], short: [] }; db.code = null; db.published = false; db.active = false;
  for (const s of Object.values(db.students)) { s.state = s.name ? 'registered' : 'registering'; s.idx = 0; s.answers = []; s.done = false; }
  save();
  ctx.editMessageText('🆕 Yangi test boshlandi. «📝 Savol qo\'shish» orqali savollarni kiriting.');
});
teacherAction('wipe_yes', ctx => { db.students = {}; save(); ctx.editMessageText('🗑 O\'quvchilar ro\'yxati tozalandi.'); });
teacherAction('no', ctx => ctx.editMessageText('Bekor qilindi.'));

bot.catch(err => console.error('Xato:', err));

// ================= Ishga tushirish =================
app.listen(PORT, () => console.log(`Mini ilova serveri: http://localhost:${PORT}`));
bot.launch(() => {
  console.log('Bot ishga tushdi');
  if (WEBAPP_URL.startsWith('https://')) {
    // O'qituvchilar chatida menyu tugmasi ham mini ilovani ochadi
    TEACHERS.forEach(id => bot.telegram.setChatMenuButton({
      chatId: id, menuButton: { type: 'web_app', text: '📝 Savollar', web_app: { url: WEBAPP_URL } }
    }).catch(e => console.error('Menyu tugmasi:', e.message)));
  }
}).catch(e => { console.error(e); process.exit(1); });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
