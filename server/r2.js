import fs from 'fs';
import https from 'https';
import path from 'path';

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const BUCKET     = process.env.R2_BUCKET_NAME || 'radical-movies-storage';
const CF_TOKEN   = process.env.CF_API_TOKEN;
const STREAM_URL = process.env.R2_STREAM_URL || 'https://radical-movies-r2.omar-c29.workers.dev';

const CF_R2_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;

export const r2Configured = !!(ACCOUNT_ID && CF_TOKEN);

// Use Node's https module directly — fetch drops large ReadStream bodies silently
const MIME = {
  '.mp4':  'video/mp4',
  '.m4v':  'video/mp4',
  '.mkv':  'video/x-matroska',
  '.webm': 'video/webm',
  '.avi':  'video/x-msvideo',
  '.mov':  'video/quicktime',
};

export function uploadToR2(localPath, key, ext, onProgress) {
  if (!r2Configured) return Promise.reject(new Error('R2 not configured'));

  const contentType = MIME[ext?.toLowerCase()] || 'video/mp4';

  return new Promise((resolve, reject) => {
    const stat    = fs.statSync(localPath);
    const total   = stat.size;
    const url     = new URL(`${CF_R2_BASE}/${encodeURIComponent(key)}`);

    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'PUT',
      headers: {
        'Authorization': `Bearer ${CF_TOKEN}`,
        'Content-Type':  contentType,
        'Content-Length': String(total),
      },
      timeout: 10 * 60 * 1000, // 10 min for very large files
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(key);
        } else {
          reject(new Error(`R2 ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('R2 upload timed out'));
    });
    req.on('error', reject);

    let uploaded = 0;
    const stream = fs.createReadStream(localPath);
    stream.on('data', (chunk) => {
      uploaded += chunk.length;
      if (onProgress) onProgress(Math.floor(uploaded / total * 100));
    });
    stream.on('error', reject);
    stream.pipe(req);
  });
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
