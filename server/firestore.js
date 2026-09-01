/**
 * Firestore connection for the ATM Scheduler backend — server/db.js talks to this instead of
 * node:sqlite now. Uses the modular firebase-admin API (`firebase-admin/app`,
 * `firebase-admin/firestore`) rather than the older `admin.firestore()` namespaced style, which
 * firebase-admin v14 no longer exposes off the default export.
 *
 * This backend runs on AWS App Runner (not Cloud Run — see server/README.md "AWS deployment" for
 * why: Cloud Run/Cloud Build/Artifact Registry all require the GCP project to be on the paid Blaze
 * plan, which the user didn't want just to host a container; Firestore itself stays on the free
 * Spark plan regardless of where the code calling it runs). App Runner has no built-in GCP identity
 * and no persistent filesystem to pre-place a downloaded key file on, so credential resolution here
 * covers three cases:
 *
 *  - **AWS App Runner (production)**: set `FIREBASE_SERVICE_ACCOUNT_JSON` to the *contents* of a
 *    downloaded service account key (Firebase console → atm-scheduler project → Project settings →
 *    Service accounts → Generate new private key), as one single-line JSON string, via an App
 *    Runner secret/env var — see server/README.md "AWS deployment" for the exact `aws secretsmanager`
 *    command. Also set `FIREBASE_PROJECT_ID=atm-scheduler`, since there's no GCP environment to
 *    infer it from on AWS.
 *  - **Local dev against the Firestore emulator**: set `FIRESTORE_EMULATOR_HOST=localhost:8080`
 *    (see .env.example) — the Admin SDK detects that env var itself and redirects every call to
 *    the emulator, no credentials needed at all.
 *  - **Local dev against REAL Firestore** (e.g. debugging live data without deploying): set
 *    `GOOGLE_APPLICATION_CREDENTIALS` to the local path of that same downloaded key file instead of
 *    pasting its contents into an env var — more convenient for a laptop, since you don't have to
 *    stringify it. Never commit that file — see .gitignore. `FIREBASE_PROJECT_ID` should be set
 *    here too.
 *
 * `FIREBASE_SERVICE_ACCOUNT_JSON` and `GOOGLE_APPLICATION_CREDENTIALS` both do the same thing (hand
 * `cert()` a service account key) — the only difference is JSON-in-an-env-var vs. JSON-in-a-file,
 * for platforms that do vs. don't give you a filesystem to put the file on. If somehow both are
 * set, the env var wins, since that's the one that actually works on App Runner.
 */

const { initializeApp, getApps, applicationDefault, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (getApps().length === 0) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || undefined;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const usingEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  // Real Cloud Run (K_SERVICE), a Cloud Functions target being invoked (FUNCTION_TARGET), or the
  // Functions emulator/CLI's own local analysis pass (FUNCTIONS_EMULATOR) — any of these mean this
  // process has its own built-in GCP identity and should use it unconditionally. This matters
  // because the Firebase CLI/emulator has been observed injecting its own GOOGLE_APPLICATION_CREDENTIALS
  // into the child process it spawns to analyze function source — pointing at a user OAuth
  // credential tied to `firebase login`, not a service account key, which crashes cert() with
  // "must contain a string project_id property" since that file has a completely different shape.
  // Trusting credPath in this context was the actual bug; ignoring it here and going straight to
  // applicationDefault() is what server/functions-index.js (Cloud Functions) has always actually
  // needed — see its own doc comment.
  const runningInFunctionsRuntime = Boolean(
    process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.FUNCTIONS_EMULATOR
  );

  const appOptions = { projectId };
  if (serviceAccountJson) {
    // AWS App Runner (or any host with no filesystem to pre-place a key file) — the key's contents
    // come in directly as an env var/secret rather than a file path.
    let parsed;
    try {
      parsed = JSON.parse(serviceAccountJson);
    } catch (err) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON — make sure the whole key file ' +
        'contents were pasted in as a single-line string, not truncated or re-escaped. ' +
        `(${err.message})`
      );
    }
    appOptions.credential = cert(parsed);
  } else if (credPath && !runningInFunctionsRuntime) {
    // Local dev against REAL Firestore with a downloaded service account key file — a bare `node
    // some-script.js` run on a laptop, not Cloud Functions/the emulator (see above).
    appOptions.credential = cert(require(credPath));
  } else if (!usingEmulator) {
    // Only reached on an actual GCP host with its own built-in identity (e.g. `gcloud auth
    // application-default login` on a developer machine, or a GCP compute product) — not the
    // normal path for this app anymore now that it runs on AWS. Deliberately skipped when the
    // emulator is active — the emulator doesn't check credentials at all, and eagerly resolving
    // real ADC here would fail local dev on a machine with no GCP credentials configured, for no
    // benefit.
    appOptions.credential = applicationDefault();
  }
  initializeApp(appOptions);
}

const db = getFirestore();
// Several job/truck/driver fields are legitimately written as `undefined` in a few code paths
// (e.g. optional SmartMoving fields not present on a given job) — ignoring them instead of
// throwing matches the old SQLite layer's behavior, where a missing key just meant "don't touch
// that column," and avoids having to null-coalesce every single field at every call site.
db.settings({ ignoreUndefinedProperties: true });

module.exports = { db };
