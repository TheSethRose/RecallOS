export type JobType =
  | 'ocr'
  | 'stt'
  | 'index'
  | 'index:chunk'
  | 'ocr:chunk'
  | 'ocr:frame'
  | 'stt:chunk';

export interface JobMessage {
  id: number | string;
  type: JobType;
  payload: any;
}

export interface JobResultMessage {
  id: number | string;
  ok: boolean;
  result?: any;
  error?: string;
}
