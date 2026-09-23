export const INGESTION_QUEUE = "psd-ingestion";
export const RENDER_QUEUE = "psd-render";

export interface IngestionJobData {
  templateVersionId: string;
}

export interface RenderJobData {
  exportJobId: string;
}
