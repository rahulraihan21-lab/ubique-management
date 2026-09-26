// send-sms — অভিভাবকের ফোনে SMS পাঠায়।
//
// Secrets (Supabase → Edge Functions → Secrets):
//   ADMIN_PASSWORD   অ্যাডমিন PIN (awaj-broadcast-এর মতোই)
//   SMS_PROVIDER     "bulksmsbd" | "alphasms" — না থাকলে dry-run: কিছু পাঠায় না, শুধু হিসাব দেখায়
//   SMS_API_KEY      প্রোভাইডারের API key
//   SMS_SENDER_ID    (ঐচ্ছিক) অনুমোদিত sender ID / masking নাম
//
// Request: POST { messages: [{ phone, text }], dry_run?: boolean }
// Response: { dry_run, provider, sent, skipped: [{ phone, reason }], segments, results }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-password',
};

const MAX_MESSAGES = 1000;
const MAX_TEXT = 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// যেকোনো ফরম্যাট (01XXXXXXXXX, 1XXXXXXXXX, +8801..., "\r" সহ) → 8801XXXXXXXXX, অথবা null
export function normalizeBdPhone(raw: string): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('880')) d = d.slice(2);
  if (d.length === 10 && /^1[3-9]/.test(d)) d = '0' + d;
  if (!/^01[3-9]\d{8}$/.test(d)) return null;
  return '88' + d;
}

// বাংলা/ইউনিকোড হলে ৭০ অক্ষর (একাধিক হলে ৬৭), নাহলে ১৬০ (একাধিক হলে ১৫৩) প্রতি SMS
export function smsSegments(text: string): number {
  const unicode = /[^\x00-\x7F]/.test(text);
  const len = [...text].length;
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return len <= single ? 1 : Math.ceil(len / multi);
}

type Outcome = { ok: boolean; detail: unknown };

async function sendBulkSmsBd(key: string, sender: string, phones: string[], text: string): Promise<Outcome> {
  const p = new URLSearchParams({ api_key: key, type: 'text', number: phones.join(','), message: text });
  if (sender) p.set('senderid', sender);
  const res = await fetch('https://bulksmsbd.net/api/smsapi', { method: 'POST', body: p });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && Number(data.response_code) === 202, detail: data };
}

async function sendAlphaSms(key: string, sender: string, phones: string[], text: string): Promise<Outcome> {
  const p = new URLSearchParams({ api_key: key, msg: text, to: phones.join(',') });
  if (sender) p.set('sender_id', sender);
  const res = await fetch('https://api.sms.net.bd/sendsms', { method: 'POST', body: p });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && Number(data.error) === 0, detail: data };
}

const PROVIDERS: Record<string, typeof sendBulkSmsBd> = {
  bulksmsbd: sendBulkSmsBd,
  alphasms: sendAlphaSms,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const ADMIN_PASSWORD = Deno.env.get('ADMIN_PASSWORD')?.trim();
    const clientPassword = req.headers.get('x-admin-password')?.trim();
    if (!ADMIN_PASSWORD || !clientPassword || clientPassword !== ADMIN_PASSWORD) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const body = await req.json().catch(() => null);
    const messages = body?.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) {
      return json({ error: `messages: 1–${MAX_MESSAGES}টি {phone, text} দিন` }, 400);
    }

    // নম্বর ঠিক করা, খারাপগুলো বাদ, একই নম্বরে একই বার্তা দুবার নয়
    const skipped: { phone: string; reason: string }[] = [];
    const byText = new Map<string, Set<string>>();
    for (const m of messages) {
      const text = String(m?.text ?? '').trim();
      const phone = normalizeBdPhone(m?.phone);
      if (!text || [...text].length > MAX_TEXT) { skipped.push({ phone: String(m?.phone ?? ''), reason: 'invalid_text' }); continue; }
      if (!phone) { skipped.push({ phone: String(m?.phone ?? ''), reason: 'invalid_phone' }); continue; }
      if (!byText.has(text)) byText.set(text, new Set());
      const set = byText.get(text)!;
      if (set.has(phone)) { skipped.push({ phone, reason: 'duplicate' }); continue; }
      set.add(phone);
    }

    let recipients = 0, segments = 0;
    for (const [text, phones] of byText) { recipients += phones.size; segments += phones.size * smsSegments(text); }

    const provider = Deno.env.get('SMS_PROVIDER')?.trim().toLowerCase() || '';
    const key = Deno.env.get('SMS_API_KEY')?.trim() || '';
    const sender = Deno.env.get('SMS_SENDER_ID')?.trim() || '';
    const send = PROVIDERS[provider];
    const dryRun = body?.dry_run === true || !send || !key;

    if (dryRun) {
      return json({ dry_run: true, provider: send && key ? provider : null, sent: 0, recipients, segments, skipped });
    }

    // একই বার্তা যাদের, তাদের একসাথে ১০০ করে পাঠানো
    const results: unknown[] = [];
    let sent = 0;
    for (const [text, phoneSet] of byText) {
      const phones = [...phoneSet];
      for (let i = 0; i < phones.length; i += 100) {
        const chunk = phones.slice(i, i + 100);
        const r = await send(key, sender, chunk, text);
        results.push(r.detail);
        if (r.ok) sent += chunk.length;
        else chunk.forEach((p) => skipped.push({ phone: p, reason: 'provider_error' }));
      }
    }
    return json({ dry_run: false, provider, sent, recipients, segments, skipped, results });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});
