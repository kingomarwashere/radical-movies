import fs from 'fs';
import path from 'path';

const ACCOUNT_ID  = process.env.R2_ACCOUNT_ID;
const BUCKET      = process.env.R2_BUCKET_NAME || 'radical-movies-storage';
const CF_TOKEN    = process.env.CF_API_TOKEN;
const STREAM_URL  = process.env.R2_STREAM_URL  || 'https://radical-movies-r2.omar-c29.workers.dev';
const UPLOAD_URL  = process.env.R2_UPLOAD_URL  || STREAM_URL;

const UPLOAD_SECRET = 'rmupload2026xk';
const PART_SIZE     = 64 * 1024 * 1024; // 64 MB — well under Worker 100MB request limit

export const r2Configured = !!(ACCOUNT_ID && CF_TOKEN);

const MIME = {
  '.mp4':  'video/mp4',
  '.m4v':  'video/mp4',
  '.mkv':  'video/x-matroska',
  '.webm': 'video/webm',
  '.avi':  'video/x-msvideo',
  '.mov':  'video/quicktime',
};

// ── Stream upload: SFTP (or any Readable) → R2 multipart, no local disk ─────
export async function uploadStreamToR2(readable, totalSize, key, ext, onProgress) {
  if (!r2Configured) throw new Error('R2 not configured');

  const contentType = MIME[ext?.toLowerCase()] || 'video/mp4';
  console.log(`[r2] stream upload: ${key} — ${(totalSize/1e9).toFixed(2)} GB`);

  const baseUrl = `${UPLOAD_URL}/upload`;
  const params  = (extra = {}) => `${baseUrl}?${new URLSearchParams({ key, ...extra })}`;
  const headers = { 'x-upload-secret': UPLOAD_SECRET };

  const createRes = await fetch(params({ action: 'create', contentType }), {
    method: 'POST', headers,
  });
  if (!createRes.ok) throw new Error(`R2 create failed: ${createRes.status}: ${await createRes.text()}`);
  const { uploadId } = await createRes.json();

  const parts    = [];
  let   partNum  = 0;
  let   uploaded = 0;
  let   buf      = Buffer.alloc(0);

  async function flushPart(chunk) {
    partNum++;
    console.log(`[r2] part ${partNum} (${(chunk.length/1e6).toFixed(0)} MB)`);
    const res = await fetch(params({ action: 'part', uploadId, partNumber: String(partNum) }), {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: chunk,
    });
    if (!res.ok) throw new Error(`R2 part ${partNum} failed: ${res.status}: ${await res.text()}`);
    const { etag } = await res.json();
    parts.push({ partNumber: partNum, etag });
    uploaded += chunk.length;
    onProgress?.(Math.floor(uploaded / totalSize * 100));
  }

  try {
    for await (const chunk of readable) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      while (buf.length >= PART_SIZE) {
        await flushPart(buf.slice(0, PART_SIZE));
        buf = buf.slice(PART_SIZE);
      }
    }
    if (buf.length > 0) await flushPart(buf);

    const completeRes = await fetch(params({ action: 'complete', uploadId }), {
      method:  'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body:    JSON.stringify({ parts }),
    });
    if (!completeRes.ok) throw new Error(`R2 complete failed: ${completeRes.status}: ${await completeRes.text()}`);

    console.log(`[r2] stream upload complete: ${key}`);
    return key;
  } catch (err) {
    await fetch(params({ action: 'abort', uploadId }), { method: 'DELETE', headers }).catch(() => {});
    throw err;
  }
}

// ── Upload via R2 Worker (supports R2 multipart natively) ───────────────────
export async function uploadToR2(localPath, key, ext, onProgress) {
  if (!r2Configured) throw new Error('R2 not configured');

  const contentType = MIME[ext?.toLowerCase()] || 'video/mp4';
  const total       = fs.statSync(localPath).size;

  console.log(`[r2] uploading via Worker: ${path.basename(localPath)} — ${(total/1e9).toFixed(2)} GB`);

  const baseUrl = `${UPLOAD_URL}/upload`;
  const params  = (extra = {}) => {
    const p = new URLSearchParams({ key, ...extra });
    return `${baseUrl}?${p}`;
  };
  const headers = { 'x-upload-secret': UPLOAD_SECRET };

  // 1. Create multipart upload
  const createRes = await fetch(params({ action: 'create', contentType }), {
    method: 'POST', headers,
  });
  if (!createRes.ok) throw new Error(`R2 create failed: ${createRes.status}: ${await createRes.text()}`);
  const { uploadId } = await createRes.json();
  console.log(`[r2] multipart started: ${uploadId}`);

  const parts    = [];
  const numParts = Math.ceil(total / PART_SIZE);
  let   uploaded = 0;

  try {
    for (let i = 0; i < numParts; i++) {
      const partNumber = i + 1;
      const offset     = i * PART_SIZE;
      const chunkSize  = Math.min(PART_SIZE, total - offset);
      const chunk      = await readChunk(localPath, offset, chunkSize);

      console.log(`[r2] part ${partNumber}/${numParts} (${(chunkSize/1e6).toFixed(0)} MB)`);

      const partRes = await fetch(params({ action: 'part', uploadId, partNumber: String(partNumber) }), {
        method:  'PUT',
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        body:    chunk,
      });
      if (!partRes.ok) throw new Error(`R2 part ${partNumber} failed: ${partRes.status}: ${await partRes.text()}`);

      const { etag } = await partRes.json();
      parts.push({ partNumber, etag });

      uploaded += chunkSize;
      onProgress?.(Math.floor(uploaded / total * 100));
    }

    // 3. Complete
    const completeRes = await fetch(params({ action: 'complete', uploadId }), {
      method:  'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body:    JSON.stringify({ parts }),
    });
    if (!completeRes.ok) throw new Error(`R2 complete failed: ${completeRes.status}: ${await completeRes.text()}`);

    console.log(`[r2] upload complete: ${key}`);
    return key;

  } catch (err) {
    // Abort incomplete upload
    await fetch(params({ action: 'abort', uploadId }), { method: 'DELETE', headers }).catch(() => {});
    throw err;
  }
}

function readChunk(filePath, offset, length) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(length);
    const fd  = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, length, offset);
      resolve(buf);
    } catch (e) { reject(e); }
    finally    { fs.closeSync(fd); }
  });
}

export function getStreamUrl(key) {
  return `${STREAM_URL}/${encodeURIComponent(key)}`;
}

export async function deleteFromR2(key) {
  if (!r2Configured) return;
  const CF_R2_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;
  await fetch(`${CF_R2_BASE}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${CF_TOKEN}` },
  });
}
