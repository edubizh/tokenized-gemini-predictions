// A hint, kept in localStorage, that this browser was logged in on its last visit. An inline
// script copies it onto <html> before first paint so a returning user never sees the logged-out
// landing page flash by while the login state loads. It grants nothing; it only chooses which
// placeholder to paint.

export const SESSION_HINT_KEY = "outcome.session";

export const SESSION_HINT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(SESSION_HINT_KEY)}))document.documentElement.dataset.session="1"}catch(e){}`;

export function setSessionHint(loggedIn: boolean): void {
  try {
    if (loggedIn) {
      localStorage.setItem(SESSION_HINT_KEY, "1");
      document.documentElement.dataset.session = "1";
    } else {
      localStorage.removeItem(SESSION_HINT_KEY);
      delete document.documentElement.dataset.session;
    }
  } catch {
    // Storage can be unavailable; the hint is optional.
  }
}
