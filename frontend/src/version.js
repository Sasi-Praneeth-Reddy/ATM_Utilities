// Single source of truth for the version users see (sidebar footer, login screen, What's New).
// The number comes from frontend/package.json — bump it THERE for each release, and add a matching
// entry at the top of src/data/releaseNotes.js. Convention: MAJOR = a big redesign of the UI
// (1 = the original scheduler, 2 = the ATM Hub CRM shell), MINOR = new features, PATCH = fixes.
import { version } from '../package.json';

export const APP_NAME = 'ATM Hub';
export const APP_VERSION = version;
export const SUPPORT_EMAIL = 'atm.sspr@gmail.com';
export const CREDIT = 'Designed, developed and maintained by Sasi';
export const CREATOR_URL = 'https://sasi.is-a.dev/';
