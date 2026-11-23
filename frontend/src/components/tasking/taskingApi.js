// Thin wrappers over the Tasking REST endpoints (server/tasking.js, docs/TASKING.md).
// All calls need a logged-in admin/dispatcher/owner/developer; the server enforces that.
import { apiCall } from '../../api';

export const fetchSummary = (backendUrl, date) => apiCall(backendUrl, 'GET', `/api/tasking/summary?date=${date}`);
export const fetchDispatch = (backendUrl, date) => apiCall(backendUrl, 'GET', `/api/tasking/dispatch?date=${date}`);
export const refreshFromSmartMoving = (backendUrl) => apiCall(backendUrl, 'POST', '/api/tasking/refresh');
// patch = any of: callDone, callAssignee, pbo, upsellStatus, upsellNote, upsellDue, dispatchNote, materials, crates
// Imports SmartMoving job notes + materials/crates for one day (1 Premium API call per job).
export const importDispatchFromSmartMoving = (backendUrl, date) => apiCall(backendUrl, 'POST', '/api/tasking/dispatch-refresh', { date });
export const saveJobState = (backendUrl, jobId, patch) => apiCall(backendUrl, 'PUT', `/api/tasking/job/${encodeURIComponent(jobId)}`, patch);
export const saveDayState = (backendUrl, date, patch) => apiCall(backendUrl, 'PUT', `/api/tasking/day/${date}`, patch);
export const sendAssignments = (backendUrl, date, to) => apiCall(backendUrl, 'POST', '/api/tasking/send-assignments', { date, to });

// Job Materials report: check Gmail now, or upload the .xlsx by hand (dataBase64 = file bytes, base64).
export const checkMaterialsEmail = (backendUrl) => apiCall(backendUrl, 'POST', '/api/tasking/materials-sync');
export const uploadMaterialsReport = (backendUrl, filename, dataBase64) => apiCall(backendUrl, 'POST', '/api/tasking/materials-upload', { filename, dataBase64 });
