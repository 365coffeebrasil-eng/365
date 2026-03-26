const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── STORAGE
const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
  return { token:'', tokenSavedAt:null, tokenExpiresAt:null, queue:[], published:[], heygenKey:'', heygenAvatarId:'', heygenVoiceId:'' };
}
function saveData(d) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch(e) {} }
let DB = loadData();

// ── PROXY ANTHROPIC
app.post('/api/ai', async (req, res) => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY||'', 'anthropic-version':'2023-06-01' },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error:{ message: e.message } }); }
});

// ── TOKEN META
app.post('/api/token/save', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok:false, error:'Token obrigatorio' });
  const now = Date.now();
  DB.token = token; DB.tokenSavedAt = now; DB.tokenExpiresAt = now + 60*24*60*60*1000;
  saveData(DB);
  console.log('[TOKEN] Salvo. Expira em 60 dias.');
  res.json({ ok:true, expiresAt: DB.tokenExpiresAt });
});

app.get('/api/token/status', (req, res) => {
  const now = Date.now();
  const daysLeft = DB.tokenExpiresAt ? Math.max(0, Math.round((DB.tokenExpiresAt - now) / 86400000)) : 0;
  res.json({ hasToken:!!DB.token, expired: DB.tokenExpiresAt ? now > DB.tokenExpiresAt : true, daysLeft, expiresAt: DB.tokenExpiresAt });
});

app.post('/api/token/renew', async (req, res) => {
  const token = req.body.token || DB.token;
  if (!token) return res.status(400).json({ ok:false, error:'Sem token' });
  try {
    const appId = process.env.META_APP_ID||'';
    const appSecret = process.env.META_APP_SECRET||'';
    if (!appId || !appSecret) {
      const now = Date.now();
      DB.token = token; DB.tokenSavedAt = now; DB.tokenExpiresAt = now + 60*24*60*60*1000;
      saveData(DB);
      return res.json({ ok:true, token, expiresAt: DB.tokenExpiresAt, note:'Renovado localmente' });
    }
    const url = `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${token}`;
    const r = await fetch(url); const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    const now = Date.now();
    DB.token = d.access_token; DB.tokenSavedAt = now; DB.tokenExpiresAt = now + 60*24*60*60*1000;
    saveData(DB);
    res.json({ ok:true, token: d.access_token, expiresAt: DB.tokenExpiresAt });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

// ── FILA DE PUBLICACAO
app.get('/api/queue', (req, res) => {
  res.json({ queue: DB.queue, published: DB.published.slice(-50) });
});

app.post('/api/queue/add', (req, res) => {
  const { post, scheduledAt, type } = req.body;
  if (!post) return res.status(400).json({ ok:false, error:'Post obrigatorio' });
  const item = { id:'q-'+Date.now()+'-'+Math.random().toString(36).substr(2,4), post, type:type||'carousel', scheduledAt:scheduledAt||Date.now(), status:'pending', createdAt:Date.now() };
  DB.queue.push(item); saveData(DB);
  res.json({ ok:true, item });
});

app.delete('/api/queue/:id', (req, res) => {
  DB.queue = DB.queue.filter(i => i.id !== req.params.id);
  saveData(DB); res.json({ ok:true });
});

app.post('/api/publish/now', async (req, res) => {
  const { caption, imageUrls, videoUrl } = req.body;
  if (!DB.token) return res.status(400).json({ ok:false, error:'Token nao configurado' });
  try {
    const postId = await publishToInstagram({ caption, imageUrls, videoUrl });
    DB.published.push({ postId, caption:(caption||'').substring(0,80), type:videoUrl?'video':'carousel', publishedAt:Date.now() });
    saveData(DB);
    res.json({ ok:true, postId });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

// ── HEYGEN
app.post('/api/heygen/config', (req, res) => {
  const { apiKey, avatarId, voiceId } = req.body;
  if (apiKey) DB.heygenKey = apiKey;
  if (avatarId) DB.heygenAvatarId = avatarId;
  if (voiceId) DB.heygenVoiceId = voiceId;
  saveData(DB); res.json({ ok:true });
});

app.get('/api/heygen/config', (req, res) => {
  res.json({ hasKey:!!DB.heygenKey, avatarId:DB.heygenAvatarId, voiceId:DB.heygenVoiceId });
});

app.post('/api/heygen/generate', async (req, res) => {
  const { script, avatarId, voiceId } = req.body;
  if (!DB.heygenKey) return res.status(400).json({ ok:false, error:'HeyGen API Key nao configurada' });
  if (!script) return res.status(400).json({ ok:false, error:'Script obrigatorio' });
  try {
    const r = await fetch('https://api.heygen.com/v2/video/generate', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-Api-Key': DB.heygenKey },
      body: JSON.stringify({
        video_inputs:[{ character:{ type:'avatar', avatar_id: avatarId||DB.heygenAvatarId, avatar_style:'normal' }, voice:{ type:'text', input_text: script, voice_id: voiceId||DB.heygenVoiceId||'pt-BR-FranciscaNeural' } }],
        dimension:{ width:1080, height:1920 }
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message||JSON.stringify(d.error));
    if (!d.data||!d.data.video_id) throw new Error('HeyGen nao retornou video_id');
    res.json({ ok:true, videoId: d.data.video_id });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.get('/api/heygen/status/:videoId', async (req, res) => {
  if (!DB.heygenKey) return res.status(400).json({ ok:false, error:'Sem key' });
  try {
    const r = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${req.params.videoId}`, { headers:{ 'X-Api-Key': DB.heygenKey } });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ ok:true, status: d.data&&d.data.status, videoUrl: d.data&&d.data.video_url });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

// ── AGENDA ALTERNADA: dia par=carrossel, dia impar=video
app.post('/api/schedule/alternated', (req, res) => {
  const { posts, startDate, daysInterval, publishHour } = req.body;
  const interval = daysInterval||1, hour = publishHour||8;
  if (!posts||!posts.length) return res.status(400).json({ ok:false, error:'Posts obrigatorios' });
  const queue = [];
  let d = new Date(startDate||Date.now());
  d.setHours(hour,0,0,0);
  if (d <= new Date()) d.setDate(d.getDate()+1);
  posts.forEach((post, i) => {
    const item = { id:'sch-'+Date.now()+'-'+i, post, type: i%2===0?'carousel':'video', scheduledAt: d.getTime(), status:'pending', createdAt:Date.now() };
    queue.push(item); DB.queue.push(item);
    d = new Date(d); d.setDate(d.getDate()+interval);
  });
  saveData(DB);
  res.json({ ok:true, scheduled:queue.length, queue });
});

// ── CRON: processa fila a cada 1 minuto
setInterval(async () => {
  const now = Date.now();
  const pending = DB.queue.filter(i => i.status==='pending' && i.scheduledAt<=now);
  if (!pending.length) return;
  for (const item of pending) {
    console.log(`[CRON] Processando: ${item.id} (${item.type})`);
    item.status = 'processing'; saveData(DB);
    try {
      const post = item.post;
      const caption = post.caption||'';
      const imageUrls = (post.slides||[]).filter(s => s&&s.startsWith('http'));
      if (item.type==='video' && post.videoUrl) {
        await publishToInstagram({ caption, videoUrl: post.videoUrl });
      } else if (imageUrls.length>=1) {
        await publishToInstagram({ caption, imageUrls });
      } else throw new Error('Sem slides/video');
      item.status = 'published'; item.publishedAt = Date.now();
      DB.published.push({ postId:item.id, caption:caption.substring(0,80), type:item.type, publishedAt:Date.now() });
      console.log(`[CRON] Publicado: ${item.id}`);
    } catch(e) {
      item.status = 'error'; item.error = e.message;
      console.error(`[CRON] Erro ${item.id}:`, e.message);
    }
    saveData(DB);
  }
}, 60*1000);

// CRON: alerta token (1x/dia)
setInterval(() => {
  if (!DB.tokenExpiresAt) return;
  const days = Math.round((DB.tokenExpiresAt - Date.now()) / 86400000);
  if (days<=7) console.warn(`[TOKEN] ATENCAO: expira em ${days} dias!`);
}, 24*60*60*1000);

// ── PUBLISH HELPER
async function publishToInstagram({ caption, imageUrls, videoUrl }) {
  const token = DB.token;
  if (!token) throw new Error('Token nao configurado');
  const meR = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=instagram_business_account&access_token=${token}`);
  const meD = await meR.json();
  if (meD.error) throw new Error(meD.error.message);
  const page = (meD.data||[]).find(p => p.instagram_business_account);
  if (!page) throw new Error('Instagram Business nao encontrado');
  const igId = page.instagram_business_account.id;
  let mediaId;
  if (videoUrl) {
    const r = await fetch(`https://graph.facebook.com/v19.0/${igId}/media`, {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ media_type:'REELS', video_url:videoUrl, caption:caption||'', access_token:token })
    });
    const d = await r.json(); if (d.error) throw new Error(d.error.message);
    let status='IN_PROGRESS', attempts=0;
    while (status==='IN_PROGRESS' && attempts<30) {
      await sleep(5000);
      const sr = await fetch(`https://graph.facebook.com/v19.0/${d.id}?fields=status_code&access_token=${token}`);
      const sd = await sr.json(); status = sd.status_code||'IN_PROGRESS'; attempts++;
    }
    if (status!=='FINISHED') throw new Error(`Video nao processado: ${status}`);
    mediaId = d.id;
  } else if (imageUrls.length>1) {
    const ids=[];
    for (const url of imageUrls) {
      const r = await fetch(`https://graph.facebook.com/v19.0/${igId}/media`, {
        method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body: new URLSearchParams({ image_url:url, is_carousel_item:'true', access_token:token })
      });
      const d = await r.json(); if (d.error) throw new Error(d.error.message);
      ids.push(d.id); await sleep(500);
    }
    const cr = await fetch(`https://graph.facebook.com/v19.0/${igId}/media`, {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ media_type:'CAROUSEL', children:ids.join(','), caption:caption||'', access_token:token })
    });
    const cd = await cr.json(); if (cd.error) throw new Error(cd.error.message);
    mediaId = cd.id;
  } else {
    const r = await fetch(`https://graph.facebook.com/v19.0/${igId}/media`, {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ image_url:imageUrls[0], caption:caption||'', access_token:token })
    });
    const d = await r.json(); if (d.error) throw new Error(d.error.message);
    mediaId = d.id;
  }
  await sleep(1500);
  const pr = await fetch(`https://graph.facebook.com/v19.0/${igId}/media_publish`, {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ creation_id:mediaId, access_token:token })
  });
  const pd = await pr.json(); if (pd.error) throw new Error(pd.error.message);
  return pd.id;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── WEBHOOK
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode']==='subscribe' && req.query['hub.verify_token']===(process.env.WEBHOOK_VERIFY_TOKEN||'tomknauf2025')) {
    res.status(200).send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});
app.post('/webhook', (req, res) => { res.sendStatus(200); });

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT||3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Tom Knauf Content Machine v5 porta ' + PORT);
  console.log('[CRON] Fila ativa (1 min)');
  const days = DB.tokenExpiresAt ? Math.round((DB.tokenExpiresAt-Date.now())/86400000) : 0;
  console.log('[TOKEN]', DB.token ? `Ativo, ${days} dias` : 'Nao configurado');
});
