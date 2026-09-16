export function loadConfig(env = process.env) {
  const csv = (value) =>
    String(value || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  const number = (value, fallback) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  return {
    port: number(env.PORT, 3000),
    host: env.HOST || "0.0.0.0",
    publicBaseUrl: String(env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    targetPhoneNumber: env.TARGET_PHONE_NUMBER || "",
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER || "",
    forwardingSourceNumbers: csv(env.FORWARDING_SOURCE_NUMBERS),
    ringTimeoutSeconds: number(env.RING_TIMEOUT_SECONDS, 25),
    enableAppAnswer: env.ENABLE_APP_ANSWER === "true",
    clientIdentity: env.CLIENT_IDENTITY || "",
    pairingCode: env.APP_PAIRING_CODE || "",
    dataFile: env.DATA_FILE || "./data/state.json",
    webAllowedOrigins: csv(env.WEB_ALLOWED_ORIGINS),
    authTimeoutMs: number(env.APP_AUTH_TIMEOUT_MS, 5000),
    pairingWindowMs: number(env.PAIRING_WINDOW_MS, 60000),
    trustedProxyHops: number(env.TRUSTED_PROXY_HOPS, 1),
    pairingMaxAttempts: number(env.PAIRING_MAX_ATTEMPTS, 5),
    maxDevices: number(env.MAX_PAIRED_DEVICES, 3),
    maxCalls: number(env.MAX_STORED_CALLS, 50),
    maxTurnsPerCall: number(env.MAX_TURNS_PER_CALL, 500),
    maxQueuedAudioBytes: number(env.MAX_QUEUED_AUDIO_BYTES, 1_000_000),
    maxPendingTranslations: number(env.MAX_PENDING_TRANSLATIONS, 50),
    providerCloseTimeoutMs: number(env.PROVIDER_CLOSE_TIMEOUT_MS, 3000),
    translationTimeoutMs: number(env.TRANSLATION_TIMEOUT_MS, 12000),
    summaryTimeoutMs: number(env.SUMMARY_TIMEOUT_MS, 20000),
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || "",
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || "",
    twilioApiKeySid: env.TWILIO_API_KEY_SID || "",
    twilioApiKeySecret: env.TWILIO_API_KEY_SECRET || "",
    twilioTwimlAppSid: env.TWILIO_TWIML_APP_SID || "",
    twilioPushCredentialSid: env.TWILIO_PUSH_CREDENTIAL_SID || "",
    deepgramApiKey: env.DEEPGRAM_API_KEY || "",
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    translateModel: env.TRANSLATE_MODEL || "claude-haiku-4-5-20251001",
    summaryModel: env.SUMMARY_MODEL || "claude-haiku-4-5-20251001",
    keepWarmUrl: env.KEEP_WARM_URL || "",
    keepWarmMinutes: number(env.KEEP_WARM_MINUTES, 10),
    expoAccessToken: env.EXPO_ACCESS_TOKEN || "",
    firebaseServiceAccountJson: env.FIREBASE_SERVICE_ACCOUNT_JSON || "",
    googleApplicationCredentials: env.GOOGLE_APPLICATION_CREDENTIALS || "",
    pushTimeoutMs: number(env.PUSH_TIMEOUT_MS, 2500),
  };
}
