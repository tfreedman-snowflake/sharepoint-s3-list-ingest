// src/s3.js
import "dotenv/config";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

let s3Client;

function getS3Client() {
  if (s3Client) return s3Client;

  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!region) {
    throw new Error("AWS_REGION must be set in .env");
  }

  // AWS SDK will automatically use credentials from environment variables
  // or from IAM role if running on EC2/ECS/Lambda
  const config = { region };

  // Only add explicit credentials if provided (otherwise use IAM role)
  if (accessKeyId && secretAccessKey) {
    config.credentials = {
      accessKeyId,
      secretAccessKey
    };
  }

  s3Client = new S3Client(config);
  return s3Client;
}

/**
 * Upload a file to S3
 * @param {string} key - S3 object key (path)
 * @param {Buffer|string} body - File content
 * @param {string} contentType - MIME type (optional)
 * @returns {Promise<void>}
 */
export async function uploadToS3(key, body, contentType = "application/octet-stream") {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET must be set in .env");
  }

  const client = getS3Client();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType
  });

  await client.send(command);
}

/**
 * Upload JSON data to S3
 * @param {string} key - S3 object key (path)
 * @param {object} data - JSON object to upload
 * @returns {Promise<void>}
 */
export async function uploadJSONToS3(key, data) {
  const jsonString = JSON.stringify(data, null, 2);
  await uploadToS3(key, jsonString, "application/json");
}

/**
 * Download a file from S3
 * @param {string} key - S3 object key (path)
 * @returns {Promise<Buffer>}
 */
export async function downloadFromS3(key) {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET must be set in .env");
  }

  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key
  });

  const response = await client.send(command);
  
  // Convert stream to buffer
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Check if an object exists in S3
 * @param {string} key - S3 object key (path)
 * @returns {Promise<boolean>}
 */
export async function checkS3ObjectExists(key) {
  const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
  
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET must be set in .env");
  }

  const client = getS3Client();
  const command = new HeadObjectCommand({
    Bucket: bucket,
    Key: key
  });

  try {
    await client.send(command);
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

