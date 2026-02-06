export interface TranscriptItem {
  id: string;
  text: string;
  isPartial: boolean;
  timestamp: Date;
  speaker: 'user' | 'model';
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}

export interface AudioVisualizerProps {
  stream: MediaStream | null;
  isRecording: boolean;
}
