#!/usr/bin/env node
/**
 * Deploy the failover TwiML handler to Twilio Serverless and point the phone
 * number's VoiceFallbackUrl at it.
 *
 * Why: once Dad's carrier forwards every call into this line, our Render
 * backend becomes a single point of failure for his phone. If /voice is slow
 * or down, Twilio drops the call and Dad simply never hears it ring. This
 * failover runs on Twilio's own infrastructure (different failure domain) and
 * bridges the call straight through with no translation. A call with no
 * subtitles beats a missed call.
 *
 * Usage:
 *   node scripts/twilio-failover.mjs --target +17862306488 [--json]
 *   node scripts/twilio-failover.mjs --show
 *   node scripts/twilio-failover.mjs --help
 *
 * Credentials come from Brain/.env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * TWILIO_PHONE_NUMBER).
 */
import 'dotenv/config';

// --- Config (single source of truth) ---
const SERVICE_UNIQUE_NAME = 'call-translator-failover';
const ENVIRONMENT_SUFFIX = 'prod';
const FUNCTION_PATH = '/failover';
const API = 'https://serverless.twilio.com/v1';
const UPLOAD_API = 'https://serverless-upload.twilio.com/v1';
const BUILD_POLL_MS = 3000;
const BUILD_POLL_MAX = 60;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

if (has('--help')) {
  console.log(`Deploy the Twilio Serverless failover handler and wire it as the
phone number's VoiceFallbackUrl.

  --target <E.164>  Number to bridge to when the main backend is down (required
                    unless --show). Should match TARGET_PHONE_NUMBER on Render.
  --show            Print the current fallback config and exit.
  --json            Machine-readable output.
  --help            This message.`);
  process.exit(0);
}

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
if (!ACCOUNT_SID || !AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER in env.');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
const json = has('--json');
const log = (...a) => { if (!json) console.log(...a); };

async function call(url, { method = 'GET', form } = {}) {
  const init = { method, headers: { Authorization: AUTH } };
  if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  }
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 300)}`);
  return body;
}

const numbersUrl = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers.json`;

async function findNumber() {
  const list = await call(numbersUrl);
  const digits = (n) => String(n || '').replace(/\D/g, '');
  const n = (list.incoming_phone_numbers || []).find((x) => digits(x.phone_number) === digits(TWILIO_PHONE_NUMBER));
  if (!n) throw new Error(`${TWILIO_PHONE_NUMBER} is not on this Twilio account.`);
  return n;
}

if (has('--show')) {
  const n = await findNumber();
  const out = {
    number: n.phone_number,
    voice_url: n.voice_url,
    voice_fallback_url: n.voice_fallback_url,
    voice_fallback_method: n.voice_fallback_method,
  };
  console.log(json ? JSON.stringify(out, null, 2) : out);
  process.exit(0);
}

const target = flag('--target');
if (!target || !/^\+\d{8,15}$/.test(target)) {
  console.error('--target is required and must be E.164 (example: +17862306488)');
  process.exit(1);
}
if (target.replace(/\D/g, '') === TWILIO_PHONE_NUMBER.replace(/\D/g, '')) {
  console.error('--target cannot be the Twilio number itself (that is a call loop).');
  process.exit(1);
}

// The deployed function. Kept deliberately dumb: no dependencies, no network
// calls, just bridge the call. TARGET/CALLER_ID come from service env vars so
// changing the destination does not need a redeploy of code.
const FUNCTION_SOURCE = `exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const target = context.FAILOVER_TARGET;
  if (!target) {
    twiml.say({ voice: 'Polly.Joanna' }, 'This line is not available right now. Goodbye.');
    twiml.hangup();
  } else {
    const dial = twiml.dial({ callerId: context.FAILOVER_CALLER_ID, answerOnBridge: true });
    dial.number(target);
  }
  callback(null, twiml);
};
`;

// 1. Service (idempotent)
let service = (await call(`${API}/Services?PageSize=50`)).services
  ?.find((s) => s.unique_name === SERVICE_UNIQUE_NAME);
if (!service) {
  service = await call(`${API}/Services`, {
    method: 'POST',
    form: { UniqueName: SERVICE_UNIQUE_NAME, FriendlyName: 'Call Translator failover', IncludeCredentials: 'true' },
  });
  log('created service', service.sid);
} else {
  log('reusing service', service.sid);
}
const svc = service.sid;

// 2. Function (idempotent)
let fn = (await call(`${API}/Services/${svc}/Functions?PageSize=50`)).functions
  ?.find((f) => f.friendly_name === 'failover');
if (!fn) {
  fn = await call(`${API}/Services/${svc}/Functions`, { method: 'POST', form: { FriendlyName: 'failover' } });
  log('created function', fn.sid);
}

// 3. Upload a new version of the source (multipart, separate upload host)
const fd = new FormData();
fd.append('Path', FUNCTION_PATH);
fd.append('Visibility', 'public');
fd.append('Content', new Blob([FUNCTION_SOURCE], { type: 'application/javascript' }), 'failover.js');
const verRes = await fetch(`${UPLOAD_API}/Services/${svc}/Functions/${fn.sid}/Versions`, {
  method: 'POST',
  headers: { Authorization: AUTH },
  body: fd,
});
const verText = await verRes.text();
if (!verRes.ok) throw new Error(`version upload -> ${verRes.status} ${verText.slice(0, 300)}`);
const version = JSON.parse(verText);
log('uploaded function version', version.sid);

// 4. Service env vars (destination lives here, not in code)
const existingVars = (await call(`${API}/Services/${svc}/Environments?PageSize=50`)).environments || [];
let env = existingVars.find((e) => e.domain_suffix === ENVIRONMENT_SUFFIX);
if (!env) {
  env = await call(`${API}/Services/${svc}/Environments`, {
    method: 'POST',
    form: { UniqueName: ENVIRONMENT_SUFFIX, DomainSuffix: ENVIRONMENT_SUFFIX },
  });
  log('created environment', env.sid, env.domain_name);
}
const wanted = { FAILOVER_TARGET: target, FAILOVER_CALLER_ID: TWILIO_PHONE_NUMBER };
const currentVars = (await call(`${API}/Services/${svc}/Environments/${env.sid}/Variables?PageSize=50`)).variables || [];
for (const [key, value] of Object.entries(wanted)) {
  const found = currentVars.find((v) => v.key === key);
  if (!found) {
    await call(`${API}/Services/${svc}/Environments/${env.sid}/Variables`, { method: 'POST', form: { Key: key, Value: value } });
    log('set var', key, '=', value);
  } else if (found.value !== value) {
    await call(`${API}/Services/${svc}/Environments/${env.sid}/Variables/${found.sid}`, { method: 'POST', form: { Value: value } });
    log('updated var', key, '=', value);
  }
}

// 5. Build + poll
let build = await call(`${API}/Services/${svc}/Builds`, {
  method: 'POST',
  form: { FunctionVersions: version.sid },
});
log('build', build.sid, 'status', build.status);
for (let i = 0; i < BUILD_POLL_MAX && build.status !== 'completed'; i++) {
  if (build.status === 'failed') throw new Error('build failed: ' + JSON.stringify(build));
  await new Promise((r) => setTimeout(r, BUILD_POLL_MS));
  build = await call(`${API}/Services/${svc}/Builds/${build.sid}`);
}
if (build.status !== 'completed') throw new Error('build did not complete in time: ' + build.status);
log('build completed');

// 6. Deploy
await call(`${API}/Services/${svc}/Environments/${env.sid}/Deployments`, { method: 'POST', form: { BuildSid: build.sid } });
const fallbackUrl = `https://${env.domain_name}${FUNCTION_PATH}`;
log('deployed ->', fallbackUrl);

// 7. Point the number's fallback at it
const number = await findNumber();
await call(`${numbersUrl.replace('.json', '')}/${number.sid}.json`, {
  method: 'POST',
  form: { VoiceFallbackUrl: fallbackUrl, VoiceFallbackMethod: 'POST' },
});

const result = { number: number.phone_number, target, fallbackUrl, serviceSid: svc, buildSid: build.sid };
if (json) console.log(JSON.stringify(result, null, 2));
else console.log(`\nFailover armed. ${number.phone_number} falls back to ${fallbackUrl} -> bridges to ${target}.`);
