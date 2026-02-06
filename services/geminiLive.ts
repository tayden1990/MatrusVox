import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { TranscriptItem } from "../types";

export class GeminiLiveService {
  private ai: GoogleGenAI;
  private session: any = null; // Using any because LiveSession type isn't fully exported in all contexts easily
  private inputAudioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  
  // Transcription State
  private currentInputTranscription = "";
  private onTranscriptionUpdate: (item: TranscriptItem) => void;
  private onStatusChange: (status: boolean) => void;
  private onError: (error: string) => void;

  constructor(
    onTranscriptionUpdate: (item: TranscriptItem) => void,
    onStatusChange: (status: boolean) => void,
    onError: (error: string) => void
  ) {
    this.ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    this.onTranscriptionUpdate = onTranscriptionUpdate;
    this.onStatusChange = onStatusChange;
    this.onError = onError;
  }

  public async connect() {
    try {
      this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
      });

      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const config = {
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: this.handleOnOpen.bind(this),
          onmessage: this.handleOnMessage.bind(this),
          onclose: this.handleOnClose.bind(this),
          onerror: this.handleOnError.bind(this),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {}, // Request user transcription
          systemInstruction: "You are a passive transcriber. Do not speak. Just listen and wait for the next input.",
        },
      };

      const sessionPromise = this.ai.live.connect(config);
      this.session = await sessionPromise;
      
      // We pass the promise to the audio processor setup to ensure synchronization
      this.setupAudioProcessing(sessionPromise);
      
      this.onStatusChange(true);
    } catch (error: any) {
      console.error("Connection failed:", error);
      this.onError(error.message || "Failed to connect to Gemini Live Service");
      this.disconnect();
    }
  }

  public disconnect() {
    if (this.session) {
      // session.close() might not be available on the raw promise wrapper depending on SDK version, 
      // but usually the session object has a close method.
      try {
        // @ts-ignore
        this.session.close();
      } catch (e) {
        console.warn("Error closing session", e);
      }
    }

    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
    }
    if (this.source) {
      this.source.disconnect();
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
    if (this.inputAudioContext) {
      this.inputAudioContext.close();
    }

    this.session = null;
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.inputAudioContext = null;
    this.currentInputTranscription = "";
    this.onStatusChange(false);
  }

  public getStream(): MediaStream | null {
    return this.stream;
  }

  private setupAudioProcessing(sessionPromise: Promise<any>) {
    if (!this.inputAudioContext || !this.stream) return;

    this.source = this.inputAudioContext.createMediaStreamSource(this.stream);
    this.processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const pcmBlob = this.createBlob(inputData);
      
      sessionPromise.then((session) => {
        session.sendRealtimeInput({ media: pcmBlob });
      });
    };

    this.source.connect(this.processor);
    this.processor.connect(this.inputAudioContext.destination);
  }

  private handleOnOpen() {
    console.log("Gemini Live Session Opened");
  }

  private handleOnMessage(message: LiveServerMessage) {
    // Handle User Transcription (Input)
    if (message.serverContent?.inputTranscription) {
      const text = message.serverContent.inputTranscription.text;
      if (text) {
        this.currentInputTranscription += text;
        this.emitTranscription(true);
      }
    }

    // Handle Turn Complete (User finished speaking)
    if (message.serverContent?.turnComplete) {
      if (this.currentInputTranscription.trim()) {
        this.emitTranscription(false); // Finalize
        this.currentInputTranscription = ""; // Reset buffer
      }
    }
  }

  private emitTranscription(isPartial: boolean) {
     this.onTranscriptionUpdate({
       id: isPartial ? "current-turn" : Date.now().toString(),
       text: this.currentInputTranscription,
       isPartial: isPartial,
       timestamp: new Date(),
       speaker: 'user'
     });
  }

  private handleOnClose(e: CloseEvent) {
    console.log("Session closed", e);
    this.disconnect();
  }

  private handleOnError(e: ErrorEvent) {
    console.error("Session error", e);
    this.onError("Connection error occurred.");
    this.disconnect();
  }

  // --- Audio Utilities ---

  private createBlob(data: Float32Array): any {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      // Clamp values to [-1, 1] to prevent overflow/distortion before converting
      const s = Math.max(-1, Math.min(1, data[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return {
      data: this.encode(new Uint8Array(int16.buffer)),
      mimeType: 'audio/pcm;rate=16000',
    };
  }

  private encode(bytes: Uint8Array): string {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
