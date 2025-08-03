// Imports
//import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

// Zod
// Structure of individual activities
const ActivitySchema = z.object({
  time: z.string(),
  description: z.string(),
  location: z.string()
});

// Structure of a day
const DaySchema = z.object({
  day: z.number().int().positive(),
  theme: z.string(),
  activities: z.array(ActivitySchema)
});

// Full itinerary structure
const ItinerarySchema = z.object({
  itinerary: z.array(DaySchema)
});

// Main section (Cloudflare worker handler)
export default {
  async fetch(request, env, ctx) {
    const { method, url } = request;
    const { pathname } = new URL(url);

    // Handle GET /status
    if (method === 'GET' && pathname.startsWith('/status/')) {
      const jobId = pathname.split('/status/')[1]; // jobId from URL
      const token = await getFirestoreAccessToken(env);
      const data = await getFirestoreDocument(jobId, token, env);
      return jsonResponse(data);
    }

    // Handle POST /
    if (method === 'POST' && pathname === '/') {
      const { destination, durationDays } = await request.json();
      const jobId = crypto.randomUUID(); // Using this instead of uuidv4 to avoid being dependant on node
      const createdAt = new Date().toISOString();

      // Document structure for Firestore
      const doc = {
        destination,
        durationDays,
        status: "processing",
        createdAt,
        completedAt: null,
        itinerary: [],
        error: null
      };

      const token = await getFirestoreAccessToken(env);
      await saveToFirestore(jobId, doc, token, env);
      ctx.waitUntil(generateItineraryAndUpdate(jobId, destination, durationDays, token, env));
      return jsonResponse({ jobId }, 202);
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function generateItineraryAndUpdate(jobId, destination, durationDays, token, env) {
  try {
    const rawItinerary = await retryWithBackoff(() =>
      callLLM(destination, durationDays, env.LLM_API_KEY)
    );

    // Validate with Zod
    const validated = ItinerarySchema.parse({ itinerary: rawItinerary });

    const completedAt = new Date().toISOString();
    await updateFirestore(jobId, {
      itinerary: validated.itinerary,
      status: "completed",
      completedAt
    }, token, env);
  } catch (err) {
    await updateFirestore(jobId, {
      status: "failed",
      error: err.message,
      completedAt: new Date().toISOString()
    }, token, env);
  }
}

// Retrying in case of failures
async function retryWithBackoff(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err; // Last retry
      // Wait with exponential backoff before next attempt
      await new Promise(res => setTimeout(res, delay * (2 ** i)));
    }
  }
}

async function callLLM(destination, durationDays, apiKey) {
  // Prompt to LLM
  const prompt = `
Generate a ${durationDays}-day travel itinerary for ${destination}.
Return only valid JSON matching this format:
{
  "itinerary": [
    {
      "day": 1,
      "theme": "string",
      "activities": [
        {
          "time": "string",
          "description": "string",
          "location": "string"
        }
      ]
    }
  ]
}
Only return the JSON. No explanation or prose.
  `.trim();

  // API request to OpenAI
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    })
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || "OpenAI API error");

  // Parse the itinerary from the LLM response
  const parsed = JSON.parse(json.choices[0].message.content);
  return parsed.itinerary;
}

/*
 * Cloudflare Workers can’t use Node crypto libraries, so I use Google’s JWT OAuth2 flow manually by crafting a JWT and exchanging it for an access token.
 */
async function getFirestoreAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: env.CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, // Token expire limit is an hour
    iat: now
  };

  const toBase64Url = (obj) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unsignedJWT = `${toBase64Url(header)}.${toBase64Url(claimSet)}`;

  // Importing the private key
  const key = await crypto.subtle.importKey(
    'pkcs8',
    strToArrayBuffer(env.PRIVATE_KEY.replace(/\\n/g, '\n')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Sign the JWT 
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedJWT)
  );

  const signedJWT = `${unsignedJWT}.${arrayBufferToBase64Url(signature)}`;

  // Exchange JWT
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJWT
    })
  });

  const data = await tokenRes.json();
  if (!data.access_token) throw new Error("Failed to get Firestore access token");
  return data.access_token;
}

async function saveToFirestore(jobId, doc, token, env) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.PROJECT_ID}/databases/(default)/documents/itineraries?documentId=${jobId}`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: toFirestoreFields(doc) })
  });
}

async function updateFirestore(jobId, updates, token, env) {
  const fieldPaths = Object.keys(updates).map(f => `updateMask.fieldPaths=${f}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${env.PROJECT_ID}/databases/(default)/documents/itineraries/${jobId}?${fieldPaths}`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: toFirestoreFields(updates) })
  });
}

async function getFirestoreDocument(jobId, token, env) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.PROJECT_ID}/databases/(default)/documents/itineraries/${jobId}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  if (!res.ok) throw new Error("Document not found");
  const json = await res.json();
  return fromFirestoreFields(json.fields || {});
}

// Some util functions
function strToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\n/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64Url(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// JS object to Firestore field
function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj)) {
    fields[key] = toValue(val);
  }
  return fields;
}

// JS value to Firestore value
function toValue(val) {
  if (val === null) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') return { integerValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Array.isArray(val)) return {
    arrayValue: { values: val.map(toValue) }
  };
  if (typeof val === 'object') return {
    mapValue: { fields: toFirestoreFields(val) }
  };
  throw new Error("Unsupported Firestore value: " + typeof val);
}

// Firestore fields to JS objects
function fromFirestoreFields(fields) {
  const obj = {};
  for (const [key, val] of Object.entries(fields)) {
    obj[key] = fromValue(val);
  }
  return obj;
}

// Firestore value to JS value
function fromValue(val) {
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return parseInt(val.integerValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(fromValue);
  if ('mapValue' in val) return fromFirestoreFields(val.mapValue.fields || {});
  return null;
}

// JSON response with CORS headers
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

