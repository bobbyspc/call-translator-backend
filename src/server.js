import 'dotenv/config';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import twilio from 'twilio';
import WebSocket from 'ws';

const VoiceResponse = twilio.twiml.VoiceResponse;

// --- Config (single source of truth; all from env) ---
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// Companion-display architecture: an inbound call to our Twilio number is
// bridged to Dad's real phone (TARGET_PHONE_NUMBER). He answers normally and
// opens the app to read the live translation.
const TARGET_PHONE_NUMBER = process.env.TARGET_PHONE_NUMBER || '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// Fast translation model (Haiku) for lower latency; override via env if needed.
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'claude-haiku-4-5-20251001';
// Summaries are not latency-sensitive; Haiku is plenty and keeps it on one funded account.
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'claude-haiku-4-5-20251001';

const app = Fastify({ logger: true });
await app.register(formbody);
await app.register(websocket);

// ---------------------------------------------------------------------------
// App-facing WebSocket: the phone-display app connects here and receives the
// live translated turns. Single user, so we just broadcast to all clients.
// ---------------------------------------------------------------------------
const appClients = new Set();
function broadcastToApp(obj) {
  const payload = JSON.stringify(obj);
  for (const c of appClients) {
    try { if (c.readyState === 1) c.send(payload); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Translation: English -> Spanish via Claude (fast Haiku model).
// ---------------------------------------------------------------------------
async function callClaude(model, system, userText, maxTokens) {
  if (!ANTHROPIC_API_KEY) return '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userText }],
      }),
    });
    const j = await r.json();
    return j?.content?.[0]?.text?.trim() || '';
  } catch (err) {
    app.log.error({ err }, 'claude call failed');
    return '';
  }
}

const TRANSLATE_SYSTEM =
  'You are a live phone-call translator. Translate the user\'s English text into natural, conversational Latin American Spanish. Output ONLY the Spanish translation with no quotes, labels, or notes.';
const translateToSpanish = (text) => callClaude(TRANSLATE_MODEL, TRANSLATE_SYSTEM, text, 300);

const SUMMARY_SYSTEM =
  'Eres un asistente que resume llamadas telefonicas en espanol para una persona mayor. Te doy la transcripcion (la otra persona y "Usted"). Resume en 2 a 4 frases claras: de que se trato la llamada y cualquier accion, fecha, hora o numero importante que "Usted" deba recordar. Responde solo con el resumen en espanol, sin encabezados.';
async function summarizeCall(turns) {
  if (!turns.length) return '';
  const transcript = turns
    .map((t) => `${t.speaker === 'caller' ? 'La otra persona' : 'Usted'}: ${t.en}`)
    .join('\n');
  return callClaude(SUMMARY_MODEL, SUMMARY_SYSTEM, transcript, 400);
}

// ---------------------------------------------------------------------------
// Deepgram streaming STT (English). Feeds mulaw 8kHz audio, emits finals.
// ---------------------------------------------------------------------------
function openDeepgram({ model, language }, onTranscript) {
  const params = new URLSearchParams({
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    model,
    language,
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true', // stream partials so the UI shows words live
    endpointing: '250',
  });
  const dg = new WebSocket('wss://api.deepgram.com/v1/listen?' + params.toString(), {
    headers: { Authorization: 'Token ' + DEEPGRAM_API_KEY },
  });
  dg.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const text = msg?.channel?.alternatives?.[0]?.transcript?.trim();
      if (text) onTranscript(text, !!msg.is_final);
    } catch { /* ignore keepalives */ }
  });
  dg.on('error', (err) => app.log.error({ err }, 'deepgram ws error'));
  return dg;
}

// ---------------------------------------------------------------------------
// Twilio Media Streams: the caller's audio is forked here during the call.
// ---------------------------------------------------------------------------
app.register(async (f) => {
  f.get('/media', { websocket: true }, (socket) => {
    app.log.info('twilio media stream connected');
    // Both sides speak English; everything is translated to Spanish for Dad.
    // Partials stream live to the UI; the finalized phrase gets translated.
    const transcript = []; // accumulated finalized turns, for the end-of-call summary
    let summarized = false;

    const makeSide = (speaker) => {
      const q = [];
      const dg = openDeepgram({ model: 'nova-2-phonecall', language: 'en' }, async (text, isFinal) => {
        if (!isFinal) {
          broadcastToApp({ type: 'interim', speaker, en: text });
          return;
        }
        const es = await translateToSpanish(text);
        transcript.push({ speaker, en: text, es });
        broadcastToApp({ type: 'turn', speaker, en: text, es });
        app.log.info({ speaker, en: text, es }, 'turn');
      });
      dg.on('open', () => { while (q.length && dg.readyState === 1) dg.send(q.shift()); });
      return { dg, q };
    };

    const caller = makeSide('caller'); // inbound track
    const dad = makeSide('dad');       // outbound track

    // Generate the summary once, after the call ends, and push it to the app.
    const finishCall = async () => {
      if (summarized) return;
      summarized = true;
      broadcastToApp({ type: 'call_end' });
      for (const s of [caller, dad]) {
        try { if (s.dg.readyState === 1) s.dg.send(JSON.stringify({ type: 'CloseStream' })); s.dg.close(); } catch { /* */ }
      }
      // Give any in-flight final translation a moment to land, then summarize.
      await new Promise((r) => setTimeout(r, 1200));
      const summary = await summarizeCall(transcript);
      app.log.info({ turns: transcript.length, summary }, 'summary');
      broadcastToApp({ type: 'summary', text: summary });
    };

    socket.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.event === 'start') {
        broadcastToApp({ type: 'call_start' });
      } else if (m.event === 'media') {
        const buf = Buffer.from(m.media.payload, 'base64');
        const s = m.media.track === 'outbound' ? dad : caller;
        if (s.dg.readyState === 1) s.dg.send(buf); else s.q.push(buf);
      } else if (m.event === 'stop') {
        finishCall();
      }
    });
    socket.on('close', () => { finishCall(); });
  });

  // App-display clients connect here.
  f.get('/app', { websocket: true }, (socket) => {
    appClients.add(socket);
    try { socket.send(JSON.stringify({ type: 'hello' })); } catch { /* */ }
    socket.on('close', () => appClients.delete(socket));
    socket.on('error', () => appClients.delete(socket));
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------
app.get('/health', async () => ({ ok: true, service: 'call-translator-backend', appClients: appClients.size }));

// Twilio hits this when a call comes in to our number.
app.post('/voice', async (req, reply) => {
  const body = req.body || {};
  const from = String(body.From || '');
  const twiml = new VoiceResponse();

  if (!TARGET_PHONE_NUMBER) {
    twiml.say({ voice: 'Polly.Joanna' }, 'This translation line is not set up yet. Goodbye.');
    twiml.hangup();
  } else {
    // Fork the caller's audio to /media for live translation, then bridge to Dad.
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const start = twiml.start();
    start.stream({ url: `wss://${host}/media`, track: 'both_tracks' });
    // Use our Twilio number as caller ID. Passing the original caller's number
    // through gets spam-rejected (busy) by many carriers due to STIR/SHAKEN.
    const dial = twiml.dial({ callerId: TWILIO_PHONE_NUMBER || from, answerOnBridge: true });
    dial.number(TARGET_PHONE_NUMBER);
  }

  reply.type('text/xml').send(twiml.toString());
});

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Call Translator backend up on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
