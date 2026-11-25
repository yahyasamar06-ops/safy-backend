const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// دالة مساعدة لتحليل التعليق بالذكاء الاصطناعي
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
  res.json({ status: 'Safy AI Backend is live!' });
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

// التحقق من Webhook ديال Meta
app.get('/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === (process.env.META_VERIFY_TOKEN || 'safy_verify_123')) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// استقبال تعليقات Instagram الحقيقية وإخفاء السلبي منها أوتوماتيكياً
app.post('/webhook/meta', async (req, res) => {
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field === 'comments' && change.value?.text) {
          const commentId = change.value.id;
          const text = change.value.text;
          console.log('New IG comment:', commentId, text);

          const result = await analyzeWithAI(text, 60, ['scam', 'khayb', 'zbel', 'nassab']);
          console.log('AI decision:', result);

          if (result.negative && process.env.META_PAGE_TOKEN) {
            await fetch(
              `https://graph.facebook.com/v21.0/${commentId}?hide=true&access_token=${process.env.META_PAGE_TOKEN}`,
              { method: 'POST' }
            );
            console.log('Comment hidden on Instagram:', commentId);
          }
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(200).send('EVENT_RECEIVED');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Safy server running on port ${PORT}`));
