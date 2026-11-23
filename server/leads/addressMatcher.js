/**
 * server/leads/addressMatcher.js
 *
 * High-precision US Address Normalization and Matching Engine.
 * 
 * Normalizes variations in US addresses (abbreviations, directional words, unit/apt
 * identifiers, punctuation, casing) to detect when a USA Home Listing matches:
 * 1. An existing SmartMoving / Firestore booked/completed job (origin or destination).
 * 2. An imported legacy customer record.
 */

// Common US directional normalization
const DIRECTIONALS = {
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  northeast: 'ne',
  northwest: 'nw',
  southeast: 'se',
  southwest: 'sw',
  n: 'n',
  s: 's',
  e: 'e',
  w: 'w',
  ne: 'ne',
  nw: 'nw',
  se: 'se',
  sw: 'sw',
};

// Common US street type abbreviations
const STREET_TYPES = {
  street: 'st',
  st: 'st',
  str: 'st',
  avenue: 'ave',
  ave: 'ave',
  av: 'ave',
  road: 'rd',
  rd: 'rd',
  drive: 'dr',
  dr: 'dr',
  boulevard: 'blvd',
  blvd: 'blvd',
  lane: 'ln',
  ln: 'ln',
  court: 'ct',
  ct: 'ct',
  circle: 'cir',
  cir: 'cir',
  place: 'pl',
  pl: 'pl',
  parkway: 'pkwy',
  pkwy: 'pkwy',
  way: 'way',
  terrace: 'ter',
  ter: 'ter',
  trail: 'trl',
  trl: 'trl',
  highway: 'hwy',
  hwy: 'hwy',
  loop: 'loop',
  run: 'run',
  path: 'path',
  square: 'sq',
  sq: 'sq',
  crossing: 'xing',
  xing: 'xing',
  pike: 'pike',
};

// Secondary unit keywords (matches apt, suite, unit, #4B, etc.)
const UNIT_REGEX = /(?:#|\b(?:apt|apartment|suite|ste|unit|lot|bldg|building|fl|floor|dept|room|rm)\b)[\s#.:-]*([a-z0-9\-]+)?/i;

/**
 * Extract 5-digit ZIP code.
 */
function extractZipCode(textOrZip) {
  if (!textOrZip) return '';
  const s = String(textOrZip).trim();
  const m = s.match(/\b\d{5}\b/);
  return m ? m[0] : '';
}

/**
 * Clean city name.
 */
function normalizeCity(city) {
  if (!city || typeof city !== 'string') return '';
  return city.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Clean 2-letter state code.
 */
function normalizeState(state) {
  if (!state || typeof state !== 'string') return '';
  const s = state.trim().toUpperCase();
  if (s.length === 2) return s;
  const STATE_NAMES = {
    virginia: 'VA',
    maryland: 'MD',
    'district of columbia': 'DC',
    washington: 'DC',
    delaware: 'DE',
    pennsylvania: 'PA',
    'west virginia': 'WV',
    colorado: 'CO',
  };
  return STATE_NAMES[state.toLowerCase().trim()] || s.slice(0, 2);
}

/**
 * Clean and standardize a street address string.
 * Returns an object with normalized base street, unit if present, and full normalized string.
 */
function normalizeStreetAddress(rawStreet) {
  if (!rawStreet || typeof rawStreet !== 'string') {
    return { baseStreet: '', unit: '', raw: '' };
  }

  // If comma separated (e.g. "1420 Larimer St, Denver, CO"), check for street part
  let streetPart = rawStreet;
  if (rawStreet.includes(',')) {
    const parts = rawStreet.split(',');
    if (/\d/.test(parts[0])) {
      streetPart = parts[0];
    }
  }

  let clean = streetPart
    .toLowerCase()
    .replace(/[,\.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let unit = '';
  const unitMatch = clean.match(UNIT_REGEX);
  if (unitMatch) {
    unit = unitMatch[0].trim();
    clean = clean.replace(unitMatch[0], ' ').replace(/\s+/g, ' ').trim();
  }

  const tokens = clean.split(' ').filter(Boolean);
  const normalizedTokens = tokens.map((token, index) => {
    if ((index === 1 || index === tokens.length - 1) && DIRECTIONALS[token]) {
      return DIRECTIONALS[token];
    }
    if (STREET_TYPES[token]) {
      return STREET_TYPES[token];
    }
    const numMatch = token.match(/^(\d+)(st|nd|rd|th)$/);
    if (numMatch) {
      return numMatch[1];
    }
    return token;
  });

  const baseStreet = normalizedTokens.join(' ').trim();
  return {
    baseStreet,
    unit,
    raw: rawStreet.trim(),
  };
}

/**
 * Build primary and secondary comparison keys for an address.
 */
function buildAddressKeys({ street, zip, city, state }) {
  const norm = normalizeStreetAddress(street);
  let zip5 = extractZipCode(zip || street);
  let cleanCity = normalizeCity(city);
  let cleanState = normalizeState(state);

  // If city/state/zip not provided separately, attempt to parse from street string
  if ((!cleanCity || !cleanState || !zip5) && street && street.includes(',')) {
    const parts = street.split(',').map((p) => p.trim());
    if (parts.length >= 2) {
      if (!cleanCity && parts.length >= 3) {
        cleanCity = normalizeCity(parts[1]);
      }
      const lastPart = parts[parts.length - 1];
      if (!zip5) zip5 = extractZipCode(lastPart);
      if (!cleanState) {
        const stateMatch = lastPart.match(/\b([A-Za-z]{2})\b/);
        if (stateMatch) cleanState = normalizeState(stateMatch[1]);
      }
    }
  }

  const primaryKey = norm.baseStreet && zip5 ? `${norm.baseStreet}|${zip5}` : null;
  const secondaryKey = norm.baseStreet && cleanCity && cleanState ? `${norm.baseStreet}|${cleanCity}|${cleanState}` : null;

  return {
    baseStreet: norm.baseStreet,
    unit: norm.unit,
    zip5,
    city: cleanCity,
    state: cleanState,
    primaryKey,
    secondaryKey,
  };
}

/**
 * Check if two address key sets match.
 * Returns { isMatch: boolean, confidence: number, matchReason: string }
 */
function compareAddressKeys(keysA, keysB) {
  if (!keysA || !keysB) return { isMatch: false, confidence: 0, matchReason: '' };
  if (!keysA.baseStreet || !keysB.baseStreet) return { isMatch: false, confidence: 0, matchReason: '' };

  // If base streets don't match, definitely not a match
  if (keysA.baseStreet !== keysB.baseStreet) {
    return { isMatch: false, confidence: 0, matchReason: '' };
  }

  // 1. Exact base street + 5-digit ZIP match (100% confidence)
  if (keysA.primaryKey && keysB.primaryKey && keysA.primaryKey === keysB.primaryKey) {
    return {
      isMatch: true,
      confidence: 100,
      matchReason: `Exact street & ZIP match (${keysA.zip5})`,
    };
  }

  // 2. Exact base street + City + State match (95% confidence)
  if (keysA.secondaryKey && keysB.secondaryKey && keysA.secondaryKey === keysB.secondaryKey) {
    return {
      isMatch: true,
      confidence: 95,
      matchReason: `Exact street, city & state match (${keysA.city}, ${keysA.state})`,
    };
  }

  // 3. Both have ZIPs, but they conflict
  if (keysA.zip5 && keysB.zip5 && keysA.zip5 !== keysB.zip5) {
    if (keysA.zip5.slice(0, 4) === keysB.zip5.slice(0, 4)) {
      return {
        isMatch: true,
        confidence: 85,
        matchReason: `Street match with neighboring ZIP (${keysA.zip5} vs ${keysB.zip5})`,
      };
    }
    // Conflicting distant ZIPs -> not a match
    return { isMatch: false, confidence: 0, matchReason: 'Conflicting ZIP codes' };
  }

  // 4. One or both sides lack ZIP/city, but base street is identical
  return {
    isMatch: true,
    confidence: 85,
    matchReason: `Base street address matched (${keysA.baseStreet})`,
  };
}

/**
 * Scan a single USA Home Listing against lists of:
 * - SmartMoving/Firestore jobs
 * - Legacy customer records
 *
 * Returns array of match objects.
 */
function findMatchesForListing(listing, { jobs = [], legacyCustomers = [] }) {
  const listingKeys = buildAddressKeys({
    street: listing.address,
    zip: listing.zipCode || listing.zip_code || listing.zip,
    city: listing.city,
    state: listing.state,
  });

  if (!listingKeys.baseStreet) return [];

  const matches = [];

  // 1. Scan SmartMoving/Firestore jobs
  for (const job of jobs) {
    // Check destination first (customer moved INTO this home — now it's listed!)
    if (job.destination) {
      const destKeys = buildAddressKeys({ street: job.destination, zip: job.destinationZip });
      const comp = compareAddressKeys(listingKeys, destKeys);
      if (comp.isMatch) {
        matches.push({
          sourceType: 'smartmoving_job',
          sourceId: job.id,
          customerName: job.customer || 'Unknown Customer',
          customerEmail: job.email || null,
          customerPhone: job.phone || null,
          matchedAddress: listing.address,
          matchedType: 'moved_to',
          previousMoveDate: job.date || null,
          previousMoveDetails: `Moved into this property on ${job.date || 'past move'}. Origin: ${job.origin || 'N/A'}`,
          confidence: comp.confidence,
          matchReason: comp.matchReason,
          listing,
        });
        continue; // Matched destination; move to next job
      }
    }

    // Check origin (customer moved OUT of this home)
    if (job.origin) {
      const originKeys = buildAddressKeys({ street: job.origin, zip: job.originZip });
      const comp = compareAddressKeys(listingKeys, originKeys);
      if (comp.isMatch) {
        matches.push({
          sourceType: 'smartmoving_job',
          sourceId: job.id,
          customerName: job.customer || 'Unknown Customer',
          customerEmail: job.email || null,
          customerPhone: job.phone || null,
          matchedAddress: listing.address,
          matchedType: 'moved_from',
          previousMoveDate: job.date || null,
          previousMoveDetails: `Moved from this property on ${job.date || 'past move'}. Destination: ${job.destination || 'N/A'}`,
          confidence: comp.confidence,
          matchReason: comp.matchReason,
          listing,
        });
      }
    }
  }

  // 2. Scan Legacy Customer records
  for (const leg of legacyCustomers) {
    const targetAddr = leg.destinationAddress || leg.address || leg.originAddress;
    if (!targetAddr) continue;

    const legKeys = buildAddressKeys({
      street: targetAddr,
      zip: leg.zip || leg.zipCode,
      city: leg.city,
      state: leg.state,
    });

    const comp = compareAddressKeys(listingKeys, legKeys);
    if (comp.isMatch) {
      matches.push({
        sourceType: 'legacy_customer',
        sourceId: leg.id,
        customerName: leg.name || 'Legacy Customer',
        customerEmail: leg.email || null,
        customerPhone: leg.phone || null,
        matchedAddress: listing.address,
        matchedType: leg.destinationAddress ? 'moved_to' : 'legacy_record',
        previousMoveDate: leg.moveDate || leg.date || null,
        previousMoveDetails: `Legacy move recorded on ${leg.moveDate || 'past record'}`,
        confidence: comp.confidence,
        matchReason: comp.matchReason,
        listing,
      });
    }
  }

  return matches;
}

module.exports = {
  normalizeStreetAddress,
  extractZipCode,
  normalizeCity,
  normalizeState,
  buildAddressKeys,
  compareAddressKeys,
  findMatchesForListing,
};
