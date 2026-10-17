/* Localhost uses the local Node API; the deployed site uses the Render API.
   Provider buttons stay hidden until their OAuth credentials are configured. */
window.HRS_AUTH_CONFIG = {
  apiUrl: window.location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://hrs-portal-api.onrender.com",
  providers: {
    google: false,
    linkedin_oidc: false
  }
};
