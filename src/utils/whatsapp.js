// ========================= utils/whatsapp.js =========================
import axios from 'axios';

const WA_BASE = 'https://graph.facebook.com/v20.0';

function normalizePhone(raw, defaultCountry = process.env.DEFAULT_COUNTRY_CODE || '968') {
  if (!raw) return null;
  // أرقام فقط
  let n = String(raw).replace(/\D/g, '');
  // إن كان الرقم يبدأ بـ 00 استبدلها بـ (لا شيء)
  if (n.startsWith('00')) n = n.slice(2);
  // إن كان يبدأ بـ 0 ولم يحوِ كود الدولة؛ أضف كود الدولة الافتراضي
  if (n.startsWith('0') && !n.startsWith(defaultCountry)) {
    n = defaultCountry + n.slice(1);
  }
  // إن لم يبدأ بكود دولة، وكان طوله محلي (8-9 أرقام)، أضف كود الدولة
  if (!n.startsWith(defaultCountry) && n.length <= 9) {
    n = defaultCountry + n;
  }
  return n;
}

/**
 * إرسال نص عادي عبر واتساب (داخل نافذة 24 ساعة).
 * يفضَّل استخدامه كرسالة خدمة/Utility لو العميل كان تفاعل معك مؤخراً.
 */
export async function sendWhatsAppText(toNumber, text) {
  if (!toNumber || !text) return;
  const url = `${WA_BASE}/${process.env.PHONE_NUMBER_ID}/messages`;
  const headers = {
    'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const payload = {
    messaging_product: 'whatsapp',
    to: toNumber,               // يجب أن يكون دولي بدون +
    type: 'text',
    text: { body: text },
  };
  await axios.post(url, payload, { headers });
}

/**
 * واجهة مريحة: تنظف الرقم وتستدعي sendWhatsAppText
 */
export async function sendOrderWhatsApp(toRawPhone, message) {
  const to = normalizePhone(toRawPhone);
  if (!to) return;
  try {
    await sendWhatsAppText(to, message);
  } catch (err) {
    console.error('WhatsApp send error:', err?.response?.data || err.message || err);
  }
}

/**
 * إرسال إشعار إداري لرقم ثابت من البيئة
 */
export async function notifyAdmin(message) {
  const admin = process.env.ADMIN_WHATSAPP;
  if (!admin) return;
  try {
    await sendWhatsAppText(admin, message);
  } catch (err) {
    console.error('WhatsApp admin send error:', err?.response?.data || err.message || err);
  }
}
