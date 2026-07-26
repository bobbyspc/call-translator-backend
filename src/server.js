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
// Answering endpoints. An inbound call rings every configured endpoint at once
// (Twilio "simulring"); the first to answer wins and the rest are cancelled.
// TARGET_PHONE_NUMBER is Dad's second phone line and is the reliable floor:
// it works with the app closed, uninstalled, or the phone in deep sleep.
// The app client leg is an additional, optional way to pick up.
const TARGET_PHONE_NUMBER = process.env.TARGET_PHONE_NUMBER || '';
const APP_CLIENT_IDENTITY = process.env.CLIENT_IDENTITY || '';
const ENABLE_APP_ANSWER = process.env.ENABLE_APP_ANSWER === 'true';
const RING_TIMEOUT_SECONDS = Number(process.env.RING_TIMEOUT_SECONDS || 25);
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';
// Numbers whose carrier forwards calls INTO this line. Dialing one of them back
// would be forwarded straight back to us: an infinite, billable call loop.
// Comma-separated E.164 list.
const FORWARDING_SOURCE_NUMBERS = (process.env.FORWARDING_SOURCE_NUMBERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Render's free tier sleeps after ~15 min idle and takes ~50s to wake, long
// enough for Twilio to time out and drop an inbound call. Self-ping to stay up.
const KEEP_WARM_URL = process.env.KEEP_WARM_URL || '';
const KEEP_WARM_MINUTES = Number(process.env.KEEP_WARM_MINUTES || 10);
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
        // `from` is passed through from /voice as a <Parameter> on the stream.
        const from = m.start?.customParameters?.from || '';
        broadcastToApp({ type: 'call_start', from });
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

// Compare phone numbers by digits only, so +1 786... and 1786... match.
const digits = (n) => String(n || '').replace(/\D/g, '');
const sameNumber = (a, b) => !!digits(a) && digits(a) === digits(b);

// Twilio hits this when a call comes in to our number.
app.post('/voice', async (req, reply) => {
  const body = req.body || {};
  const from = String(body.From || '');
  const twiml = new VoiceResponse();

  // --- Loop guard: a call that appears to come from our own number means we
  // are talking to ourselves. A forwarding loop fans out exponentially and
  // bills for every leg, so drop it immediately.
  if (sameNumber(from, TWILIO_PHONE_NUMBER)) {
    app.log.error({ from }, 'LOOP GUARD: inbound call is from our own number, refusing');
    twiml.hangup();
    return reply.type('text/xml').send(twiml.toString());
  }

  // --- Assemble the answering endpoints.
  const legs = [];
  if (TARGET_PHONE_NUMBER) {
    // Second loop guard: never dial a number whose carrier forwards back into
    // this line. Drop just this leg rather than the whole call, so a bad
    // TARGET_PHONE_NUMBER cannot silently kill Dad's phone service.
    if (FORWARDING_SOURCE_NUMBERS.some((n) => sameNumber(n, TARGET_PHONE_NUMBER))) {
      app.log.error(
        { target: TARGET_PHONE_NUMBER, forwardingSources: FORWARDING_SOURCE_NUMBERS },
        'LOOP GUARD: TARGET_PHONE_NUMBER forwards back into this line, dropping that leg',
      );
    } else {
      legs.push({ kind: 'number', value: TARGET_PHONE_NUMBER });
    }
  }
  // If the app is not registered, Twilio fails this leg immediately and the
  // phone leg keeps ringing. That degradation is the point of ringing both.
  if (ENABLE_APP_ANSWER && APP_CLIENT_IDENTITY) {
    legs.push({ kind: 'client', value: APP_CLIENT_IDENTITY });
  }

  if (!legs.length) {
    app.log.error('no answering endpoints configured, refusing call');
    twiml.say({ voice: 'Polly.Joanna' }, 'This line is not available right now. Goodbye.');
    twiml.hangup();
    return reply.type('text/xml').send(twiml.toString());
  }

  // Fork the call audio to /media for live translation, then ring every endpoint.
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const start = twiml.start();
  const stream = start.stream({ url: `wss://${host}/media`, track: 'both_tracks' });
  // Carry the real caller's number into the media stream so the app can show
  // who is calling (the handset only ever sees our Twilio number, below).
  stream.parameter({ name: 'from', value: from });
  // Use our Twilio number as caller ID. Passing the original caller's number
  // through gets spam-rejected (busy) by many carriers due to STIR/SHAKEN.
  const dial = twiml.dial({
    callerId: TWILIO_PHONE_NUMBER || from,
    answerOnBridge: true,
    timeout: RING_TIMEOUT_SECONDS,
  });
  for (const leg of legs) {
    if (leg.kind === 'number') dial.number(leg.value);
    else dial.client(leg.value);
  }
  app.log.info({ legs: legs.map((l) => `${l.kind}:${l.value}`) }, 'ringing');

  reply.type('text/xml').send(twiml.toString());
});

// Mints the access token the app needs to register as a Twilio Voice client
// and receive the <Client> leg above. Only needed when ENABLE_APP_ANSWER is on.
app.get('/token', async (req, reply) => {
  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID } = process.env;
  // Push credential ties incoming calls to FCM so the app can ring while
  // backgrounded. Without it the app only receives calls while in foreground.
  const TWILIO_PUSH_CREDENTIAL_SID = process.env.TWILIO_PUSH_CREDENTIAL_SID || '';

  if (!ENABLE_APP_ANSWER) return reply.code(404).send({ error: 'app answering is disabled' });
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWILIO_TWIML_APP_SID) {
    return reply.code(500).send({ error: 'twilio credentials not configured' });
  }
  if (!APP_CLIENT_IDENTITY) return reply.code(500).send({ error: 'CLIENT_IDENTITY not set' });

  const { AccessToken } = twilio.jwt;
  const grant = new AccessToken.VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID,
    incomingAllow: true,
    ...(TWILIO_PUSH_CREDENTIAL_SID ? { pushCredentialSid: TWILIO_PUSH_CREDENTIAL_SID } : {}),
  });
  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, {
    identity: APP_CLIENT_IDENTITY,
  });
  token.addGrant(grant);
  return {
    token: token.toJwt(),
    identity: APP_CLIENT_IDENTITY,
    hasPushCredential: !!TWILIO_PUSH_CREDENTIAL_SID,
  };
});

// Keep the free-tier instance awake so the first call after a quiet stretch
// does not hit a ~50s cold start and get dropped by Twilio.
if (KEEP_WARM_URL) {
  const timer = setInterval(() => {
    fetch(KEEP_WARM_URL).catch((err) => app.log.warn({ err }, 'keep-warm ping failed'));
  }, KEEP_WARM_MINUTES * 60 * 1000);
  timer.unref?.();
  app.log.info({ url: KEEP_WARM_URL, minutes: KEEP_WARM_MINUTES }, 'keep-warm enabled');
}

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Call Translator backend up on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
