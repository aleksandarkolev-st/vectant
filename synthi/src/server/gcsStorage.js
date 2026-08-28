import { Storage } from '@google-cloud/storage';

function explicitCredentials() {
  const clientEmail = process.env.GCP_CLIENT_EMAIL;
  const privateKey = process.env.GCP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) return undefined;
  return { client_email: clientEmail, private_key: privateKey };
}

export function createGcsStorage() {
  const options = {};
  const projectId =
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT;
  const credentials = explicitCredentials();

  if (projectId) options.projectId = projectId;
  if (credentials) options.credentials = credentials;

  return new Storage(options);
}

export function getGcsBucketName(fallback = '') {
  return process.env.GCS_BUCKET_NAME || fallback;
}
