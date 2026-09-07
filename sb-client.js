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
 * Sign-in uses invited email/password accounts. Disable public signup in
 * Supabase Auth; frontend controls are not an authorization boundary.
 */

export const SUPABASE_URL = "https://jbqjzkzhmybzruzcppjs.supabase.co";
export const SUPABASE_KEY = "sb_publishable_CBpCpkJbE3mM5eU6sUdAzA_nrum1kRX";
export const DB_SCHEMA = "vocab";

if (!window.supabase) {
  throw new Error("supabase.min.js must load before sb-client.js");
}

// Capture the callback type before the SDK consumes the URL fragment.
let needsPassword = ["invite", "recovery"].includes(
  new URLSearchParams(location.hash.slice(1)).get("type"),
);

export const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  // Every table this app touches lives in the `vocab` schema, so we point the
  // client at it once instead of prefixing every query.
  db: { schema: DB_SCHEMA },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // consume invitation and recovery callbacks
  },
});

let session = null;
const listeners = new Set();

/** The signed-in user, or null. */
export function currentUser() {
  return session?.user ?? null;
}

/**
 * The current access token, or null.
 *
 * Synchronous on purpose: the study log posts its last batch from a
 * `pagehide` handler, where there is no time left to await `getSession()`.
 * The SDK keeps `session` fresh through `onAuthStateChange`, so this is the
 * same token its own requests would use.
 */
export function accessToken() {
  return session?.access_token ?? null;
}

/** Subscribe to sign-in/sign-out. Fires immediately with the current state. */
export function onAuthChange(callback) {
  listeners.add(callback);
  callback(currentUser());
  return () => listeners.delete(callback);
}

/** Sign in with an existing account. Raises Supabase authentication errors. */
export async function signIn(email, password) {
  const { error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw error;
}

/** Set the signed-in user's password. Raises validation or Supabase errors. */
export async function setPassword(password, confirmation) {
  if (!currentUser()) throw new Error("Open your invitation or recovery link first.");
  if (!password || password !== confirmation) {
    throw new Error("Enter matching passwords.");
  }
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
  needsPassword = false;
}

export async function signOut() {
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Header account button
// ---------------------------------------------------------------------------

function injectButton() {
  const controls = document.querySelector(".app-header .header-tools");
  if (!controls) return; // page has no standard header — skip silently

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-ghost account-btn";
  btn.title = "Study record account";
  btn.setAttribute("aria-label", "Study record account");
  controls.append(btn);

  const paint = (user) => {
    btn.innerHTML = `<svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg><span>${user ? "Account" : "Sign in"}</span>`;
    btn.classList.toggle("signed-in", Boolean(user));
  };
  onAuthChange(paint);

  const dialog = document.createElement("dialog");
  dialog.className = "account-dialog";
  dialog.setAttribute("aria-labelledby", "account-title");
  dialog.innerHTML = `
    <form>
      <h2 id="account-title"></h2>
      <p class="account-hint"></p>
      <label class="account-email">Invited email
        <input name="email" type="email" autocomplete="username" required>
      </label>
      <label>Password
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
      <label class="account-confirm">Confirm password
        <input name="confirmation" type="password" autocomplete="new-password">
      </label>
      <p class="account-error" role="alert"></p>
      <button type="submit">Sign in</button>
      <button type="button" class="account-cancel">Cancel</button>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form");
  const email = form.elements.namedItem("email");
  const password = form.elements.namedItem("password");
  const confirmation = form.elements.namedItem("confirmation");
  const submit = form.querySelector('[type="submit"]');
  const error = form.querySelector(".account-error");
  let settingPassword = false;
  let busy = false;
  const open = (setup) => {
    if (dialog.open) return;
    settingPassword = setup;
    form.reset();
    error.textContent = "";
    form.querySelector("h2").textContent = setup ? "Set password" : "Sign in";
    form.querySelector(".account-hint").textContent = setup
      ? "Choose a password for future email sign-ins."
      : "Use your invited email and password. For access or password recovery, contact the administrator.";
    form.querySelector(".account-email").hidden = setup;
    email.disabled = setup;
    form.querySelector(".account-confirm").hidden = !setup;
    confirmation.required = setup;
    confirmation.disabled = !setup;
    password.autocomplete = setup ? "new-password" : "current-password";
    submit.textContent = setup ? "Save password" : "Sign in";
    dialog.showModal();
    (setup ? password : email).focus();
  };
  const cancel = dialog.querySelector(".account-cancel");
  cancel.onclick = () => dialog.close();
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener("close", () => form.reset());
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    submit.disabled = true;
    cancel.disabled = true;
    error.textContent = "";
    try {
      if (settingPassword) await setPassword(password.value, confirmation.value);
      else await signIn(email.value, password.value);
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
      password.value = "";
      confirmation.value = "";
      password.focus();
    } finally {
      busy = false;
      submit.disabled = false;
      cancel.disabled = false;
    }
  };
  btn.onclick = async () => {
    const user = currentUser();
    if (user && !needsPassword) {
      if (confirm(`Signed in as ${user.email}\n\nSign out?`)) {
        try { await signOut(); }
        catch (err) { alert(`Could not sign out: ${err.message}`); }
      }
      return;
    }
    open(Boolean(user && needsPassword));
  };
  onAuthChange((user) => {
    if (user && needsPassword) open(true);
    else if (!user && dialog.open && settingPassword) dialog.close();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const notify = () => listeners.forEach((cb) => cb(currentUser()));

client.auth.onAuthStateChange((event, next) => {
  if (event === "PASSWORD_RECOVERY") needsPassword = true;
  session = next;
  notify();
});

// getSession() resolves after the SDK has restored a stored session (and after
// it has consumed an invitation/recovery hash), so the first paint is not a false signed-out state.
const { data } = await client.auth.getSession();
session = data.session;
notify();

injectButton();
