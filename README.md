# Stak-task Travel Itinerary Generator

This is a Cloudflare Worker-based API that generates travel itineraries for a specified destination and duration using an LLM (Large Language Model) and stores the results in Google Cloud Firestore. The project uses Zod for schema validation and implements a OAuth 2.0 flow for Firestore authentication.

## Features
- **POST /**: Accepts a destination and duration to initiate itinerary generation, returning a unique `jobId`.
- **GET /status/{jobId}**: Retrieves the status and results of an itinerary generation job.
- **Asynchronous Processing**: Uses Cloudflare Workers' `waitUntil` for non-blocking itinerary generation.
- **Data Validation**: Enforces strict schema validation with Zod.
- **Firestore Integration**: Stores and retrieves itinerary data securely.
- **Retry Logic**: Implements exponential backoff for LLM API calls to handle transient failures.

## Prerequisites
- **Node.js**: Version 18 or higher for local development.
- **Cloudflare Account**: Required for deploying the Worker.
- **Google Cloud Project**: With Firestore enabled and a service account for authentication.
- **OpenAI API Key**: For generating itineraries via the LLM.
- **Wrangler CLI**: For deploying and managing the Cloudflare Worker (`npm install -g wrangler`).

## Setup Instructions

### 1. Clone the Repository
```bash
git clone <repository-url>
cd <repository-directory>
```

### 2. Install Dependencies
Install the required Node.js packages:
```bash
npm install zod
```

Note: The `uuid` package is not required as the code uses `crypto.randomUUID()` for UUID generation.

### 3. Configure Environment Variables
Create a `.env` file in the project root or configure environment variables in your Cloudflare Worker dashboard. The following variables are required:

- `PROJECT_ID`: Your Google Cloud project ID (e.g., `my-travel-project`).
- `CLIENT_EMAIL`: The service account email for Firestore access (e.g., `service-account@my-travel-project.iam.gserviceaccount.com`).
- `PRIVATE_KEY`: The private key for the service account, including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` markers. Replace newlines with `\n` if setting via the Cloudflare dashboard.
- `LLM_API_KEY`: Your OpenAI API key for accessing the `gpt-4o` model.

Example `.env` file:
```plaintext
PROJECT_ID=my-travel-project
CLIENT_EMAIL=service-account@my-travel-project.iam.gserviceaccount.com
PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----
LLM_API_KEY=sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

To set variables in Cloudflare:
```bash
wrangler secret put PROJECT_ID
wrangler secret put CLIENT_EMAIL
wrangler secret put PRIVATE_KEY
wrangler secret put LLM_API_KEY
```

### 4. Configure Firestore
- In the Google Cloud Console, create a Firestore database in your project (Native mode recommended).
- Create a service account with the `Cloud Datastore User` role (`roles/datastore.user`).
- Download the service account key JSON and extract the `client_email` and `private_key` fields for the environment variables.
- Ensure the `itineraries` collection is accessible (it will be created automatically when documents are saved).

### 5. Deploy the Cloudflare Worker
- Log in to Cloudflare Wrangler:
  ```bash
  wrangler login
  ```
- Deploy the Worker:
  ```bash
  wrangler deploy
  ```
- Note the deployed Worker URL (e.g., `https://your-worker.workers.dev`).

### 6. Test the API
Use the examples below to test the API endpoints.

## API Usage

### POST / (Create Itinerary Job)
Initiates a new itinerary generation job.

**cURL Example**:
```bash
curl -X POST https://your-worker.workers.dev/ \
     -H "Content-Type: application/json" \
     -d '{"destination":"Paris, France","durationDays":3}'
```

**JavaScript Fetch Example**:
```javascript
async function createItinerary() {
  const response = await fetch('https://your-worker.workers.dev/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination: 'Paris, France', durationDays: 3 })
  });
  const data = await response.json();
  console.log(data); // { jobId: "uuid" }
}
createItinerary();
```

**Response**:
- Status: `202 Accepted`
- Body: `{ "jobId": "<uuid>" }`

### GET /status/{jobId} (Check Job Status)
Retrieves the status and results of an itinerary generation job.

**cURL Example**:
```bash
curl https://your-worker.workers.dev/status/<jobId>
```

**JavaScript Fetch Example**:
```javascript
async function checkStatus(jobId) {
  const response = await fetch(`https://your-worker.workers.dev/status/${jobId}`);
  const data = await response.json();
  console.log(data); // { destination, durationDays, status, itinerary, ... }
}
checkStatus('<jobId>');
```

**Response**:
- Status: `200 OK` (if found) or `404 Not Found`
- Body: `{ destination, durationDays, status, createdAt, completedAt, itinerary, error }`

## Architectural Choices
- **Cloudflare Workers**: Chosen for serverless execution, low latency, and global distribution. The `waitUntil` method enables asynchronous itinerary generation without blocking the response.
- **Firestore**: Used for persistent storage due to its scalability, real-time capabilities, and integration with Google Cloud’s authentication system.
- **Zod for Validation**: Ensures the LLM’s output conforms to a strict schema, preventing malformed data from being stored.
- **OAuth 2.0 with JWT**: Implements a secure, manual JWT signing process for Firestore access, avoiding reliance on Node.js-specific libraries in the Cloudflare environment.
- **Retry with Backoff**: Handles transient LLM API failures with exponential backoff to improve reliability.
- **Web Crypto API**: Uses `crypto.randomUUID()` for job ID generation, eliminating the need for external UUID libraries.

## Prompt Design
The LLM prompt is designed to ensure consistent, structured output:
- **Explicit JSON Format**: The prompt specifies a precise JSON structure matching the `ItinerarySchema` (days with themes and activities), reducing parsing errors.
- **No Prose**: Instructs the LLM to return only JSON, avoiding extraneous text that could break parsing.
- **Clear Instructions**: Specifies the destination and duration, ensuring the LLM generates relevant itineraries.
- **Temperature 0.7**: Balances creativity and consistency in itinerary generation.

Example Prompt:
```
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

Only return this JSON. No markdown, no prose.

```

## Troubleshooting
- **Firestore Errors**: Ensure the service account has the `roles/datastore.user` role and the `PROJECT_ID`, `CLIENT_EMAIL`, and `PRIVATE_KEY` are correct.
- **LLM API Errors**: Verify the `LLM_API_KEY` is valid and the OpenAI API is accessible.
- **404 on /status/{jobId}**: Confirm the `jobId` exists in Firestore (check the `itineraries` collection in the Google Cloud Console).
- **CORS Issues**: The API includes `Access-Control-Allow-Origin: *` to allow cross-origin requests.

## Cloudflare Pages 
1. **Push your project to GitHub**

   > For example mine is [stak-task-ui](https://github.com/so7en7/stak-task-ui/)

2. **Create a Cloudflare Pages project**

   - Go to `Cloudflare Pages Dashboard`
   - Click **Create a project**
   - Select your GitHub repo
   - Click **"Begin setup"**

3. **Configure build settings**

   - **Framework preset:** `None`
   - **Build command:**

     ```bash
     cd stak-task-ui && npm install && npm run build
     ```

   - **Output directory:**

     ```
     stak-task-ui/build
     ```
   - **Note: These might change based on what framework you are using this is for sveltekit!**
4. **Deploy**

   Click **Save and Deploy**. The first build will take a few minutes.

