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
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'claude-haiku-4-5-20251001';

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
async function translateToSpanish(text) {
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
        model: TRANSLATE_MODEL,
        max_tokens: 300,
        system:
          'You are a live phone-call translator. Translate the user\'s English text into natural, conversational Latin American Spanish. Output ONLY the Spanish translation with no quotes, labels, or notes.',
        messages: [{ role: 'user', content: text }],
      }),
    });
    const j = await r.json();
    return j?.content?.[0]?.text?.trim() || '';
  } catch (err) {
    app.log.error({ err }, 'translation failed');
    return '';
  }
}

// ---------------------------------------------------------------------------
// Deepgram streaming STT (English). Feeds mulaw 8kHz audio, emits finals.
// ---------------------------------------------------------------------------
function openDeepgram(onFinalTranscript) {
  const params = new URLSearchParams({
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    model: 'nova-2-phonecall',
    language: 'en',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'false',
    endpointing: '300',
  });
  const dg = new WebSocket('wss://api.deepgram.com/v1/listen?' + params.toString(), {
    headers: { Authorization: 'Token ' + DEEPGRAM_API_KEY },
  });
  dg.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const text = msg?.channel?.alternatives?.[0]?.transcript?.trim();
      if (text && msg.is_final) onFinalTranscript(text);
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
    const queue = [];
    const dg = openDeepgram(async (englishText) => {
      const es = await translateToSpanish(englishText);
      broadcastToApp({ type: 'turn', speaker: 'caller', en: englishText, es });
      app.log.info({ en: englishText, es }, 'turn');
    });
    dg.on('open', () => {
      while (queue.length && dg.readyState === 1) dg.send(queue.shift());
    });

    socket.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.event === 'start') {
        broadcastToApp({ type: 'call_start' });
      } else if (m.event === 'media') {
        const buf = Buffer.from(m.media.payload, 'base64');
        if (dg.readyState === 1) dg.send(buf); else queue.push(buf);
      } else if (m.event === 'stop') {
        broadcastToApp({ type: 'call_end' });
        try { if (dg.readyState === 1) dg.send(JSON.stringify({ type: 'CloseStream' })); dg.close(); } catch { /* */ }
      }
    });
    socket.on('close', () => { try { dg.close(); } catch { /* */ } });
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
    start.stream({ url: `wss://${host}/media`, track: 'inbound_track' });
    // Show Dad the original caller's number (not ours) so he knows who is calling.
    const dial = twiml.dial({ callerId: from || TWILIO_PHONE_NUMBER });
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
