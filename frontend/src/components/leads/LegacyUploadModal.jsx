import { useState } from 'react';
import { importLegacyCustomers } from './leadsApi';

export default function LegacyUploadModal({ backendUrl, onClose, onImported }) {
  const [csvText, setCsvText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV must contain a header row and at least one data row.');

    // Simple CSV row parser handling quotes
    function parseLine(line) {
      const row = [];
      let inQuotes = false;
      let cur = '';
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          inQuotes = !inQuotes;
        } else if (c === ',' && !inQuotes) {
          row.push(cur.trim());
          cur = '';
        } else {
          cur += c;
        }
      }
      row.push(cur.trim());
      return row;
    }

    const headers = parseLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const vals = parseLine(lines[i]);
      if (vals.length === 0 || (vals.length === 1 && !vals[0])) continue;
      const rowObj = {};
      headers.forEach((h, idx) => {
        rowObj[h] = vals[idx] || '';
      });

      // Map common column variations
      const name = rowObj.name || rowObj.customername || rowObj.client || rowObj.customer || '';
      const email = rowObj.email || rowObj.emailaddress || '';
      const phone = rowObj.phone || rowObj.phonenumber || rowObj.mobile || '';
      const destination = rowObj.destination || rowObj.destinationaddress || rowObj.movingto || rowObj.to || rowObj.address || '';
      const origin = rowObj.origin || rowObj.originaddress || rowObj.movingfrom || rowObj.from || '';
      const date = rowObj.date || rowObj.movedate || rowObj.servicedate || '';
      const city = rowObj.city || '';
      const state = rowObj.state || '';
      const zip = rowObj.zip || rowObj.zipcode || '';

      if (name || destination || origin) {
        rows.push({
          name,
          email,
          phone,
          destinationAddress: destination,
          originAddress: origin,
          moveDate: date,
          city,
          state,
          zip,
        });
      }
    }

    return rows;
  }

  function handleFileChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      setCsvText(evt.target.result || '');
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!csvText.trim()) {
      setError('Please paste CSV content or select a file to import.');
      return;
    }
    setError('');
    setUploading(true);
    try {
      const records = parseCsv(csvText);
      if (records.length === 0) {
        throw new Error('No valid customer records found in input.');
      }
      const res = await importLegacyCustomers(backendUrl, records);
      setResult(res);
      if (onImported) onImported();
      setTimeout(() => {
        onClose();
      }, 1800);
    } catch (err) {
      setError(err.message || 'Import failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px'
    }}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{
        backgroundColor: 'var(--bg-card, #ffffff)', color: 'var(--text-main, #1a202c)',
        borderRadius: '8px', maxWidth: '580px', width: '100%', maxHeight: '90vh',
        overflowY: 'auto', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)', padding: '24px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
            Import Historical Legacy Customers
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--m-muted)' }}>
            ✕
          </button>
        </div>

        <p style={{ fontSize: '13px', color: 'var(--m-muted)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
          Upload past customer move records from a CSV spreadsheet. The system will index their home addresses and automatically run address matching against all USA Home Listings.
        </p>

        {error && (
          <div style={{
            backgroundColor: 'var(--tint-red-bg)', color: 'var(--m-red)', border: '1px solid var(--tint-red-border)',
            padding: '10px 14px', borderRadius: '4px', fontSize: '13px', marginBottom: '14px'
          }}>
            {error}
          </div>
        )}

        {result ? (
          <div style={{
            backgroundColor: 'var(--tint-green-bg)', color: 'var(--tint-green-text)', border: '1px solid #9ae6b4',
            padding: '16px', borderRadius: '6px', textAlign: 'center', fontWeight: 600
          }}>
            ✓ Successfully imported {result.imported} legacy customer records! Reconciling address matches...
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--m-text-2)', marginBottom: '6px' }}>
                Select CSV File
              </label>
              <input
                type="file"
                accept=".csv,.txt"
                onChange={handleFileChange}
                style={{ fontSize: '13px' }}
              />
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--m-text-2)', marginBottom: '6px' }}>
                Or Paste CSV Content
              </label>
              <textarea
                rows={7}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder="Name,Email,Phone,Moving To,Moving From,Service Date&#10;John Smith,john@example.com,703-555-0100,123 Main St Fairfax VA,456 Oak Rd Reston VA,2024-06-15"
                style={{
                  width: '100%', padding: '10px 12px', fontSize: '12px', borderRadius: '4px',
                  border: '1px solid var(--border-color, var(--m-border-strong))', boxSizing: 'border-box',
                  fontFamily: 'monospace', lineHeight: 1.4, resize: 'vertical'
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={uploading}
                style={{
                  padding: '8px 16px', borderRadius: '4px', border: '1px solid var(--m-border-strong)',
                  background: 'none', cursor: 'pointer', fontSize: '14px'
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={uploading}
                style={{
                  padding: '8px 20px', borderRadius: '4px', border: 'none',
                  backgroundColor: '#2b6cb0', color: '#ffffff', cursor: 'pointer',
                  fontSize: '14px', fontWeight: 600, opacity: uploading ? 0.7 : 1
                }}
              >
                {uploading ? 'Importing & Matching...' : 'Import & Match'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
