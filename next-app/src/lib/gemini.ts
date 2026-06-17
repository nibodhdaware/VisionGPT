import fs from "fs";
import os from "os";
import path from "path";

function setupGcpCredentials() {
  let json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const b64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
  if (!json && b64) json = Buffer.from(b64, "base64").toString("utf-8");
  if (json && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credsPath = path.join(os.tmpdir(), "gcp-credentials.json");
    if (!fs.existsSync(credsPath)) fs.writeFileSync(credsPath, json);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath;
  }
}
setupGcpCredentials();

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const isVertex = process.env.VERTEX_AI === "true" || process.env.VERTEX_AI === "1";
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const API_KEY = process.env.GEMINI_API_KEY;

async function getAccessToken(): Promise<string> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token || "";
}

async function vertexRequest(parts: any[], jsonMode: boolean) {
  const token = await getAccessToken();
  const url =
    `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

  const body: any = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.15, maxOutputTokens: 4096 },
  };
  if (jsonMode) body.generationConfig.responseMimeType = "application/json";

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();

  // Check for blocked / error responses
  if (data?.promptFeedback?.blockReason) {
    throw new Error(data.promptFeedback.blockReasonMessage || "blocked");
  }
  if (!resp.ok) {
    const apiErr = data?.error?.message || JSON.stringify(data).slice(0, 300);
    throw new Error(`Vertex AI: ${apiErr}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text && data?.candidates?.[0]?.finishReason && data?.candidates?.[0]?.finishReason !== "STOP") {
    throw new Error(`finish_reason: ${data.candidates[0].finishReason}`);
  }
  return text || null;
}

async function apiKeyRequest(parts: any[], jsonMode: boolean) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const body: any = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.15, maxOutputTokens: 4096 },
  };
  if (jsonMode) body.generationConfig.responseMimeType = "application/json";

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();

  if (data?.promptFeedback?.blockReason) {
    throw new Error(data.promptFeedback.blockReasonMessage || "blocked");
  }
  if (!resp.ok) {
    const apiErr = data?.error?.message || JSON.stringify(data).slice(0, 300);
    throw new Error(`Gemini API: ${apiErr}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text && data?.candidates?.[0]?.finishReason && data?.candidates?.[0]?.finishReason !== "STOP") {
    throw new Error(`finish_reason: ${data.candidates[0].finishReason}`);
  }
  return text || null;
}

export async function generateContent(
  parts: { text?: string; inlineData?: { mimeType: string; data: string } }[],
  jsonMode = false,
) {
  try {
    const apiParts = parts.map((p) => {
      if (p.inlineData) return { inlineData: { mimeType: p.inlineData.mimeType, data: p.inlineData.data } };
      return { text: p.text || "" };
    });

    if (isVertex && PROJECT) {
      const text = await vertexRequest(apiParts, jsonMode);
      if (!text) return { text: null, error: "gemini_no_text" };
      return { text: text.trim(), error: null };
    }
    if (API_KEY) {
      const text = await apiKeyRequest(apiParts, jsonMode);
      if (!text) return { text: null, error: "gemini_no_text" };
      return { text: text.trim(), error: null };
    }
    return { text: null, error: "no_credentials: set VERTEX_AI=true + GOOGLE_CLOUD_PROJECT or GEMINI_API_KEY" };
  } catch (err: any) {
    const msg = (err?.message || String(err)).slice(0, 400);
    console.error("generateContent error:", msg);
    return { text: null, error: msg };
  }
}

export function parseJson(text: string): Record<string, any> | null {
  const match = text.match(/(?:```(?:json)?\s*)?({[\s\S]*?})(?:\s*```)?/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
