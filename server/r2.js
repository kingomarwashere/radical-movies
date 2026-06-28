import fs from 'fs';
import https from 'https';
import path from 'path';

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const BUCKET     = process.env.R2_BUCKET_NAME || 'radical-movies-storage';
const CF_TOKEN   = process.env.CF_API_TOKEN;
const STREAM_URL = process.env.R2_STREAM_URL || 'https://radical-movies-r2.omar-c29.workers.dev';

const CF_R2_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;

export const r2Configured = !!(ACCOUNT_ID && CF_TOKEN);

const MIME = {
  '.mp4':  'video/mp4',
  '.m4v':  'video/mp4',
  '.mkv':  'video/x-matroska',
  '.webm': 'video/webm',
  '.avi':  'video/x-msvideo',
  '.mov':  'video/quicktime',
};

// CF REST API single-PUT limit is ~100MB — use multipart for anything larger
const PART_SIZE = 64 * 1024 * 1024; // 64 MB

export function uploadToR2(localPath, key, ext, onProgress) {
  if (!r2Configured) return Promise.reject(new Error('R2 not configured'));

  const contentType = MIME[ext?.toLowerCase()] || 'video/mp4';
  const total = fs.statSync(localPath).size;

  console.log(`[r2] upload: ${path.basename(localPath)} — ${(total/1e9).toFixed(2)} GB — ${contentType}`);

  return total <= PART_SIZE
    ? singlePart(localPath, key, contentType, total, onProgress)
    : multipart(localPath, key, contentType, total, onProgress);
}

// ── Single-part (files ≤ 64 MB) ────────────────────────────────────────────
function singlePart(localPath, key, contentType, total, onProgress) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CF_R2_BASE}/${encodeURIComponent(key)}`);

    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'PUT',
      headers: {
        'Authorization': `Bearer ${CF_TOKEN}`,
        'Content-Type':  contentType,
        'Content-Length': String(total),
      },
      timeout: 10 * 60 * 1000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(key);
        else reject(new Error(`R2 ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('R2 upload timed out')); });
    req.on('error', reject);

    let uploaded = 0;
    const stream = fs.createReadStream(localPath);
    stream.on('data', chunk => {
      uploaded += chunk.length;
      onProgress?.(Math.floor(uploaded / total * 100));
    });
    stream.on('error', reject);
    stream.pipe(req);
  });
}

// ── Multipart (files > 64 MB) ───────────────────────────────────────────────
async function multipart(localPath, key, contentType, total, onProgress) {
  const base = `${CF_R2_BASE}/${encodeURIComponent(key)}`;

  // 1. Create upload
  const createRes = await cfFetch(`${base}/mfpu/create`, { method: 'POST' });
  if (!createRes.ok) throw new Error(`R2 multipart create failed: ${createRes.status}: ${await createRes.text()}`);
  const { uploadId } = await createRes.json();
  console.log(`[r2] multipart upload started: ${uploadId}`);

  const parts = [];
  const numParts = Math.ceil(total / PART_SIZE);
  let uploaded = 0;

  try {
    for (let i = 0; i < numParts; i++) {
      const partNumber = i + 1;
      const offset     = i * PART_SIZE;
      const chunkSize  = Math.min(PART_SIZE, total - offset);

      const chunk = await readChunk(localPath, offset, chunkSize);

      console.log(`[r2] uploading part ${partNumber}/${numParts} (${(chunkSize/1e6).toFixed(0)} MB)`);

      const partRes = await cfFetch(
        `${base}/mfpu/${uploadId}?partNumber=${partNumber}`,
        {
          method: 'PUT',
          headers: { 'Content-Length': String(chunkSize), 'Content-Type': contentType },
          body: chunk,
        }
      );
      if (!partRes.ok) throw new Error(`R2 part ${partNumber} failed: ${partRes.status}: ${await partRes.text()}`);

      const { etag } = await partRes.json();
      parts.push({ partNumber, etag });

      uploaded += chunkSize;
      onProgress?.(Math.floor(uploaded / total * 100));
    }

    // 3. Complete
    const completeRes = await cfFetch(
      `${base}/mfpu/${uploadId}/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts }),
      }
    );
    if (!completeRes.ok) throw new Error(`R2 complete failed: ${completeRes.status}: ${await completeRes.text()}`);

    console.log(`[r2] multipart upload complete: ${key}`);
    return key;

  } catch (err) {
    // Abort on failure so R2 doesn't keep the incomplete upload
    console.error('[r2] aborting multipart upload due to error:', err.message);
    await cfFetch(`${base}/mfpu/${uploadId}`, { method: 'DELETE' }).catch(() => {});
    throw err;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function cfFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${CF_TOKEN}`,
      ...(opts.headers || {}),
    },
  });
}

function readChunk(filePath, offset, length) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(length);
    const fd  = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, length, offset);
      resolve(buf);
    } catch (e) {
      reject(e);
    } finally {
      fs.closeSync(fd);
    }
  });
}

export function getStreamUrl(key) {
  return `${STREAM_URL}/${encodeURIComponent(key)}`;
}

export async function deleteFromR2(key) {
  if (!r2Configured) return;
  await cfFetch(`${CF_R2_BASE}/${encodeURIComponent(key)}`, { method: 'DELETE' });
}
