/* Market News · Supabase session layer
 *
 * SINGLE SOURCE OF TRUTH for "who is signed in". It owns the Supabase client,
 * the sign-in flow, and the account button it injects into the page header —
 * the same self-contained pattern as voice-prefs.js, so a page opts in with
 * one <script type="module"> tag and nothing else.
 *
 * On keys: the URL and publishable key below are PUBLIC by design and ship in
 * the published repo. They grant nothing on their own — every row is gated by
 * row level security in Postgres. The secret/service_role key must never
 * appear in this folder.
 *
 * On sign-in: magic link only (no passwords to store or leak) and
 * `shouldCreateUser: false`, so the guest list is exactly the users invited
 * from the Supabase dashboard. A stranger who finds this page cannot get in.
 */

export const SUPABASE_URL = "https://jbqjzkzhmybzruzcppjs.supabase.co";
export const SUPABASE_KEY = "sb_publishable_CBpCpkJbE3mM5eU6sUdAzA_nrum1kRX";
export const DB_SCHEMA = "vocab";

if (!window.supabase) {
  throw new Error("supabase.min.js must load before sb-client.js");
}

export const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  // Every table this app touches lives in the `vocab` schema, so we point the
  // client at it once instead of prefixing every query.
  db: { schema: DB_SCHEMA },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // consume the #access_token the magic link returns
  },
});

let session = null;
const listeners = new Set();

/** The signed-in user, or null. */
export function currentUser() {
  return session?.user ?? null;
}

/** Subscribe to sign-in/sign-out. Fires immediately with the current state. */
export function onAuthChange(callback) {
  listeners.add(callback);
  callback(currentUser());
  return () => listeners.delete(callback);
}

/**
 * Email a one-time sign-in link for this page.
 *
 * Raises whatever Supabase returns; "Signups not allowed" is the expected
 * error for an address that was never invited.
 */
export async function signIn(email) {
  const redirect = `${location.origin}${location.pathname}`;
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirect, shouldCreateUser: false },
  });
  if (error) throw error;
}

export async function signOut() {
  await client.auth.signOut();
}

// ---------------------------------------------------------------------------
// Header account button
// ---------------------------------------------------------------------------

function injectButton() {
  const controls = document.querySelector(".app-header .controls");
  if (!controls) return; // page has no standard header — skip silently

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-ghost account-btn";
  btn.title = "Study record account";
  btn.setAttribute("aria-label", "Study record account");
  controls.append(btn);

  const paint = (user) => {
    btn.textContent = user ? "👤" : "🔒";
    btn.classList.toggle("signed-in", Boolean(user));
  };
  onAuthChange(paint);

  btn.onclick = async () => {
    const user = currentUser();
    if (user) {
      if (confirm(`Signed in as ${user.email}\n\nSign out?`)) await signOut();
      return;
    }
    const email = prompt("Email for your study record:\n(invited addresses only)");
    if (!email) return;
    try {
      await signIn(email.trim());
      alert("Check your inbox — the sign-in link is on its way. ✉️");
    } catch (err) {
      alert(`Could not sign in: ${err.message}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const notify = () => listeners.forEach((cb) => cb(currentUser()));

client.auth.onAuthStateChange((_event, next) => {
  session = next;
  notify();
});

// getSession() resolves after the SDK has restored a stored session (and after
// it has consumed a magic-link hash), so the first paint is not a false "🔒".
const { data } = await client.auth.getSession();
session = data.session;
notify();

injectButton();
