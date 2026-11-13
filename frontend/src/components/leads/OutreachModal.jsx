import { useState, useEffect } from 'react';
import { fetchOutreachDraft, sendOutreach } from './leadsApi';

export default function OutreachModal({ backendUrl, match, onClose, onSent }) {
  const [recipient, setRecipient] = useState(match?.customerEmail || '');
  const [subject, setSubject] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sentSuccess, setSentSuccess] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoadingDraft(true);
        const draft = await fetchOutreachDraft(backendUrl, match.id);
        if (active) {
          if (!recipient && draft.recipientEmail) {
            setRecipient(draft.recipientEmail);
          }
          setSubject(draft.subject || '');
          setMessageBody(draft.text || '');
        }
      } catch (err) {
        if (active) setError(`Failed to load draft: ${err.message}`);
      } finally {
        if (active) setLoadingDraft(false);
      }
    }
    load();
    return () => { active = false; };
  }, [backendUrl, match]);

  async function handleSend() {
    if (!recipient.trim()) {
      setError('Please provide a recipient email address.');
      return;
    }
    setError('');
    setSending(true);
    try {
      await sendOutreach(backendUrl, match.id, {
        to: recipient.trim(),
        subject,
        messageBody,
        notes: `Outreach sent by dispatcher on ${new Date().toLocaleDateString()}`,
      });
      setSentSuccess(true);
      if (onSent) onSent(match.id);
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err) {
      setError(`Failed to send email: ${err.message}`);
    } finally {
      setSending(false);
    }
  }

  const priceStr = match.listingPrice ? `$${Number(match.listingPrice).toLocaleString()}` : 'Price not listed';

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px'
    }}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{
        backgroundColor: 'var(--bg-card, #ffffff)', color: 'var(--text-main, #1a202c)',
        borderRadius: '8px', maxWidth: '640px', width: '100%', maxHeight: '90vh',
        overflowY: 'auto', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)', padding: '24px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
            Review & Ping Previous Customer
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--m-muted)' }}>
            ✕
          </button>
        </div>

        {/* Lead Match Summary Pill */}
        <div style={{
          backgroundColor: 'var(--bg-subtle, var(--m-surface-2))', border: '1px solid var(--border-color, var(--m-border))',
          borderRadius: '6px', padding: '12px 16px', marginBottom: '18px', fontSize: '13px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
            <span><strong>Customer:</strong> {match.customerName}</span>
            <span style={{ color: 'var(--m-blue)', fontWeight: 600 }}>{priceStr} ({match.listingStatus || 'For Sale'})</span>
          </div>
          <div style={{ color: 'var(--m-text-2)', marginBottom: '4px' }}>
            <strong>Matched Home:</strong> {match.matchedAddress}
          </div>
          <div style={{ color: 'var(--m-muted)', fontSize: '12px' }}>
            {match.previousMoveDetails || `Previous move date: ${match.previousMoveDate || 'N/A'}`}
          </div>
          {match.customerPhone && (
            <div style={{ color: 'var(--m-muted)', fontSize: '12px', marginTop: '2px' }}>
              <strong>Phone:</strong> {match.customerPhone}
            </div>
          )}
        </div>

        {error && (
          <div style={{
            backgroundColor: 'var(--tint-red-bg)', color: 'var(--m-red)', border: '1px solid var(--tint-red-border)',
            padding: '10px 14px', borderRadius: '4px', fontSize: '13px', marginBottom: '14px'
          }}>
            {error}
          </div>
        )}

        {sentSuccess ? (
          <div style={{
            backgroundColor: 'var(--tint-green-bg)', color: 'var(--tint-green-text)', border: '1px solid #9ae6b4',
            padding: '16px', borderRadius: '6px', textAlign: 'center', fontWeight: 600
          }}>
            ✓ Outreach email sent successfully! Status marked as Contacted.
          </div>
        ) : loadingDraft ? (
          <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--m-muted)' }}>
            Generating personalized outreach draft...
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--m-text-2)', marginBottom: '4px' }}>
                Recipient Email
              </label>
              <input
                type="email"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="customer@example.com"
                style={{
                  width: '100%', padding: '8px 12px', fontSize: '14px', borderRadius: '4px',
                  border: '1px solid var(--border-color, var(--m-border-strong))', boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--m-text-2)', marginBottom: '4px' }}>
                Subject Line
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={{
                  width: '100%', padding: '8px 12px', fontSize: '14px', borderRadius: '4px',
                  border: '1px solid var(--border-color, var(--m-border-strong))', boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ marginBottom: '18px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--m-text-2)', marginBottom: '4px' }}>
                Personalized Email Message
              </label>
              <textarea
                rows={9}
                value={messageBody}
                onChange={(e) => setMessageBody(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px', fontSize: '13px', borderRadius: '4px',
                  border: '1px solid var(--border-color, var(--m-border-strong))', boxSizing: 'border-box',
                  fontFamily: 'inherit', lineHeight: 1.5, resize: 'vertical'
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                style={{
                  padding: '8px 16px', borderRadius: '4px', border: '1px solid var(--m-border-strong)',
                  background: 'none', cursor: 'pointer', fontSize: '14px'
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={sending}
                style={{
                  padding: '8px 20px', borderRadius: '4px', border: 'none',
                  backgroundColor: '#3182ce', color: '#ffffff', cursor: 'pointer',
                  fontSize: '14px', fontWeight: 600, opacity: sending ? 0.7 : 1
                }}
              >
                {sending ? 'Sending...' : 'Send Outreach Email'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
