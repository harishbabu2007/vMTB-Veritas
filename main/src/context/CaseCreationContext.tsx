import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

export interface PendingFile {
  id: string;
  file: File;
  type: 'Clinical' | 'Text';
  name: string;
  size: string;
  mimeType?: string;
  rawText?: string;
  // The walkthrough's sample report: never uploaded or processed.
  isSample?: boolean;
}

export interface Step1Data {
  caseName: string;
  patientName: string;
  cancerType: string;
}

// S3 upload credentials returned from /get-upload-urls
export interface S3UploadCredentials {
  requestId: string;
  uploadUrl: string;
  formFields: Record<string, string>;
}

// A sample case "created" from the walkthrough. Held in memory only and shown
// by /sample-case; nothing is uploaded or saved.
export interface SampleDemo {
  caseName: string;
  patientName: string;
  cancerType: string;
  explanation: string;
  questions: string[];
}

interface CaseCreationContextType {
  step1Data: Step1Data | null;
  setStep1Data: (data: Step1Data | null) => void;
  pendingFiles: PendingFile[];
  setPendingFiles: (files: PendingFile[] | ((prev: PendingFile[]) => PendingFile[])) => void;
  addFiles: (files: PendingFile[]) => { success: boolean; duplicates: string[] };
  removeFile: (id: string) => void;
  caseExplanation: string;
  setCaseExplanation: (explanation: string) => void;
  clearAll: () => void;
  // S3 upload state
  s3Credentials: S3UploadCredentials | null;
  setS3Credentials: (creds: S3UploadCredentials | null) => void;
  sampleDemo: SampleDemo | null;
  setSampleDemo: (demo: SampleDemo | null) => void;
}

const CaseCreationContext = createContext<CaseCreationContextType | undefined>(undefined);

export function CaseCreationProvider({ children }: { children: ReactNode }) {
  const [step1Data, setStep1Data] = useState<Step1Data | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [caseExplanation, setCaseExplanation] = useState<string>('');
  const [s3Credentials, setS3Credentials] = useState<S3UploadCredentials | null>(null);
  const [sampleDemo, setSampleDemo] = useState<SampleDemo | null>(null);

  const addFiles = useCallback((newFiles: PendingFile[]): { success: boolean; duplicates: string[] } => {
    const existingNames = new Set(pendingFiles.map(f => f.name.toLowerCase()));
    const duplicates: string[] = [];
    const filesToAdd: PendingFile[] = [];

    for (const file of newFiles) {
      const lowerName = file.name.toLowerCase();
      if (existingNames.has(lowerName)) {
        duplicates.push(file.name);
      } else {
        existingNames.add(lowerName);
        filesToAdd.push(file);
      }
    }

    if (filesToAdd.length > 0) {
      setPendingFiles(prev => [...prev, ...filesToAdd]);
    }

    return {
      success: duplicates.length === 0,
      duplicates,
    };
  }, [pendingFiles]);

  const removeFile = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setStep1Data(null);
    setPendingFiles([]);
    setCaseExplanation('');
    setS3Credentials(null);
  }, []);

  return (
    <CaseCreationContext.Provider
      value={{
        step1Data,
        setStep1Data,
        pendingFiles,
        setPendingFiles,
        addFiles,
        removeFile,
        caseExplanation,
        setCaseExplanation,
        clearAll,
        s3Credentials,
        setS3Credentials,
        sampleDemo,
        setSampleDemo,
      }}
    >
      {children}
    </CaseCreationContext.Provider>
  );
}

export function useCaseCreation() {
  const context = useContext(CaseCreationContext);
  if (context === undefined) {
    throw new Error('useCaseCreation must be used within a CaseCreationProvider');
  }
  return context;
}
