export const MAX_CHAT_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_CHAT_BODY_BYTES = 17 * 1024 * 1024;
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

export interface ChatImageInput { name: string; data_url: string }
export interface ModelImage { data_url: string }
export interface ChatImage {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  width: number;
  height: number;
  url: string;
}
