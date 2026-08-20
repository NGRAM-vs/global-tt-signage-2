// Cloudflare R2 file storage — R2 speaks the S3 API, so the standard AWS
// SDK works against it with just a custom endpoint. Uploaded content never
// touches this server's own disk beyond a brief temp file during the
// upload itself; the actual files live entirely in R2.

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

// Uploads a local temp file to R2 under the given key and returns its
// public URL. The caller is responsible for deleting the temp file after.
async function uploadFile(tempPath, key, contentType) {
  const stats = fs.statSync(tempPath);
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: fs.createReadStream(tempPath),
    ContentType: contentType,
    ContentLength: stats.size
  }));
  return R2_PUBLIC_URL + "/" + key;
}

async function deleteFile(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

module.exports = { uploadFile, deleteFile };
