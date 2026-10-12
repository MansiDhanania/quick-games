// Zero-dependency server. Keeps the API key on the backend and never exposes it to games.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
try { // tiny .env loader
  for (const l of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const KEY = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;
const BASE = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const MODEL = process.env.LLM_MODEL || 'llama-3.3-70b-versatile';
const PORT = process.env.PORT || 3000;

const SYSTEM = `You are an expert indie game developer. Turn the user's idea into ONE complete, polished, playable mini-game as a single self-contained HTML document.
Rules:
- Output ONLY the HTML, starting with <!DOCTYPE html>. No markdown, no explanation.
- Inline all CSS and JS. No external files, CDNs, fonts, images, or network calls. Draw everything with canvas shapes and emoji (ctx.fillText) -- emoji make great sprites.
- One <canvas> with a fixed logical size (e.g. 800x500) scaled via CSS to fit the window (max-width:100vw; max-height:100vh), centered on a dark background.
- Use requestAnimationFrame with delta time. Keep all state in plain variables; structure the code clearly (state, update, draw).
- Controls: keyboard (arrows/WASD/Space) AND mouse/touch (pointer events) so it works on phones. Call preventDefault on game keys. Mouse-drag-to-aim is great for golf/slingshot style games.
- Start on a title screen with a one-line goal and the controls; click/any key starts. Include score, a clear win/lose condition, escalating difficulty, a game-over screen, and instant restart (R / click).
- Make it FUNNY and juicy: personality in the text, screen shake, particles, simple synthesized sounds via WebAudio (created only after the first user input, wrapped in try/catch).
- Keep the WHOLE file compact: under ~300 lines, no comments, short names. A small game that works beats a big one that gets cut off.
- Real game feel: simple but correct physics/collisions, forgiving hitboxes, 30-60 seconds per round. It must run without errors on first load. Prefer simple, robust code over ambitious code.`;

const hits = new Map(); // naive per-IP rate limit: 10 requests/min
const limited = ip => {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a); return a.length > 10;
};

function extractHtml(t) {
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:html)?/gi, '');
  const s = t.search(/<!doctype html|<html/i), e = t.toLowerCase().lastIndexOf('</html>');
  if (s < 0) throw new Error('the model did not return an HTML document');
  return e > s ? t.slice(s, e + 7) : t.slice(s); // never "repair" truncation silently; validate() catches it
}

// Returns '' if the game looks runnable, else a short reason.
function validate(html, finish) {
  if (finish === 'length') return 'the output was cut off (too long)';
  if (!/<\/html>\s*$/i.test(html.trim())) return 'the HTML was incomplete';
  if ((html.match(/<script\b/gi) || []).length !== (html.match(/<\/script>/gi) || []).length) return 'a <script> tag was never closed';
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { new vm.Script(m[1]); } catch (e) { return 'JavaScript syntax error: ' + e.message; }
  }
  return '';
}

async function generate({ prompt, error }) {
  let problem = error ? String(error).slice(0, 300) : '';
  for (let i = 0; i < 2; i++) { // one automatic retry
    const user = `Game idea: ${prompt}` + (problem ? `\n\nA previous attempt failed: ${problem}. Write a fresh, complete, MORE COMPACT version (under 300 lines, no comments) and double-check that it runs.` : '');
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], temperature: 0.7, max_tokens: +process.env.MAX_TOKENS || 8000 }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `LLM request failed (${r.status})`);
    try {
      const html = extractHtml(j.choices?.[0]?.message?.content || '');
      problem = validate(html, j.choices?.[0]?.finish_reason);
      if (!problem) return html;
    } catch (e) { problem = e.message; }
    console.log(`attempt ${i + 1} rejected: ${problem}`);
  }
  throw new Error(`The model kept returning a broken game (${problem}). Try again, or set a bigger LLM_MODEL in .env.`);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  try {
    if (req.method === 'POST' && req.url === '/api/generate') {
      if (!KEY) return send(500, { error: 'No LLM_API_KEY set. Copy .env.example to .env and add a key.' });
      if (limited(req.socket.remoteAddress)) return send(429, { error: 'Slow down a little (10 games/min).' });
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 200000) return send(413, { error: 'Too large' }); }
      const b = JSON.parse(raw || '{}');
      const prompt = String(b.prompt || '').trim().slice(0, 300);
      if (!prompt) return send(400, { error: 'Describe a game first.' });
      const html = await generate({ prompt, error: b.error });
      return send(200, { html });
    }
    if (req.method === 'GET') {
      const p = path.normalize(decodeURIComponent(req.url.split('?')[0]) === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]));
      const f = path.join(root, 'public', p);
      if (!f.startsWith(path.join(root, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, 'Not found', 'text/plain');
      return send(200, fs.readFileSync(f), TYPES[path.extname(f)] || 'application/octet-stream');
    }
    send(405, { error: 'Method not allowed' });
  } catch (e) { send(500, { error: e.message }); }
}).listen(PORT, () => console.log(`Quick Games running at http://localhost:${PORT}  (model: ${MODEL}${KEY ? '' : ', NO KEY SET'})`));
