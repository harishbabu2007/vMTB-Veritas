import { supabase } from '../Supabase/client';

const API_BASE = 'https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_UPLOAD_BYTES = 2_000_000; // 2 MB

async function getAuthHeader(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('You must be logged in to do this.');
  return `Bearer ${token}`;
}

interface PresignedUpload {
  bucket: string;
  key: string;
  url: string;
  fields: Record<string, string>;
}

async function requestUploadUrl(contentType: string): Promise<PresignedUpload> {
  const authHeader = await getAuthHeader();
  const response = await fetch(`${API_BASE}/get-profile-photo-upload-url`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content_type: contentType }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || 'Failed to prepare photo upload.');
  }
  return data as PresignedUpload;
}

/**
 * Uploads a profile photo to S3 via a short-lived, identity-scoped presigned
 * POST, then returns the S3 key to persist on profiles.avatar_key.
 */
export async function uploadProfilePhoto(file: File): Promise<string> {
  if (!ALLOWED_CONTENT_TYPES.includes(file.type)) {
    throw new Error('Please choose a JPG, PNG, GIF, or WEBP image.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('Image must be 2MB or smaller.');
  }

  const presigned = await requestUploadUrl(file.type);

  const formData = new FormData();
  for (const [key, value] of Object.entries(presigned.fields)) {
    if (key === 'key') continue;
    formData.append(key, value);
  }
  formData.append('key', presigned.key);
  formData.append('file', file);

  const uploadResponse = await fetch(presigned.url, {
    method: 'POST',
    body: formData,
  });

  if (!uploadResponse.ok && uploadResponse.status !== 204) {
    throw new Error('Failed to upload photo. Please try again.');
  }

  return presigned.key;
}

/**
 * Resolves a fresh, short-lived presigned GET URL for a stored avatar key.
 * Never cache this URL beyond its ~15 minute lifetime — callers should
 * re-request it periodically (see useAvatarUrl).
 */
export async function getProfilePhotoViewUrl(avatarKey: string): Promise<string> {
  const authHeader = await getAuthHeader();
  const response = await fetch(
    `${API_BASE}/get-profile-photo-view-url?key=${encodeURIComponent(avatarKey)}`,
    {
      method: 'GET',
      headers: { Authorization: authHeader },
    }
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || 'Failed to load profile photo.');
  }
  return data.url as string;
}
