import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Plus, X } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { useCaseCreation, PendingFile } from '../context/CaseCreationContext';
import { useIsMobile } from '../hooks/useMobile';

export function NewCaseStep2() {
  const navigate = useNavigate();
  const { pendingFiles, addFiles, removeFile, step1Data } = useCaseCreation();
  const isMobile = useIsMobile();
  const [showTextModal, setShowTextModal] = useState(false);
  const [textContent, setTextContent] = useState('');
  const [textTitle, setTextTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Redirect to step 1 if no step1 data
  if (!step1Data) {
    navigate('/cases/new/step-1');
    return null;
  }

  // Check for speech recognition support
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' ';
        } else {
          interimTranscript += transcript;
        }
      }

      if (finalTranscript) {
        setTextContent(prev => prev + finalTranscript);
      }
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  // Allowed file extensions for upload
  const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'doc', 'docx', 'ppt', 'pptx', 'pdf', 'txt'];

  const getFileExtension = (filename: string): string => {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    setError(null);
    const newPendingFiles: PendingFile[] = [];
    const rejectedFiles: string[] = [];
    const blockedPdfs: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const extension = getFileExtension(file.name);

      // File extension validation
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        rejectedFiles.push(file.name);
        continue;
      }

      // PDF page limit validation - strictly block PDFs with more than 50 pages
      if (file.type === 'application/pdf' || extension === 'pdf') {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdfjsLib = await import('pdfjs-dist');
          pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
          const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          const pageCount = pdf.numPages;
          
          if (pageCount > 50) {
            blockedPdfs.push(`"${file.name}" (${pageCount} pages)`);
            continue; // Skip this file - do not add to pending files
          }
        } catch (err) {
          console.warn('Could not validate PDF page count for:', file.name, err);
          // If validation fails, still allow upload (cannot verify page count)
        }
      }

      let rawText: string | undefined;
      if (file.type === 'text/plain') {
        try {
          rawText = await file.text();
        } catch (_err) {
          // Ignore text extraction failure; continue upload
        }
      }
      
      const pendingFile: PendingFile = {
        id: `${Date.now()}_${i}`,
        file,
        type: 'Clinical',
        name: file.name,
        size: `${(file.size / (1024 * 1024)).toFixed(2)} MB`,
        mimeType: file.type,
        rawText,
      };

      newPendingFiles.push(pendingFile);
    }

    // Show error messages for rejected files
    const errorMessages: string[] = [];
    
    if (blockedPdfs.length > 0) {
      errorMessages.push(`This PDF contains more than 50 pages. Uploading PDFs with more than 50 pages is not allowed: ${blockedPdfs.join(', ')}`);
    }
    
    if (rejectedFiles.length > 0) {
      errorMessages.push(`File type not allowed. Only png, jpg, jpeg, doc, docx, ppt, pptx, pdf, txt files are accepted: ${rejectedFiles.join(', ')}`);
    }

    // Add files with duplicate check
    const result = addFiles(newPendingFiles);
    if (!result.success) {
      errorMessages.push(`File(s) with the same name already uploaded: ${result.duplicates.join(', ')}`);
    }
    
    if (errorMessages.length > 0) {
      setError(errorMessages.join(' | '));
    }
    
    event.target.value = ''; // Reset input to allow same file again
  };

  const handleSaveText = () => {
    if (!textContent.trim()) return;
    
    // Check if there's already an additional document (Text type)
    const existingTextDoc = pendingFiles.find(f => f.type === 'Text');
    if (existingTextDoc) {
      // Update existing document - CRITICAL: Don't reset, just update
      const fileName = `${textTitle || 'additional_data'}.txt`;
      const blob = new Blob([textContent], { type: 'text/plain' });
      const file = new File([blob], fileName, { type: 'text/plain' });
      
      const updatedFile: PendingFile = {
        ...existingTextDoc, // Preserve all existing properties including ID
        file,
        name: textTitle || 'Additional Data',
        size: `${(textContent.length / 1024).toFixed(2)} KB`,
        rawText: textContent,
      };
      
      // Remove old and add updated (maintains single document)
      removeFile(existingTextDoc.id);
      addFiles([updatedFile]);
      console.log('✓ Additional document updated in state');
    } else {
      // Create new document
      const fileName = `${textTitle || 'additional_data'}.txt`;
      const blob = new Blob([textContent], { type: 'text/plain' });
      const file = new File([blob], fileName, { type: 'text/plain' });
      
      const pendingFile: PendingFile = {
        id: Date.now().toString(),
        file,
        type: 'Text',
        name: textTitle || 'Additional Data',
        size: `${(textContent.length / 1024).toFixed(2)} KB`,
        mimeType: 'text/plain',
        rawText: textContent,
      };
      
      addFiles([pendingFile]);
      console.log('✓ Additional document created in state');
    }
    
    // DON'T CLEAR - Keep modal open with saved content
    setShowTextModal(false);
    setError(null);
  };

  const handleNext = () => {
    navigate('/cases/review');
  };

  const handleBack = () => {
    // Mark that we're going back to step 1
    sessionStorage.setItem('fromStep2', 'true');
    navigate('/cases/new/step-1');
  };

  // Check if additional document exists
  const existingTextDoc = pendingFiles.find(f => f.type === 'Text');

  const handleOpenTextModal = () => {
    if (existingTextDoc) {
      // Load existing document for editing
      setTextTitle(existingTextDoc.name || '');
      setTextContent(existingTextDoc.rawText || '');
    } else {
      setTextTitle('');
      setTextContent('');
    }
    setShowTextModal(true);
  };

  return (
    <Layout>
      <div className={`max-w-4xl mx-auto ${isMobile ? 'py-4' : 'py-8'}`}>
        <div className={isMobile ? 'mb-4' : 'mb-8'}>
          <h1 className={`font-bold text-gray-900 ${isMobile ? 'text-xl' : 'text-3xl'}`}>Upload Documents</h1>
          <p className={`text-gray-600 mt-1 ${isMobile ? 'text-xs' : 'mt-2'}`}>Add clinical documents and relevant information</p>
        </div>

        <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
          {error && (
            <div className={`p-4 bg-red-50 border border-red-200 text-red-700 rounded-md ${isMobile ? 'text-xs p-3' : 'text-sm'}`}>
              {error}
            </div>
          )}
          
          <div className={`grid gap-4 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
            <label className={`bg-white border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-all group cursor-pointer ${isMobile ? 'p-4' : 'p-6'}`}>
              <input type="file" multiple className="hidden" onChange={handleFileUpload} accept=".png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.pdf,.txt" />
              <FileText className={`text-gray-400 group-hover:text-blue-600 mx-auto mb-2 ${isMobile ? 'w-6 h-6' : 'w-8 h-8'}`} />
              <h3 className={`font-medium text-gray-900 mb-1 text-center ${isMobile ? 'text-sm' : 'text-sm'}`}>Upload Clinical Data</h3>
              <p className="text-xs text-gray-500 text-center">PNG, JPG, DOC, DOCX, PPT, PPTX, PDF, TXT</p>
            </label>

            <button
              onClick={handleOpenTextModal}
              className={`bg-white border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-all group ${isMobile ? 'p-4' : 'p-6'}`}
            >
              <Plus className={`text-gray-400 group-hover:text-blue-600 mx-auto mb-2 ${isMobile ? 'w-6 h-6' : 'w-8 h-8'}`} />
              <h3 className={`font-medium text-gray-900 mb-1 ${isMobile ? 'text-sm' : 'text-sm'}`}>
                {existingTextDoc ? 'Edit Your Data' : 'Type'}
              </h3>
              <p className="text-xs text-gray-500">
                {existingTextDoc ? 'Continue writing in existing document' : 'Explain your case in detail'}
              </p>
            </button>
          </div>

          {pendingFiles.length > 0 && (
            <div className={`bg-white rounded-lg shadow ${isMobile ? 'p-4' : 'p-6'}`}>
              <h3 className={`font-medium text-gray-900 ${isMobile ? 'text-base mb-3' : 'text-lg mb-4'}`}>Files Ready to Upload ({pendingFiles.length})</h3>
              <div className="space-y-2">
                {pendingFiles.map((doc) => (
                  <div
                    key={doc.id}
                    className={`flex items-center justify-between bg-gray-50 rounded-md ${isMobile ? 'p-2' : 'p-3'}`}
                  >
                    <div className="flex items-center space-x-3 min-w-0 flex-1">
                      <FileText className={`text-gray-400 flex-shrink-0 ${isMobile ? 'w-4 h-4' : 'w-5 h-5'}`} />
                      <div className="min-w-0 flex-1">
                        <p className={`font-medium text-gray-900 truncate ${isMobile ? 'text-xs' : 'text-sm'}`}>{doc.name}</p>
                        <p className="text-xs text-gray-500">{doc.size}</p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2 flex-shrink-0">
                      <span
                        className={`px-2 py-0.5 text-xs rounded-full ${isMobile ? 'hidden sm:inline-block' : ''} ${
                          doc.type === 'Clinical'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {doc.type}
                      </span>
                      <button
                        onClick={() => removeFile(doc.id)}
                        className="text-red-500 hover:text-red-700">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={`flex ${isMobile ? 'flex-col gap-2' : 'justify-end space-x-3'}`}>
            <button
              onClick={handleBack}
              className={`px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors ${isMobile ? 'w-full' : ''}`}
            >
              Back
            </button>
            <button
              onClick={handleNext}
              className={`px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors ${isMobile ? 'w-full' : ''}`}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <Modal
        isOpen={showTextModal}
        onClose={() => setShowTextModal(false)}
        title="Explain Your Case"
        size="large"
      >
        <div className={`flex flex-col ${isMobile ? 'h-[calc(70vh-6rem)]' : 'h-[calc(80vh-8rem)]'}`}>
          {/* Helper text */}
          <div className={`mb-4 bg-blue-50 border border-blue-200 rounded-md ${isMobile ? 'p-3' : 'p-4'}`}>
            <p className={`text-blue-800 ${isMobile ? 'text-xs' : 'text-sm'}`}>
              You can explain your case here in full detail. Type exactly as you would explain the case in a boardroom or a clinical meeting. Include all details you feel are relevant for understanding the case.
            </p>
          </div>

          {/* Document Title */}
          <div className="mb-4">
            <label htmlFor="textTitle" className="block text-sm font-medium text-gray-700 mb-1">
              Document Title
            </label>
            <input
              id="textTitle"
              type="text"
              value={textTitle}
              onChange={(e) => setTextTitle(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., Clinical Notes, Case Summary"
            />
          </div>

          {/* Text input area with voice controls */}
          <div className="flex-1 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="textContent" className="block text-sm font-medium text-gray-700">
                Content {isListening && <span className="text-red-600 ml-2 animate-pulse">● Listening...</span>}
              </label>
              {/* {speechSupported && (
                <button
                  onClick={toggleListening}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors ${
                    isListening
                      ? 'bg-red-600 text-white hover:bg-red-700'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                  title={isListening ? 'Stop recording' : 'Start voice input'}
                >
                  {isListening ? (
                    <>
                      <MicOff className="w-4 h-4" />
                      <span className="text-sm">Stop</span>
                    </>
                  ) : (
                    <>
                      <Mic className="w-4 h-4" />
                      <span className="text-sm">Speak</span>
                    </>
                  )}
                </button>
              )} */}
            </div>
            <textarea
              ref={textareaRef}
              id="textContent"
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              className="flex-1 w-full px-4 py-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Text area"
            />
          </div>

          {/* Action buttons - Fixed at bottom */}
          <div className="flex justify-end space-x-3 mt-4 pt-4 border-t">
            <button
              onClick={() => {
                if (isListening && recognitionRef.current) {
                  recognitionRef.current.stop();
                }
                setShowTextModal(false);
              }}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveText}
              disabled={!textContent.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}
