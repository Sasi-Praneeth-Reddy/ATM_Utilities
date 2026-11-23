// Read-only wrapper over the Map endpoint (server/mapview.js). Any signed-in user may call it.
import { apiCall } from '../../api';

/** kind: 'local' | 'ld'; date: YYYY-MM-DD. */
export const fetchMapJobs = (backendUrl, date, kind) => apiCall(backendUrl, 'GET', `/api/map/jobs?date=${date}&kind=${kind}`);
