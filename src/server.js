import 'dotenv/config';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import twilio from 'twilio';

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;
const VoiceResponse = twilio.twiml.VoiceResponse;

// --- Config (single source of truth; all from env) ---
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// Companion-display architecture: an inbound call to our Twilio number is
// bridged to Dad's real phone (TARGET_PHONE_NUMBER). He answers normally and
// opens the app to read the live translation.
const TARGET_PHONE_NUMBER = process.env.TARGET_PHONE_NUMBER || '';
const CLIENT_IDENTITY = process.env.CLIENT_IDENTITY || 'dad'; // legacy softphone default; unused in display mode
const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 3600);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const app = Fastify({ logger: true });
await app.register(formbody);

// Health check for the host (Render/Railway) and for smoke tests.
app.get('/health', async () => ({ ok: true, service: 'call-translator-backend' }));

// The app calls this on launch to log in as a Twilio Voice client.
app.get('/token', async (req) => {
  const identity = String(req.query.identity || CLIENT_IDENTITY);
  const token = new AccessToken(
    requireEnv('TWILIO_ACCOUNT_SID'),
    requireEnv('TWILIO_API_KEY_SID'),
    requireEnv('TWILIO_API_KEY_SECRET'),
    { identity, ttl: TOKEN_TTL_SECONDS }
  );
  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: requireEnv('TWILIO_TWIML_APP_SID'),
    incomingAllow: true, // lets Twilio push inbound calls to this client
  }));
  return { identity, ttl: TOKEN_TTL_SECONDS, token: token.toJwt() };
});

// Twilio hits this for every call leg.
//  - Inbound PSTN to our number  -> From is a phone number  -> ring the app client.
//  - Outbound from the app       -> From starts with "client:" -> dial the PSTN number.
// (Media Streams for live translation gets added here in Phase 2.)
app.post('/voice', async (req, reply) => {
  const body = req.body || {};
  const from = String(body.From || '');
  const twiml = new VoiceResponse();

  // Inbound call to our Twilio number -> bridge to Dad's real phone.
  // Phase 2 adds <Start><Stream url="wss://.../media"/> here to fork the call
  // audio into the Deepgram STT + translation pipeline.
  if (!TARGET_PHONE_NUMBER) {
    twiml.say({ voice: 'Polly.Joanna' }, 'This translation line is not set up yet. Goodbye.');
    twiml.hangup();
  } else {
    // Show Dad the original caller's number (not ours) so he knows who is calling.
    const dial = twiml.dial({ callerId: from || process.env.TWILIO_PHONE_NUMBER });
    dial.number(TARGET_PHONE_NUMBER);
  }

  reply.type('text/xml').send(twiml.toString());
});

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Call Translator backend up on ${HOST}:${PORT} (client identity: ${CLIENT_IDENTITY})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
