import fs from 'fs';
import path from 'path';

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const BUCKET     = process.env.R2_BUCKET_NAME || 'radical-movies-storage';
const CF_TOKEN   = process.env.CF_API_TOKEN;
const STREAM_URL = process.env.R2_STREAM_URL || 'https://radical-movies-r2.omar-c29.workers.dev';

const CF_R2_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;

export const r2Configured = !!(ACCOUNT_ID && CF_TOKEN);

export async function uploadToR2(localPath, key) {
  if (!r2Configured) throw new Error('R2 not configured');

  const stat = fs.statSync(localPath);
  const body = fs.createReadStream(localPath);

  const res = await fetch(`${CF_R2_BASE}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_TOKEN}`,
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
    },
    body,
    duplex: 'half',
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`R2 upload failed ${res.status}: ${err}`);
  }

  return key;
}

export function getStreamUrl(key) {
  return `${STREAM_URL}/${encodeURIComponent(key)}`;
}

export async function deleteFromR2(key) {
  if (!r2Configured) return;
  await fetch(`${CF_R2_BASE}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${CF_TOKEN}` },
  });
}
