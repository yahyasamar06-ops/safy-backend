const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. صفحة للتأكد أن السيرفر خدام
app.get('/', (req, res) => {
  res.json({ status: 'Safy AI Backend is live!' });
});

// 2. تحليل التعليق بالكلمات المفتاحية + الذكاء الاصطناعي
app.post('/analyze', async (req, res) => {
  try {
    const { comment = '', threshold = 60, blockedWords = [] } = req.body;
    const text = String(comment).trim();
    if (!text) return res.status(400).json({ error: 'Comment is empty' });

    // فحص الكلمات الممنوعة أولاً (مجاني وسريع)
    const lower = text.toLowerCase();
    const matched = blockedWords.find((w) => lower.includes(w.toLowerCase()));
    if (matched) {
      return res.json({
        negative: true,
        score: 95,
        reason: `Blocked keyword: ${matched}`,
        action: 'delete'
      });
    }

    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'AI_API_KEY is missing in server settings' });
    }

    const prompt = `You are Safy, an AI comment moderator for business social accounts.
Analyze this comment (it may be in Moroccan Darija, Arabic, French, or English): "${text}"
Reply ONLY with valid JSON (no markdown) in this exact format:
{"negative": true or false, "score": 0 to 100, "reason": "short 3-5 word reason"}`;

    // تجربة الموديل الرئيسي، وإلا كان عامر يدوز للاحتياطي
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

    if (!data) {
      return res.status(502).json({ error: lastError });
    }

    const rawText = data.candidates[0].content.parts[0].text;
    const parsed = JSON.parse(rawText);

    const score = Number(parsed.score) || 0;
    const isNegative = Boolean(parsed.negative) && score >= Number(threshold);

    res.json({
      negative: isNegative,
      score,
      reason: parsed.reason || 'AI sentiment check',
      action: isNegative ? 'hide' : 'approve'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. نقطة استقبال تعليقات Instagram / Facebook مستقبلاً (Webhook)
app.get('/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === (process.env.META_VERIFY_TOKEN || 'safy_verify_123')) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Safy server running on port ${PORT}`));
