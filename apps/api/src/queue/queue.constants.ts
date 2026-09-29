export const INGESTION_QUEUE = "psd-ingestion";
export const RENDER_QUEUE = "psd-render";
export const ID_PHOTO_QUEUE = "id-photo-process";

export interface IngestionJobData {
  templateVersionId: string;
}

export interface RenderJobData {
  exportJobId: string;
}

export interface IdPhotoJobData {
  idPhotoJobId: string;
}
