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
// The app registers under this Twilio Client identity. Inbound PSTN calls are
// dialed to this client so Dad answers inside the app.
const CLIENT_IDENTITY = process.env.CLIENT_IDENTITY || 'dad';
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
  const to = String(body.To || '');
  const twiml = new VoiceResponse();

  if (from.startsWith('client:')) {
    // App is placing an outbound call.
    const dial = twiml.dial({ callerId: process.env.TWILIO_PHONE_NUMBER });
    dial.number(to.replace(/[^\d+]/g, ''));
  } else {
    // Inbound call to the Twilio number: ring the app so Dad answers in-app.
    const dial = twiml.dial();
    dial.client(CLIENT_IDENTITY);
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
