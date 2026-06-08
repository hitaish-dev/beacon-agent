// WhatsApp delivery via Twilio, with a zero-setup mock fallback.

let _client = null;

function twilioConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_FROM
  );
}

async function getClient() {
  if (_client) return _client;
  const twilio = (await import('twilio')).default;
  _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return _client;
}

export function whatsappMode() {
  return twilioConfigured() ? 'twilio' : 'mock';
}

// Twilio caps message bodies at 1600 chars; keep WhatsApp summaries tight.
function clamp(text, max = 1500) {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export function whatsappRecipient() {
  return process.env.TWILIO_WHATSAPP_TO || null;
}

export async function sendWhatsApp(body, { to = process.env.TWILIO_WHATSAPP_TO, mediaUrl } = {}) {
  const message = clamp(body);

  if (!twilioConfigured() || !to) {
    console.log('\n──────── [WhatsApp MOCK] ────────');
    console.log(`to: ${to || '(set TWILIO_WHATSAPP_TO)'}`);
    if (mediaUrl) console.log(`media: ${mediaUrl}`);
    console.log(message);
    console.log('─────────────────────────────────\n');
    return {
      mode: 'mock',
      ok: true,
      to: to || null,
      mediaUrl: mediaUrl || null,
      note: 'Twilio not fully configured — message logged, not sent.',
    };
  }

  try {
    const client = await getClient();
    const payload = {
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
      body: message,
    };
    if (mediaUrl) payload.mediaUrl = [mediaUrl];
    const res = await client.messages.create(payload);
    return { mode: 'twilio', ok: true, sid: res.sid, to, mediaUrl: mediaUrl || null, status: res.status };
  } catch (err) {
    console.error('[whatsapp] Twilio send failed:', err.message);
    return { mode: 'twilio', ok: false, to, error: err.message };
  }
}
