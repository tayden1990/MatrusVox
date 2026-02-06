import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GeminiLiveService } from './services/geminiLive';
import AudioVisualizer from './components/AudioVisualizer';
import { TranscriptItem, ConnectionState } from './types';
import { GoogleGenAI } from "@google/genai";

const App: React.FC = () => {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [currentText, setCurrentText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [isCopied, setIsCopied] = useState(false);
  
  // Ref for the service to persist across renders
  const liveService = useRef<GeminiLiveService | null>(null);
  // Ref for auto-scrolling
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  // Ref for file input
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize service on mount (but don't connect yet)
  useEffect(() => {
    liveService.current = new GeminiLiveService(
      handleTranscriptionUpdate,
      handleStatusChange,
      handleError
    );

    return () => {
      if (liveService.current) {
        liveService.current.disconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts, currentText, isUploading]);

  const handleTranscriptionUpdate = useCallback((item: TranscriptItem) => {
    if (item.isPartial) {
      setCurrentText(item.text);
    } else {
      setTranscripts(prev => [...prev, item]);
      setCurrentText(""); // Clear partial buffer once finalized
    }
  }, []);

  const handleStatusChange = useCallback((isConnected: boolean) => {
    setConnectionState(isConnected ? ConnectionState.CONNECTED : ConnectionState.DISCONNECTED);
    if (isConnected && liveService.current) {
      setAudioStream(liveService.current.getStream());
      setError(null);
    } else {
      setAudioStream(null);
    }
  }, []);

  const handleError = useCallback((errMessage: string) => {
    setError(errMessage);
    setConnectionState(ConnectionState.ERROR);
  }, []);

  const toggleRecording = async () => {
    if (connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.CONNECTING) {
      liveService.current?.disconnect();
    } else {
      setConnectionState(ConnectionState.CONNECTING);
      await liveService.current?.connect();
    }
  };

  const copyToClipboard = async () => {
    const fullText = transcripts.map(t => t.text).join('\n') + (currentText ? '\n' + currentText : '');
    if (!fullText.trim()) return;

    try {
      await navigator.clipboard.writeText(fullText);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy transcript", err);
      setError("Failed to copy to clipboard");
    }
  };

  const clearTranscripts = () => {
    if (transcripts.length === 0 && !currentText) return;
    
    if(window.confirm("Are you sure you want to clear the transcript?")) {
        setTranscripts([]);
        // Only clear currentText if we are NOT connected. 
        // If connected, the live service maintains the buffer and will restore it on next update anyway.
        if (connectionState !== ConnectionState.CONNECTED) {
            setCurrentText("");
        }
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setError(null);
    setUploadStatus("Preparing...");

    // Disconnect live session if active to prevent conflicts or noise
    if (connectionState === ConnectionState.CONNECTED) {
       liveService.current?.disconnect();
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      let contentPart: any;

      if (file.size < 20 * 1024 * 1024) {
        // For smaller files, use inline data (faster)
        setUploadStatus("Processing audio...");
        const base64Data = await fileToBase64(file);
        contentPart = {
          inlineData: {
            mimeType: file.type,
            data: base64Data
          }
        };
      } else {
        // For larger files, use the Files API
        setUploadStatus("Uploading large file...");
        try {
            const uploadResponse = await ai.files.upload({
                file: file,
                config: { 
                    mimeType: file.type,
                    displayName: file.name
                }
            });

            // Robustly handle response structure (response.file vs response directly)
            // @ts-ignore - Inspecting response structure dynamically
            const fileResult = uploadResponse.file || uploadResponse;

            if (!fileResult || !fileResult.uri) {
                console.error("Unexpected upload response structure:", uploadResponse);
                throw new Error("Upload failed: No file URI returned from server.");
            }

            let fileUri = fileResult.uri;
            let state = fileResult.state;
            const fileName = fileResult.name;

            setUploadStatus("Processing file on server...");
            
            // Wait for file processing
            while (state === 'PROCESSING') {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const getResponse = await ai.files.get({ name: fileName });
                
                // Handle getResponse structure
                // @ts-ignore
                const currentFile = getResponse.file || getResponse;
                state = currentFile.state;
                
                if (state === 'FAILED') {
                    throw new Error("File processing failed on server.");
                }
            }

            contentPart = {
                fileData: {
                    fileUri: fileUri,
                    mimeType: fileResult.mimeType || file.type
                }
            };
        } catch (uploadError: any) {
            console.error("Upload failed", uploadError);
            throw new Error(`Large file upload failed: ${uploadError.message || "Unknown error"}. Try a smaller file.`);
        }
      }
      
      setUploadStatus("Transcribing...");
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash', 
        contents: {
          parts: [
            contentPart,
            {
              text: "Please provide a highly accurate, verbatim transcription of this audio file. Output only the transcription text."
            }
          ]
        }
      });
      
      const text = response.text;
      
      if (text) {
        setTranscripts(prev => [...prev, {
          id: Date.now().toString(),
          text: text,
          isPartial: false,
          timestamp: new Date(),
          speaker: 'user'
        }]);
      }
    } catch (e: any) {
      console.error(e);
      setError(e.message || "Failed to transcribe file. Please try again.");
    } finally {
      setIsUploading(false);
      setUploadStatus("");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 md:p-8">
      
      <div className="max-w-3xl w-full bg-slate-900 rounded-2xl shadow-2xl overflow-hidden border border-slate-800 flex flex-col h-[85vh]">
        
        {/* Header */}
        <div className="p-6 bg-slate-800 border-b border-slate-700 flex justify-between items-center">
          <div className="flex items-center space-x-3">
            <div className={`w-3 h-3 rounded-full ${
              connectionState === ConnectionState.CONNECTED ? 'bg-green-500 animate-pulse' : 
              connectionState === ConnectionState.CONNECTING ? 'bg-yellow-500 animate-pulse' :
              connectionState === ConnectionState.ERROR ? 'bg-red-500' : 'bg-slate-500'
            }`}></div>
            <h1 className="text-xl font-bold text-slate-100">Gemini Live Scribe</h1>
          </div>
          <div className="flex space-x-2">
            <input 
                type="file" 
                ref={fileInputRef} 
                className="hidden" 
                accept="audio/*" 
                onChange={handleFileUpload} 
            />
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-1"
            >
              {isUploading ? (
                  <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
              ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
              )}
              <span>{isUploading ? 'Processing...' : 'Upload'}</span>
            </button>
            <button 
              onClick={copyToClipboard}
              disabled={(transcripts.length === 0 && !currentText) || isCopied}
              className={`px-3 py-1.5 text-sm rounded-md transition-all duration-200 flex items-center space-x-1 disabled:opacity-50 disabled:cursor-not-allowed ${
                  isCopied 
                    ? 'bg-green-600 text-white hover:bg-green-700' 
                    : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
              }`}
            >
              {isCopied ? (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    <span>Copied</span>
                  </>
              ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                    <span>Copy</span>
                  </>
              )}
            </button>
            <button 
              onClick={clearTranscripts}
              disabled={transcripts.length === 0 && !currentText}
              className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-red-900/50 hover:text-red-200 text-slate-200 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-1"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              <span>Clear</span>
            </button>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-900/50 text-red-200 px-6 py-2 text-sm border-b border-red-800 flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-300 hover:text-white">&times;</button>
          </div>
        )}

        {/* Transcription Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar bg-slate-950 relative">
          
          {transcripts.length === 0 && !currentText && !isUploading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600 p-8 text-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mb-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              <p className="text-lg font-medium">Ready to transcribe</p>
              <p className="text-sm mt-2 max-w-sm">
                Click the microphone to start live transcription or upload an audio file.
              </p>
            </div>
          )}

          {transcripts.map((item) => (
            <div key={item.id} className="group animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="flex space-x-2 items-baseline mb-1">
                 <span className="text-xs font-mono text-slate-500 select-none">
                    {item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                 </span>
              </div>
              <p className="text-slate-200 leading-relaxed whitespace-pre-wrap">
                {item.text}
              </p>
            </div>
          ))}

          {/* Current Partial Transcript */}
          {currentText && (
            <div className="animate-pulse">
               <div className="flex space-x-2 items-baseline mb-1">
                 <span className="text-xs font-mono text-cyan-500 select-none">Live</span>
              </div>
              <p className="text-cyan-100 leading-relaxed italic whitespace-pre-wrap">
                {currentText}
              </p>
            </div>
          )}

          {isUploading && (
             <div className="animate-pulse flex flex-col items-center justify-center p-4 border border-dashed border-slate-700 rounded-lg bg-slate-900/50">
               <div className="flex items-center space-x-3 text-indigo-400">
                 <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                 </svg>
                 <span className="text-sm font-medium">{uploadStatus || "Processing..."}</span>
               </div>
               <p className="text-xs text-slate-500 mt-2">This may take a moment depending on file size.</p>
             </div>
          )}
          
          <div ref={transcriptEndRef} />
        </div>

        {/* Footer / Controls */}
        <div className="p-6 bg-slate-800 border-t border-slate-700 flex flex-col space-y-4">
            
            {/* Visualizer */}
            <div className="w-full">
                <AudioVisualizer stream={audioStream} isRecording={connectionState === ConnectionState.CONNECTED} />
            </div>

            <div className="flex justify-center">
                <button
                    onClick={toggleRecording}
                    disabled={connectionState === ConnectionState.CONNECTING || isUploading}
                    className={`
                        h-16 w-16 rounded-full flex items-center justify-center shadow-lg transition-all transform hover:scale-105 active:scale-95
                        ${connectionState === ConnectionState.CONNECTED 
                            ? 'bg-red-500 hover:bg-red-600 shadow-red-500/30 ring-4 ring-red-500/20' 
                            : 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-500/30'
                        }
                        ${(connectionState === ConnectionState.CONNECTING || isUploading) ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                    title={connectionState === ConnectionState.CONNECTED ? "Stop Recording" : "Start Recording"}
                >
                    {connectionState === ConnectionState.CONNECTING ? (
                       <svg className="animate-spin h-8 w-8 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                         <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                         <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                       </svg>
                    ) : connectionState === ConnectionState.CONNECTED ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-white" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
                        </svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-white" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
                        </svg>
                    )}
                </button>
            </div>
            
            <p className="text-center text-xs text-slate-500 font-medium">
                {connectionState === ConnectionState.CONNECTED ? "Listening..." : "Tap microphone to transcribe"}
            </p>
        </div>

      </div>
    </div>
  );
};

export default App;