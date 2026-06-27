import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';

export const r2Configured = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY
);

const BUCKET = process.env.R2_BUCKET_NAME || 'radical-movies-storage';

let s3 = null;
if (r2Configured) {
  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

export async function uploadToR2(localPath, key) {
  if (!s3) throw new Error('R2 not configured');

  const body = fs.createReadStream(localPath);
  const size = fs.statSync(localPath).size;

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentLength: size,
    ContentType: 'video/mp4',
  }));

  return key;
}

export async function getSignedStreamUrl(key) {
  if (!s3) return null;
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: 86400 });
}
