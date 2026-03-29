const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════
// STORAGE PERSISTENTE
// Token: lido primeiro das Secrets do Replit (META_TOKEN env var)
// Se nao existir, usa data.json
// Slides: lidos de SLIDE_URLS env var (4 URLs separadas por virgula)
// ═══════════════════════════════════════════════════════
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  let data = {
    token: '', tokenSavedAt: null, tokenExpiresAt: null,
    queue: [], published: [],
    heygenKey: '', heygenAvatarId: '', heygenVoiceId: '',
    slideUrls: [], postBank: []
  };
  // Tentar carregar do arquivo
  try {
    if (fs.existsSync(DATA_FILE)) {
      data = Object.assign(data, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    }
  } catch(e) {}
  
  // SEMPRE sobrescrever com env vars se existirem (persistem entre restarts)
  if (process.env.META_TOKEN) {
    data.token = process.env.META_TOKEN;
    data.tokenExpiresAt = data.tokenExpiresAt || (Date.now() + 60*24*60*60*1000);
  }
  if (process.env.HEYGEN_KEY) data.heygenKey = process.env.HEYGEN_KEY;
  if (process.env.HEYGEN_AVATAR_ID) data.heygenAvatarId = process.env.HEYGEN_AVATAR_ID;
  if (process.env.SLIDE_URLS) {
    data.slideUrls = process.env.SLIDE_URLS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return data;
}

function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch(e) {}
}

let DB = loadData();

// Salvar env vars automaticamente quando token/heygen for configurado
function persistirEnvVars() {
  // Escreve um .env local que eh lido no proximo restart
  try {
    let envContent = '';
    if (DB.token) envContent += 'META_TOKEN=' + DB.token + '\n';
    if (DB.heygenKey) envContent += 'HEYGEN_KEY=' + DB.heygenKey + '\n';
    if (DB.heygenAvatarId) envContent += 'HEYGEN_AVATAR_ID=' + DB.heygenAvatarId + '\n';
    if (DB.slideUrls && DB.slideUrls.length) envContent += 'SLIDE_URLS=' + DB.slideUrls.join(',') + '\n';
    fs.writeFileSync(path.join(__dirname, '.env.local'), envContent);
  } catch(e) {}
}

// Carregar .env.local se existir (persistencia entre restarts sem Secrets)
try {
  const envLocal = path.join(__dirname, '.env.local');
  if (fs.existsSync(envLocal)) {
    const lines = fs.readFileSync(envLocal, 'utf8').split('\n');
    lines.forEach(line => {
      const [k, ...v] = line.split('=');
      if (k && v.length && !process.env[k]) process.env[k] = v.join('=');
    });
    DB = loadData(); // Recarregar com as env vars do arquivo
  }
} catch(e) {}

// STATUS
app.get('/api/status', (req, res) => {
  const days = DB.tokenExpiresAt ? Math.max(0, Math.round((DB.tokenExpiresAt - Date.now()) / 86400000)) : 0;
  res.json({
    ok: true, version: 'v5',
    token: { hasToken: !!DB.token, expired: DB.tokenExpiresAt ? Date.now() > DB.tokenExpiresAt : true, daysLeft: days },
    queue: { pending: DB.queue.filter(i => i.status === 'pending').length, total: DB.queue.length },
    heygen: { configured: !!DB.heygenKey && !!DB.heygenAvatarId },
    slides: { count: (DB.slideUrls||[]).length },
    postBank: { total: (DB.postBank||[]).length, approved: (DB.postBank||[]).filter(p=>['approved','winner'].includes(p.status)).length },
    anthropic: { configured: !!process.env.ANTHROPIC_API_KEY },
    uptime: process.uptime()
  });
});

// PROXY ANTHROPIC
app.post('/api/ai', async (req, res) => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY||'', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: { message: e.message } }); }
});

// TOKEN META
app.post('/api/token/save', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, error: 'Token obrigatorio' });
  const now = Date.now();
  DB.token = token; DB.tokenSavedAt = now; DB.tokenExpiresAt = now + 60*24*60*60*1000;
  process.env.META_TOKEN = token; // salva na memoria do processo
  saveData(DB); persistirEnvVars();
  console.log('[TOKEN] Salvo e persistido. Expira em 60 dias.');
  res.json({ ok: true, daysLeft: 60, expiresAt: DB.tokenExpiresAt });
});

app.get('/api/token/status', (req, res) => {
  const now = Date.now();
  const daysLeft = DB.tokenExpiresAt ? Math.max(0, Math.round((DB.tokenExpiresAt - now) / 86400000)) : 0;
  res.json({ hasToken: !!DB.token, expired: DB.tokenExpiresAt ? now > DB.tokenExpiresAt : true, daysLeft, expiresAt: DB.tokenExpiresAt });
});

app.post('/api/token/renew', async (req, res) => {
  const token = req.body.token || DB.token;
  if (!token) return res.status(400).json({ ok: false, error: 'Sem token' });
  try {
    const appId = process.env.META_APP_ID||'', appSecret = process.env.META_APP_SECRET||'';
    const now = Date.now();
    if (!appId || !appSecret) {
      DB.token = token; DB.tokenSavedAt = now; DB.tokenExpiresAt = now + 60*24*60*60*1000;
      process.env.META_TOKEN = token;
      saveData(DB); persistirEnvVars();
      return res.json({ ok: true, token, daysLeft: 60, expiresAt: DB.tokenExpiresAt });
    }
    const r = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${token}`);
    const d = await r.json(); if (d.error) throw new Error(d.error.message);
    DB.token = d.access_token; DB.tokenSavedAt = now; DB.tokenExpiresAt = now + 60*24*60*60*1000;
    process.env.META_TOKEN = d.access_token;
    saveData(DB); persistirEnvVars();
    res.json({ ok: true, token: d.access_token, daysLeft: 60, expiresAt: DB.tokenExpiresAt });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// SLIDES — salvar URLs das imagens de template
app.post('/api/slides/save', (req, res) => {
  const { urls } = req.body;
  if (!urls || !urls.length) return res.status(400).json({ ok: false, error: 'URLs obrigatorias' });
  DB.slideUrls = urls.filter(u => u && u.startsWith('http'));
  process.env.SLIDE_URLS = DB.slideUrls.join(',');
  saveData(DB); persistirEnvVars();
  res.json({ ok: true, count: DB.slideUrls.length, urls: DB.slideUrls });
});

app.get('/api/slides', (req, res) => {
  res.json({ urls: DB.slideUrls || [], count: (DB.slideUrls||[]).length });
});

// POST BANK — salvar banco de posts no servidor
app.post('/api/bank/sync', (req, res) => {
  const { posts } = req.body;
  if (!posts) return res.status(400).json({ ok: false });
  DB.postBank = posts;
  saveData(DB);
  res.json({ ok: true, total: posts.length, approved: posts.filter(p=>['approved','winner'].includes(p.status)).length });
});

app.get('/api/bank', (req, res) => {
  res.json({ posts: DB.postBank || [], total: (DB.postBank||[]).length });
});

// FILA
app.get('/api/queue', (req, res) => res.json({ queue: DB.queue, published: DB.published.slice(-50) }));

app.post('/api/queue/add', (req, res) => {
  const { post, scheduledAt, type } = req.body;
  if (!post) return res.status(400).json({ ok: false });
  const item = { id: 'q-'+Date.now()+'-'+Math.random().toString(36).substr(2,4), post, type: type||'carousel', scheduledAt: scheduledAt||Date.now(), status: 'pending', createdAt: Date.now() };
  DB.queue.push(item); saveData(DB);
  res.json({ ok: true, item });
});

app.delete('/api/queue/:id', (req, res) => {
  DB.queue = DB.queue.filter(i => i.id !== req.params.id);
  saveData(DB); res.json({ ok: true });
});

app.post('/api/queue/clear', (req, res) => {
  DB.queue = DB.queue.filter(i => i.status === 'pending');
  saveData(DB); res.json({ ok: true });
});

app.post('/api/publish/now', async (req, res) => {
  const { caption, imageUrls, videoUrl } = req.body;
  if (!DB.token) return res.status(400).json({ ok: false, error: 'Token nao configurado. Va em Conectar Meta.' });
  // Se nao passou imageUrls, usar slides de template
  const urls = imageUrls && imageUrls.length ? imageUrls : (DB.slideUrls||[]);
  if (!urls.length && !videoUrl) return res.status(400).json({ ok: false, error: 'Sem imagens. Configure as URLs dos slides em Configuracoes.' });
  try {
    const postId = await publishToInstagram({ caption, imageUrls: urls, videoUrl });
    DB.published.push({ postId, caption: (caption||'').substring(0,80), type: videoUrl?'video':'carousel', publishedAt: Date.now() });
    saveData(DB); res.json({ ok: true, postId });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// HEYGEN
app.post('/api/heygen/config', (req, res) => {
  const { apiKey, avatarId, voiceId } = req.body;
  if (apiKey) { DB.heygenKey = apiKey; process.env.HEYGEN_KEY = apiKey; }
  if (avatarId) { DB.heygenAvatarId = avatarId; process.env.HEYGEN_AVATAR_ID = avatarId; }
  if (voiceId) DB.heygenVoiceId = voiceId;
  saveData(DB); persistirEnvVars();
  res.json({ ok: true });
});

app.get('/api/heygen/config', (req, res) => {
  res.json({ hasKey: !!DB.heygenKey, avatarId: DB.heygenAvatarId, voiceId: DB.heygenVoiceId });
});

app.post('/api/heygen/generate', async (req, res) => {
  const { script, avatarId, voiceId } = req.body;
  if (!DB.heygenKey) return res.status(400).json({ ok: false, error: 'HeyGen API Key nao configurada' });
  if (!script) return res.status(400).json({ ok: false, error: 'Script obrigatorio' });
  try {
    const r = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': DB.heygenKey },
      body: JSON.stringify({
        video_inputs: [{ character: { type: 'avatar', avatar_id: avatarId||DB.heygenAvatarId, avatar_style: 'normal' }, voice: { type: 'text', input_text: script, voice_id: voiceId||DB.heygenVoiceId||'pt-BR-FranciscaNeural' } }],
        dimension: { width: 1080, height: 1920 }
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message||JSON.stringify(d.error));
    if (!d.data||!d.data.video_id) throw new Error('HeyGen nao retornou video_id');
    res.json({ ok: true, videoId: d.data.video_id });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/heygen/status/:videoId', async (req, res) => {
  if (!DB.heygenKey) return res.status(400).json({ ok: false });
  try {
    const r = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${req.params.videoId}`, { headers: { 'X-Api-Key': DB.heygenKey } });
    const d = await r.json();
    res.json({ ok: true, status: d.data&&d.data.status, videoUrl: d.data&&d.data.video_url });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// AGENDA ALTERNADA
app.post('/api/schedule/alternated', (req, res) => {
  const { posts, startDate, daysInterval, publishHour } = req.body;
  const interval = daysInterval||1, hour = publishHour||8;
  if (!posts||!posts.length) return res.status(400).json({ ok: false, error: 'Posts obrigatorios' });
  // Limpar fila pendente anterior
  DB.queue = DB.queue.filter(i => i.status !== 'pending');
  const queue = [];
  let d = new Date(startDate||Date.now()); d.setHours(hour,0,0,0);
  if (d <= new Date()) d.setDate(d.getDate()+1);
  posts.forEach((post, i) => {
    // Para posts sem slides, usar templates do servidor
    if (!post.slides || !post.slides.filter(s=>s&&s.startsWith('http')).length) {
      post.slides = DB.slideUrls || [];
    }
    const item = { id: 'sch-'+Date.now()+'-'+i, post, type: i%2===0?'carousel':'video', scheduledAt: d.getTime(), status: 'pending', createdAt: Date.now() };
    queue.push(item); DB.queue.push(item);
    d = new Date(d); d.setDate(d.getDate()+interval);
  });
  saveData(DB);
  console.log(`[AGENDA] ${queue.length} posts agendados. Proximo: ${new Date(queue[0]&&queue[0].scheduledAt).toLocaleString('pt-BR')}`);
  res.json({ ok: true, scheduled: queue.length, queue });
});

// AUTO-GERAR E AGENDAR — gera posts com IA e agenda automaticamente
app.post('/api/auto/generate-and-schedule', async (req, res) => {
  const { quantity, topics, publishHour, daysInterval } = req.body;
  const qty = quantity || 10;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ ok: false, error: 'Anthropic API Key nao configurada' });
  if (!DB.token) return res.status(400).json({ ok: false, error: 'Token Meta nao configurado' });
  
  try {
    // Gerar posts via Claude
    const prompt = `Tom Knauf tributarista brasileiro, 26 anos de experiencia. Gere ${qty} posts completos para Instagram sobre tributacao para empresarios.

Topicos: ${(topics||['Planejamento tributario','Simples Nacional','Fator R','Reforma Tributaria 2026','Reducao legal de impostos']).join(', ')}

Cada post: gancho forte, educativo/autoritario, CTA para WhatsApp.

JSON sem markdown: [{"title":"...","pillar":"auto|alert|edu|reforma|mentor","caption":"legenda completa com hashtags"}]`;
    
    const aiR = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
    });
    const aiD = await aiR.json();
    const posts = JSON.parse(aiD.content[0].text.replace(/```json|```/g, '').trim());
    
    // Adicionar slides de template em todos os posts
    const postsComSlides = posts.map((p, i) => ({
      ...p, id: 'auto-'+Date.now()+'-'+i,
      slides: DB.slideUrls || [],
      status: 'approved', score: 8, createdAt: Date.now()
    }));
    
    // Salvar no banco
    DB.postBank = [...(DB.postBank||[]), ...postsComSlides];
    
    // Agendar alternado
    DB.queue = DB.queue.filter(i => i.status !== 'pending');
    let d = new Date(); d.setHours(publishHour||8, 0, 0, 0);
    if (d <= new Date()) d.setDate(d.getDate()+1);
    const interval = daysInterval || 1;
    
    postsComSlides.forEach((post, i) => {
      DB.queue.push({ id: 'sch-'+Date.now()+'-'+i, post, type: i%2===0?'carousel':'video', scheduledAt: d.getTime(), status: 'pending', createdAt: Date.now() });
      d = new Date(d); d.setDate(d.getDate()+interval);
    });
    
    saveData(DB);
    const proximo = DB.queue[0] ? new Date(DB.queue[0].scheduledAt).toLocaleString('pt-BR') : 'N/A';
    console.log(`[AUTO] ${postsComSlides.length} posts gerados e agendados. Proximo: ${proximo}`);
    res.json({ ok: true, generated: postsComSlides.length, scheduled: postsComSlides.length, nextPost: proximo });
  } catch(e) {
    console.error('[AUTO] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// CRON: processa fila a cada 1 minuto
setInterval(async () => {
  const now = Date.now();
  const pending = DB.queue.filter(i => i.status === 'pending' && i.scheduledAt <= now);
  if (!pending.length) return;
  console.log(`[CRON] ${pending.length} posts para publicar`);
  
  for (const item of pending) {
    item.status = 'processing'; saveData(DB);
    try {
      const post = item.post;
      const caption = post.caption||'';
      // Slides: usar do post ou templates do servidor
      const slides = (post.slides||[]).filter(s=>s&&s.startsWith('http'));
      const imageUrls = slides.length ? slides : (DB.slideUrls||[]);
      
      if (item.type === 'video' && post.videoUrl) {
        await publishToInstagram({ caption, videoUrl: post.videoUrl });
        item.status = 'published'; item.publishedAt = Date.now();
        console.log(`[CRON] VIDEO publicado: ${item.id}`);
      } else if (item.type === 'video' && DB.heygenKey && DB.heygenAvatarId) {
        // Gerar video via HeyGen automaticamente
        console.log(`[CRON] Gerando video HeyGen para: ${post.title||'post'}`);
        const scriptR = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: [{ role: 'user', content: 'Script de video 60s falado para camera, tom Tom Knauf tributarista:\n\n'+caption.substring(0,400)+'\n\nRetorne SOMENTE o script, 120-150 palavras, gancho inicial forte, CTA WhatsApp no final.' }] })
        });
        const scriptD = await scriptR.json();
        const script = scriptD.content[0].text;
        
        const genR = await fetch('https://api.heygen.com/v2/video/generate', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': DB.heygenKey },
          body: JSON.stringify({ video_inputs: [{ character: { type: 'avatar', avatar_id: DB.heygenAvatarId, avatar_style: 'normal' }, voice: { type: 'text', input_text: script, voice_id: DB.heygenVoiceId||'pt-BR-FranciscaNeural' } }], dimension: { width: 1080, height: 1920 } })
        });
        const genD = await genR.json();
        if (!genD.data||!genD.data.video_id) throw new Error('HeyGen sem video_id');
        
        // Polling do status
        let status = 'processing', attempts = 0;
        while (status !== 'completed' && status !== 'failed' && attempts < 60) {
          await sleep(10000);
          const stR = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${genD.data.video_id}`, { headers: { 'X-Api-Key': DB.heygenKey } });
          const stD = await stR.json();
          status = stD.data&&stD.data.status||'processing';
          if (status === 'completed' && stD.data.video_url) {
            await publishToInstagram({ caption, videoUrl: stD.data.video_url });
            item.status = 'published'; item.publishedAt = Date.now();
            console.log(`[CRON] VIDEO HeyGen publicado: ${item.id}`);
          }
          attempts++;
        }
        if (item.status !== 'published') throw new Error('HeyGen timeout ou falha');
      } else if (imageUrls.length >= 1) {
        await publishToInstagram({ caption, imageUrls });
        item.status = 'published'; item.publishedAt = Date.now();
        console.log(`[CRON] CARROSSEL publicado: ${item.id}`);
      } else {
        throw new Error('Sem slides configurados. Va em Configuracoes e salve as URLs das imagens.');
      }
      DB.published.push({ postId: item.id, title: (item.post.title||'').substring(0,60), type: item.type, publishedAt: Date.now() });
    } catch(e) {
      item.status = 'error'; item.error = e.message;
      console.error(`[CRON] ERRO ${item.id}:`, e.message);
    }
    saveData(DB);
  }
}, 60*1000);

// CRON: alerta token 1x/dia
setInterval(() => {
  if (!DB.tokenExpiresAt) return;
  const days = Math.round((DB.tokenExpiresAt - Date.now()) / 86400000);
  if (days <= 7) console.warn(`[TOKEN] ATENCAO: expira em ${days} dias!`);
}, 24*60*60*1000);

// PUBLISH HELPER
async function publishToInstagram({ caption, imageUrls, videoUrl }) {
  const token = DB.token; if (!token) throw new Error('Token nao configurado');
  const meR = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=instagram_business_account&access_token=${token}`);
  const meD = await meR.json(); if (meD.error) throw new Error(meD.error.message);
  const page = (meD.data||[]).find(p => p.instagram_business_account);
  if (!page) throw new Error('Instagram Business nao encontrado');
  const igId = page.instagram_business_account.id;
  let mediaId;
  if (videoUrl) {
    const r = await fetch(`https://graph.facebook.com/v19.0/${igId}/media`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ media_type:'REELS', video_url:videoUrl, caption:caption||'', access_token:token }) });
    const d = await r.json(); if (d.error) throw new Error(d.error.message);
    let status='IN_PROGRESS', attempts=0;
    while (status==='IN_PROGRESS' && attempts<30) { await sleep(5000); const sr=await fetch(`https://graph.facebook.com/v19.0/${d.id}?fields=status_code&access_token=${token}`); const sd=await sr.json(); status=sd.status_code||'IN_PROGRESS'; attempts++; }
    if (status!=='FINISHED') throw new Error('Video nao processado: '+status);
    mediaId = d.id;
  } else if (imageUrls.length > 1) {
    const ids=[];
    for (const url of imageUrls) { const r=await fetch(`https://graph.facebook.com/v19.0/${igId}/media`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({image_url:url,is_carousel_item:'true',access_token:token})}); const d=await r.json(); if(d.error)throw new Error(d.error.message); ids.push(d.id); await sleep(500); }
    const cr=await fetch(`https://graph.facebook.com/v19.0/${igId}/media`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({media_type:'CAROUSEL',children:ids.join(','),caption:caption||'',access_token:token})});
    const cd=await cr.json(); if(cd.error)throw new Error(cd.error.message); mediaId=cd.id;
  } else {
    const r=await fetch(`https://graph.facebook.com/v19.0/${igId}/media`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({image_url:imageUrls[0],caption:caption||'',access_token:token})});
    const d=await r.json(); if(d.error)throw new Error(d.error.message); mediaId=d.id;
  }
  await sleep(1500);
  const pr=await fetch(`https://graph.facebook.com/v19.0/${igId}/media_publish`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({creation_id:mediaId,access_token:token})});
  const pd=await pr.json(); if(pd.error)throw new Error(pd.error.message);
  return pd.id;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// WEBHOOK
app.get('/webhook', (req, res) => { if (req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===(process.env.WEBHOOK_VERIFY_TOKEN||'tomknauf2025')) { res.status(200).send(req.query['hub.challenge']); } else res.sendStatus(403); });
app.post('/webhook', (req, res) => { res.sendStatus(200); });

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT||3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('=== Tom Knauf Content Machine v5 ===');
  console.log('Porta:', PORT);
  console.log('[TOKEN]', DB.token ? `Ativo, ${Math.round((DB.tokenExpiresAt-Date.now())/86400000)} dias restantes` : 'NAO CONFIGURADO - conecte o Meta');
  console.log('[SLIDES]', DB.slideUrls&&DB.slideUrls.length ? DB.slideUrls.length+' URLs configuradas' : 'NAO CONFIGURADO - adicione URLs em /api/slides/save');
  console.log('[HEYGEN]', DB.heygenKey ? 'Configurado' : 'Nao configurado');
  console.log('[BANCO]', (DB.postBank||[]).length, 'posts salvos no servidor');
  console.log('[FILA]', DB.queue.filter(i=>i.status==='pending').length, 'posts pendentes');
  console.log('[CRON] Processador ativo - verifica a cada 1 minuto');
});
