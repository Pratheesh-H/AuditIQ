export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Engine chain ──────────────────────────────────────────────
  // 1st: Groq         (llama-3.3-70b-versatile)   — primary
  // 2nd: Cerebras     (llama-3.3-70b)              — fallback if Groq quota/fails
  // Triggered on: 429 (quota), 401 (expired key), 403 (forbidden), network error
  // ─────────────────────────────────────────────────────────────
  const ENGINES = [
    {
      label: 'Groq',
      key:   process.env.GROQ_API_KEY,
      url:   'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.3-70b-versatile',
    },
    {
      label: 'Cerebras',
      key:   process.env.CEREBRAS_API_KEY,
      url:   'https://api.cerebras.ai/v1/chat/completions',
      model: 'llama-3.3-70b',
    },
  ];

  // Filter out engines with no key configured
  const available = ENGINES.filter(e => e.key);

  if (available.length === 0) {
    return res.status(500).json({
      error: 'No API keys configured. Set GROQ_API_KEY and/or CEREBRAS_API_KEY in Vercel environment variables.'
    });
  }

  let lastError = null;

  for (let i = 0; i < available.length; i++) {
    const engine = available[i];
    try {
      // Override model with this engine's model, keep everything else
      const body = { ...req.body, model: engine.model };

      const r = await fetch(engine.url, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${engine.key}`,
        },
        body: JSON.stringify(body),
      });

      // On quota/auth errors try next engine if one exists
      if ((r.status === 429 || r.status === 401 || r.status === 403) && i < available.length - 1) {
        lastError = `${engine.label} returned ${r.status} — switching to ${available[i + 1].label}`;
        console.warn(lastError);
        continue;
      }

      const data = await r.json();
      // Tag which engine handled this (visible in browser network tab for debugging)
      if (r.ok) data._engine = engine.label;
      return res.status(r.ok ? 200 : r.status).json(data);

    } catch (e) {
      lastError = `${engine.label} network error: ${e.message}`;
      console.warn(lastError);
      if (i < available.length - 1) continue;
    }
  }

  return res.status(500).json({ error: lastError || 'All AI engines failed' });
}
