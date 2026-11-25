const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const REDIRECT_URI = 'https://safy-backend-phi.vercel.app/auth/meta/callback';
let connectedPageToken = process.env.META_PAGE_TOKEN || '';

async function analyzeWithAI(text, threshold = 60, blockedWords = []) {
  const lower = text.toLowerCase();
  const matched = blockedWords.find((w) => lower.includes(w.toLowerCase()));
  if (matched) {
    return { negative: true, score: 95, reason: `Blocked keyword: ${matched}`, action: 'delete' };
  }

  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error('AI_API_KEY is missing');

  const prompt = `You are Safy, an AI comment moderator for business social accounts.
Analyze this comment (it may be in Moroccan Darija, Arabic, French, or English): "${text}"
Reply ONLY with valid JSON (no markdown) in this exact format:
{"negative": true or false, "score": 0 to 100, "reason": "short 3-5 word reason"}`;

  const models = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];
  let data = null;
  let lastError = 'AI API failed';

  for (const model of models) {
    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );
    const json = await aiRes.json();
    if (aiRes.ok && json?.candidates?.[0]?.content?.parts?.[0]?.text) {
      data = json;
      break;
    }
    lastError = json?.error?.message || lastError;
  }

  if (!data) throw new Error(lastError);

  const parsed = JSON.parse(data.candidates[0].content.parts[0].text);
  const score = Number(parsed.score) || 0;
  const isNegative = Boolean(parsed.negative) && score >= Number(threshold);

  return {
    negative: isNegative,
    score,
    reason: parsed.reason || 'AI sentiment check',
    action: isNegative ? 'hide' : 'approve'
  };
}

app.get('/', (req, res) => {
  res.json({ status: 'Safy AI Backend is live!', oauthReady: Boolean(process.env.META_APP_ID) });
});

app.get('/auth/meta', (req, res) => {
  const appId = process.env.META_APP_ID;
  if (!appId) return res.status(500).send('META_APP_ID is missing in Vercel');
  const scope = 'pages_show_list,pages_read_engagement,pages_manage_engagement';
  const authUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&response_type=code`;
  res.redirect(authUrl);
});

app.get('/auth/meta/callback', async (req, res) => {
  try {
    const { code, error_description } = req.query;
    if (error_description) return res.status(400).send(`Connection canceled: ${error_description}`);
    if (!code) return res.status(400).send('Missing authorization code');

    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_secret=${process.env.META_APP_SECRET}&code=${code}`
    ).then((r) => r.json());

    if (!tokenRes.access_token) {
      return res.status(400).send(`Meta token error: ${tokenRes?.error?.message || 'Unknown error'}`);
    }

    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token&access_token=${tokenRes.access_token}`
    ).then((r) => r.json());

    const page = (pagesRes.data || [])[0];
    if (page?.access_token) connectedPageToken = page.access_token;

    const accountName = page?.name || 'Your Meta Page';

    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Safy Connected</title>
<style>body{font-family:system-ui,sans-serif;background:#0B1528;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}.card{background:#142644;border:1px solid #264170;padding:32px;border-radius:20px;max-width:420px}h1{color:#10B981;font-size:22px;margin:0 0 10px}p{color:#cbd5e1;font-size:14px;line-height:1.5}</style>
</head><body><div class="card">
<h1>✓ Connected to Safy AI</h1>
<p>Account <strong>${accountName}</strong> is now connected. Safy AI protection is active for incoming comments!</p>
</div></body></html>`);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.post('/analyze', async (req, res) => {
  try {
    const { comment = '', threshold = 60, blockedWords = [] } = req.body;
    const text = String(comment).trim();
    if (!text) return res.status(400).json({ error: 'Comment is empty' });
    const result = await analyzeWithAI(text, threshold, blockedWords);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === (process.env.META_VERIFY_TOKEN || 'safy_verify_123')) {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).end(String(challenge));
  }
  return res.sendStatus(403);
});

app.post('/webhook/meta', async (req, res) => {
  try {
    const token = connectedPageToken || process.env.META_PAGE_TOKEN;
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const commentId = change.value?.comment_id || change.value?.id;
        const text = change.value?.message || change.value?.text;
        if (commentId && text) {
          const result = await analyzeWithAI(text, 60, ['scam', 'khayb', 'zbel', 'nassab']);
          if (result.negative && token) {
            await fetch(
              `https://graph.facebook.com/v21.0/${commentId}?is_hidden=true&access_token=${token}`,
              { method: 'POST' }
            );
          }
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    res.status(200).send('EVENT_RECEIVED');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Safy server running on port ${PORT}`));
