/* Localhost uses the local Node API. Netlify replaces this with its same-origin function URL.
   Provider buttons stay hidden until their OAuth credentials are configured. */
window.HRS_AUTH_CONFIG = {
  apiUrl: window.location.hostname === "localhost" ? "http://localhost:3000" : "",
  providers: {
    google: false,
    linkedin_oidc: false
  }
};
