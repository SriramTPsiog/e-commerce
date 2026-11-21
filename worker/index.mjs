import { purchase, CheckoutError } from "./checkout.mjs";
import { restStore } from "./firestore-rest.mjs";

const oauthUrl = "https://oauth2.googleapis.com/token";
const encoder = new TextEncoder();
let cachedToken;

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/, "");
}

async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken?.expiry > now + 60) return cachedToken.value;
  const service = JSON.parse(env.FIRESTORE_SERVICE_ACCOUNT);
  if (service.project_id !== env.FIREBASE_PROJECT_ID) throw Error("Wrong service account project.");
  const pem = service.private_key.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const encode = value => base64url(encoder.encode(JSON.stringify(value)));
  const claims = encode({ iss: service.client_email, scope: "https://www.googleapis.com/auth/datastore",
    aud: oauthUrl, iat: now, exp: now + 3600 });
  const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + claims;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  const response = await fetch(oauthUrl, { method: "POST", body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: unsigned + "." + base64url(new Uint8Array(signature))
  }) });
  const token = await response.json();
  if (!response.ok || !token.access_token) throw Error("Service account authentication failed.");
  cachedToken = { value: token.access_token, expiry: now + Number(token.expires_in) };
  return cachedToken.value;
}

async function authenticatedUid(request, env) {
  const idToken = (request.headers.get("Authorization") || "").match(/^Bearer (\S+)$/)?.[1];
  if (!idToken) throw new CheckoutError("unauthenticated", "Sign in before placing an order.");
  const url = new URL("https://identitytoolkit.googleapis.com/v1/accounts:lookup");
  url.searchParams.set("key", env.FIREBASE_WEB_API_KEY);
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }) });
  const data = await response.json();
  if (response.status === 400 && /^(INVALID_ID_TOKEN|TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND|INVALID_USER_TOKEN)/.test(data.error?.message || "")) {
    throw new CheckoutError("unauthenticated", "Sign in again before retrying.");
  }
  if (!response.ok) throw Error("Firebase identity lookup failed.");
  const user = data.users?.[0];
  if (!user?.localId || user.disabled) throw new CheckoutError("unauthenticated", "Sign in again before retrying.");
  return user.localId;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (origin !== env.SHOP_ORIGIN) return new Response("Origin not allowed", { status: 403 });
    const headers = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
      Vary: "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/checkout")
      return new Response("Not found", { status: 404, headers });
    try {
      const uid = await authenticatedUid(request, env);
      let body;
      try { body = await request.json(); } catch {
        throw new CheckoutError("invalid-argument", "Checkout must be valid JSON.");
      }
      const result = await purchase(restStore(env.FIREBASE_PROJECT_ID, () => accessToken(env)), uid, body);
      return Response.json(result, { headers });
    } catch (error) {
      if (!(error instanceof CheckoutError)) {
        console.error("Checkout failed:", error.message);
        return Response.json({code:"unavailable",message:"Checkout could not be confirmed."},{status:503,headers});
      }
      return Response.json({code:error.code,message:error.message},{status:400,headers});
    }
  }
};
