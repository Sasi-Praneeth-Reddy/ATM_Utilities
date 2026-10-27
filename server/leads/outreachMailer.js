/**
 * server/leads/outreachMailer.js
 *
 * Handles pre-composed outreach email generation and delivery to matched previous customers
 * whose properties are currently listed for sale.
 *
 * Uses nodemailer with the company SMTP settings (same as server/emailer.js).
 */

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_SECURE = SMTP_PORT === 465;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'dispatch@aroundtownmovers.com';

let transporter = null;
function getTransporter() {
  if (!transporter && SMTP_HOST && SMTP_USER && SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Generate a personalized outreach draft for a matched previous customer.
 */
function generateOutreachDraft(match) {
  const customerName = match.customerName || 'Valued Customer';
  const firstName = customerName.split(' ')[0] || customerName;
  const address = match.matchedAddress || 'your property';
  const prevDate = match.previousMoveDate ? new Date(match.previousMoveDate).getFullYear() : 'previously';

  const subject = `Around Town Movers — Thinking of your next move from ${address}?`;

  const text = `Hi ${firstName},

We hope you're doing well! Around Town Movers had the pleasure of helping you move to ${address} ${prevDate !== 'previously' ? `back in ${prevDate}` : 'previously'}.

We noticed that your home was recently listed on the market. If you are preparing for an upcoming relocation, our team would love the opportunity to assist you again with the same top-tier care and expertise.

As a returning customer, we are delighted to offer you:
✓ Priority dispatch scheduling on our truck calendar
✓ Returning customer discount on local and long-distance moving
✓ Clean, secure short-term or long-term storage if needed between homes
✓ Full or partial packing services

Please feel free to reply directly to this email or call us at (703) 682-5922 to discuss your timing and request a quick estimate.

Wishing you all the best with your listing!

Warm regards,
Around Town Movers Team
(703) 682-5922
dispatch@aroundtownmovers.com
www.aroundtownmovers.com`;

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #2d3748; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="border-bottom: 2px solid #3182ce; padding-bottom: 12px; margin-bottom: 20px;">
    <h2 style="color: #2b6cb0; margin: 0; font-size: 22px;">Around Town Movers</h2>
    <p style="margin: 4px 0 0; color: #718096; font-size: 13px;">Your Trusted Moving & Storage Partner</p>
  </div>

  <p>Hi <strong>${firstName}</strong>,</p>

  <p>We hope you're doing well! Around Town Movers had the pleasure of helping you move to <strong>${address}</strong> ${prevDate !== 'previously' ? `back in ${prevDate}` : 'previously'}.</p>

  <p>We noticed that your home was recently listed on the market. If you are preparing for an upcoming relocation, our team would love the opportunity to assist you again with the same top-tier care and expertise!</p>

  <div style="background: #ebf8ff; border-left: 4px solid #3182ce; padding: 14px 18px; margin: 20px 0; border-radius: 4px;">
    <p style="margin: 0 0 8px 0; font-weight: bold; color: #2c5282;">As a valued returning customer, we offer you:</p>
    <ul style="margin: 0; padding-left: 20px; color: #2d3748;">
      <li><strong>Priority dispatch scheduling</strong> on our truck calendar</li>
      <li><strong>Exclusive returning client discounts</strong> on moving & labor</li>
      <li><strong>Flexible short or long-term storage</strong> between homes</li>
      <li>Full or partial packing & unpacking services</li>
    </ul>
  </div>

  <p>Please feel free to reply directly to this email or call us at <strong>(703) 682-5922</strong> so we can discuss your timeline and provide a complimentary estimate.</p>

  <p style="margin-top: 24px;">Wishing you the very best with your listing!</p>

  <div style="margin-top: 28px; border-top: 1px solid #e2e8f0; padding-top: 16px; font-size: 13px; color: #718096;">
    <strong>Around Town Movers Team</strong><br>
    Phone: (703) 682-5922<br>
    Email: <a href="mailto:dispatch@aroundtownmovers.com" style="color:#3182ce;">dispatch@aroundtownmovers.com</a><br>
    Web: <a href="https://www.aroundtownmovers.com" style="color:#3182ce;">www.aroundtownmovers.com</a>
  </div>
</div>`;

  return { subject, text, html };
}

/**
 * Send an outreach email.
 */
async function sendOutreachEmail({ toEmail, subject, text, html }) {
  if (!toEmail) {
    throw new Error('Recipient email address is required.');
  }

  const transport = getTransporter();
  if (!transport) {
    console.warn(`[outreachMailer] SMTP not configured. Simulated email to ${toEmail}: ${subject}`);
    return {
      success: true,
      simulated: true,
      message: `SMTP not configured in environment. Simulated email to ${toEmail}.`,
    };
  }

  const info = await transport.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject,
    text,
    html,
  });

  return {
    success: true,
    messageId: info.messageId,
  };
}

module.exports = {
  generateOutreachDraft,
  sendOutreachEmail,
};
