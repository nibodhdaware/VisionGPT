import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const ENDPOINT = process.env.R2_ENDPOINT;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET_NAME;

const r2Configured = !!(ENDPOINT && ACCESS_KEY && SECRET_KEY && BUCKET);

let r2: S3Client | null = null;
if (r2Configured) {
  r2 = new S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: ACCESS_KEY!, secretAccessKey: SECRET_KEY! },
  });
}

export function isR2Configured() {
  return r2Configured;
}

export async function uploadToR2(key: string, body: Buffer, contentType: string) {
  if (!r2 || !BUCKET) return key;
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body, ContentType: contentType,
  }));
  return key;
}

export async function getFromR2(key: string): Promise<Buffer | null> {
  if (!r2 || !BUCKET) return null;
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return Buffer.from(await result.Body!.transformToByteArray());
  } catch {
    return null;
  }
}

export async function deleteFromR2(key: string) {
  if (!r2 || !BUCKET) return;
  await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

const PUBLIC_URL = process.env.R2_PUBLIC_URL;

export function r2PublicUrl(key: string) {
  if (PUBLIC_URL) return `${PUBLIC_URL}/${key}`;
  if (ENDPOINT && BUCKET) return `https://${BUCKET}.${new URL(ENDPOINT).hostname}/${key}`;
  return null;
}
