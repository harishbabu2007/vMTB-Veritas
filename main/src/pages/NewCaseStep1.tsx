import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { DismissButton } from '../components/DismissButton';
import { useCaseCreation, PendingFile } from '../context/CaseCreationContext';
import { supabase } from '../Supabase/client';
import { useIsMobile } from '../hooks/useMobile';
import { useTourAction, useTourGroup } from '../hooks/useTourGroup';
import { useOnboarding } from '../context/OnboardingContext';
import { SampleDropAnimation } from '../components/onboarding/SampleDropAnimation';
import { SamplePdf } from '../components/onboarding/SamplePdf';
import { SAMPLE_CANCER_TYPE, SAMPLE_FILE_NAME, SAMPLE_PDF_URL } from '../onboarding/sampleCase';
import { CancerTypeSelect } from '../components/CancerTypeSelect';
import {
  CANCER_TYPES,
  CancerType,
  OTHER_CANCER_TYPE_ID,
  buildCaseName,
  findCancerTypeByName,
} from '../data/cancerTypes';
import { FileText, X, Upload, AlertCircle, Info, Eye, EyeOff } from 'lucide-react';
// @ts-ignore - pdfjs types may not be available
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker - must use .mjs for pdfjs-dist v5+
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'doc', 'docx', 'ppt', 'pptx', 'pdf', 'txt'];

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The walkthrough's sample report as a File, like one the user picked.
const loadSampleFile = async (signal: AbortSignal): Promise<File> => {
  let response: Response;
  try {
    response = await fetch(SAMPLE_PDF_URL, { signal });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error('Couldn’t load the sample report. Check your connection and try again.');
  }
  if (!response.ok) throw new Error('Couldn’t load the sample report. Please try again.');
  const blob = await response.blob();
  return new File([blob], SAMPLE_FILE_NAME, { type: 'application/pdf' });
};

export default function NewCaseStep1() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { step1Data, setStep1Data, pendingFiles, setPendingFiles, addFiles, removeFile, clearAll } = useCaseCreation();
  const { caseSectionRunning, resetCaseSection } = useOnboarding();
  const hasSample = pendingFiles.some(f => f.isSample);
  const [notice, setNotice] = useState<string | null>(null);
  // Drag-over look of the upload box: a real drag, or the walkthrough's.
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const dropZoneRef = useRef<HTMLButtonElement>(null);
  const [flight, setFlight] = useState<{ zone: DOMRect; done: () => void } | null>(null);
  const [showPreview, setShowPreview] = useState(hasSample);
  const [arrivedId, setArrivedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // Arriving with an empty draft (Add New Case, or back after the sample
  // case) starts the walkthrough's case section from the top. Runs before
  // the group below is requested.
  useEffect(() => {
    if (!step1Data && pendingFiles.length === 0) resetCaseSection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useTourGroup('step1', true);
  
  const [formData, setFormData] = useState({
    caseName: step1Data?.caseName || '',
    patientName: step1Data?.patientName || '',
    cancerType: step1Data?.cancerType || '',
  });
  // The chosen entry from the cancer-type list: its abbreviation is what the
  // case name is built from. "Other Cancer Type (Not Listed)" adds a
  // free-text box, and what's typed there is what the case stores.
  // Coming back from step 2: a stored value that isn't one of the list's own
  // names was typed under "Other".
  const stored = step1Data?.cancerType || '';
  const storedType = findCancerTypeByName(stored);
  const [cancerType, setCancerType] = useState<CancerType | null>(
    () => storedType ?? (stored ? CANCER_TYPES.find(t => t.id === OTHER_CANCER_TYPE_ID) ?? null : null)
  );
  const [otherDetail, setOtherDetail] = useState(() => (storedType ? '' : stored));
  const isOther = cancerType?.id === OTHER_CANCER_TYPE_ID;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The case name is the type's abbreviation plus 5 random digits, e.g.
  // "ILC80981". It is generated here and never shown or edited on this
  // screen. Generates a few at once and keeps the first one not already
  // taken.
  const generateCaseName = async (abbreviation: string): Promise<string> => {
    const candidates = Array.from({ length: 5 }, () => buildCaseName(abbreviation));
    const { data, error: lookupError } = await supabase
      .from('cases')
      .select('case_name')
      .in('case_name', candidates);
    if (lookupError) {
      console.error('Error checking case names:', lookupError);
      return candidates[0];
    }
    const taken = new Set((data ?? []).map(c => c.case_name));
    return candidates.find(name => !taken.has(name)) ?? buildCaseName(abbreviation);
  };

  const handleCancerTypeChange = async (type: CancerType | null) => {
    setCancerType(type);
    if (type?.id !== OTHER_CANCER_TYPE_ID) setOtherDetail('');
    if (!type) {
      setFormData(prev => ({ ...prev, cancerType: '', caseName: '' }));
      return;
    }
    setFormData(prev => ({ ...prev, cancerType: type.name }));
    const caseName = await generateCaseName(type.abbreviation);
    setFormData(prev => ({ ...prev, caseName }));
  };

  const isCaseNameUnique = async (caseName: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from('cases')
      .select('id')
      .eq('case_name', caseName)
      .maybeSingle();
    
    if (error) {
      console.error('Error checking case name:', error);
      throw error;
    }
    
    return !data;
  };

  // File upload handlers
  const getPdfPageCount = async (file: File): Promise<number> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    return pdf.numPages;
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    await addUserFiles(Array.from(input.files || []));
    input.value = ''; // Reset input to allow same file again
  };

  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const handleDragEnter = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    void addUserFiles(Array.from(e.dataTransfer.files));
  };

  // Files the user picked or dropped.
  const addUserFiles = async (files: File[]) => {
    if (files.length === 0) return;

    setError(null);
    const newPendingFiles: PendingFile[] = [];
    const rejectedFiles: string[] = [];
    const blockedPdfs: string[] = [];
    const unvalidatedPdfs: string[] = [];

    for (const file of files) {
      const extension = file.name.split('.').pop()?.toLowerCase()?.trim() || '';
      
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        rejectedFiles.push(file.name);
        continue;
      }

      // CRITICAL: Block PDFs over 50 pages (if we can validate)
      if (extension === 'pdf') {
        try {
          const pageCount = await getPdfPageCount(file);
          if (pageCount > 50) {
            blockedPdfs.push(file.name);
            continue;
          }
        } catch (err) {
          console.error('PDF validation error:', err);
          // Allow upload but track that it couldn't be validated
          unvalidatedPdfs.push(file.name);
        }
      }

      let rawText: string | undefined = undefined;
      if (extension === 'txt') {
        rawText = await file.text();
      }

      const pendingFile: PendingFile = {
        id: Date.now().toString() + Math.random(),
        file,
        type: 'Clinical',
        name: file.name,
        size: `${(file.size / 1024).toFixed(2)} KB`,
        mimeType: file.type,
        rawText,
      };

      newPendingFiles.push(pendingFile);
    }

    // Show error messages for rejected files
    const errorMessages: string[] = [];
    const warningMessages: string[] = [];
    
    if (blockedPdfs.length > 0) {
      errorMessages.push(`This PDF contains more than 50 pages. Uploading PDFs with more than 50 pages is not allowed: ${blockedPdfs.join(', ')}`);
    }
    
    if (unvalidatedPdfs.length > 0) {
      warningMessages.push(`Warning: Could not validate page count for PDF(s). Please ensure they don't exceed 50 pages: ${unvalidatedPdfs.join(', ')}`);
    }
    
    if (rejectedFiles.length > 0) {
      errorMessages.push(`File type not allowed. Only png, jpg, jpeg, doc, docx, ppt, pptx, pdf, txt files are accepted: ${rejectedFiles.join(', ')}`);
    }

    // The sample can't be mixed with real files: adding one drops it.
    if (newPendingFiles.length > 0 && pendingFiles.some(f => f.isSample)) {
      setPendingFiles(prev => prev.filter(f => !f.isSample));
      setNotice('Sample report removed. Your case will use your own files.');
    }

    // Add files with duplicate check
    const result = addFiles(newPendingFiles);
    if (!result.success) {
      errorMessages.push(`File(s) with the same name already uploaded: ${result.duplicates.join(', ')}`);
    }
    // Combine errors and warnings
    const allMessages = [...errorMessages, ...warningMessages];
    if (allMessages.length > 0) {
      setError(allMessages.join(' | '));
    }
  };

  // The walkthrough drops its sample report into the upload box, visibly:
  // a file is dragged in and dropped (just the drop highlight under reduced
  // motion). It's only offered while the draft has no files, so nothing of
  // the user's is replaced. The sample is never uploaded or processed.
  useTourAction('sample-drop', async (signal) => {
    setError(null);
    const file = await loadSampleFile(signal);
    if (signal.aborted) return;
    const zone = dropZoneRef.current;
    if (zone && !reducedMotion()) {
      await new Promise<void>(resolve => {
        const done = () => {
          signal.removeEventListener('abort', done);
          setFlight(null);
          setDragActive(false);
          resolve();
        };
        signal.addEventListener('abort', done);
        setFlight({ zone: zone.getBoundingClientRect(), done });
      });
    } else {
      setDragActive(true);
      await sleep(300);
      setDragActive(false);
    }
    if (signal.aborted) return;
    const id = `sample-${Date.now()}`;
    setPendingFiles([{
      id,
      file,
      type: 'Clinical',
      name: SAMPLE_FILE_NAME,
      size: `${(file.size / 1024).toFixed(2)} KB`,
      mimeType: 'application/pdf',
      isSample: true,
    }]);
    setArrivedId(id);
    setShowPreview(true);
    setAnnouncement('Sample report added.');
    // The demo case's summary is about lung adenocarcinoma.
    const current = formData.cancerType.trim();
    if (current !== SAMPLE_CANCER_TYPE) {
      if (current) setNotice(`Cancer type set to ${SAMPLE_CANCER_TYPE} to match the sample.`);
      const sampleType = findCancerTypeByName(SAMPLE_CANCER_TYPE);
      if (sampleType) await handleCancerTypeChange(sampleType);
    }
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (!cancerType) {
        setError('Please choose a cancer type from the list.');
        return;
      }

      // The name is generated, so a collision just means generating another.
      let caseName = formData.caseName || (await generateCaseName(cancerType.abbreviation));
      if (!(await isCaseNameUnique(caseName))) {
        caseName = await generateCaseName(cancerType.abbreviation);
      }

      // "Other" keeps what the user typed; everything else keeps the list's
      // own wording.
      const typed = otherDetail.trim();
      const cancerTypeValue = isOther && typed ? typed : cancerType.name;

      const step1 = { ...formData, caseName, cancerType: cancerTypeValue };
      setFormData(step1);
      setStep1Data(step1);
      navigate('/cases/new/step-2');
    } catch (err: any) {
      setError(err?.message || 'Failed to validate case name');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-7xl mx-auto">
        <div className={isMobile ? 'mb-4' : 'mb-6'}>
          <h1 className={`font-bold text-text ${isMobile ? 'text-xl' : 'text-2xl'}`}>Create New Case</h1>
          <p className={`text-text-muted mt-1 ${isMobile ? 'text-xs' : 'text-sm'}`}>Step 1 of 2: Basic Details & Upload Documents</p>
        </div>

        {error && (
          <div className={`mb-4 p-4 bg-danger-bg border border-danger-border rounded-lg flex items-start gap-3 ${isMobile ? 'text-xs p-3' : 'text-sm'}`}>
            <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
            <p className="text-danger-text flex-1">{error}</p>
            <DismissButton onClick={() => setError(null)} label="Dismiss error" className="text-danger-text" />
          </div>
        )}

        {notice && (
          <div role="status" className={`mb-4 p-4 bg-status-processing-bg border border-border rounded-lg flex items-start gap-3 ${isMobile ? 'text-xs p-3' : 'text-sm'}`}>
            <Info className="w-5 h-5 text-status-processing-text flex-shrink-0 mt-0.5" />
            <p className="text-status-processing-text flex-1">{notice}</p>
            <DismissButton onClick={() => setNotice(null)} label="Dismiss notice" className="text-status-processing-text" />
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="space-y-6">
            {/* Case Details */}
            <div className="bg-surface rounded-xl shadow-sm border border-border p-6 space-y-5">
              <h3 className="text-lg font-semibold text-text">Case Details</h3>

              <div className={`grid gap-4 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
                <div data-tour="patient-name">
                  <label htmlFor="patientName" className="block text-sm font-medium mb-2 text-text">
                    Patient Name (Optional)
                  </label>
                  <input
                    id="patientName"
                    type="text"
                    value={formData.patientName}
                    onChange={(e) => setFormData({ ...formData, patientName: e.target.value })}
                    className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                    style={{ fontSize: '16px' }}
                    placeholder="Leave empty for anonymous"
                  />
                </div>

                <div data-tour="cancer-type">
                  <label htmlFor="cancerType" className="block text-sm font-medium mb-2 text-text">
                    Cancer Type <span className="text-danger">*</span>
                  </label>
                  <CancerTypeSelect
                    id="cancerType"
                    value={formData.cancerType}
                    onChange={type => void handleCancerTypeChange(type)}
                    required
                  />
                  {cancerType && !isOther && (
                    <p className="mt-1.5 text-xs text-text-muted">
                      Abbreviation <span className="font-mono font-semibold text-text">{cancerType.abbreviation}</span> · {cancerType.category}
                    </p>
                  )}
                </div>
              </div>

              {isOther && (
                <div>
                  <label htmlFor="cancerTypeOther" className="block text-sm font-medium mb-2 text-text">
                    Which cancer type? <span className="text-text-muted font-normal">(optional)</span>
                  </label>
                  <input
                    id="cancerTypeOther"
                    type="text"
                    value={otherDetail}
                    onChange={e => setOtherDetail(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg bg-surface text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary"
                    style={{ fontSize: '16px' }}
                    placeholder="Describe it in your own words"
                  />
                  <p className="mt-1.5 text-xs text-text-muted">
                    The case is named with <span className="font-mono font-semibold text-text">OTHER</span>.
                  </p>
                </div>
              )}
            </div>

            {/* Upload Documents */}
            <div
              data-tour="upload-documents"
              className="bg-surface rounded-xl shadow-sm border border-border p-6"
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="mb-5">
                <h3 className="text-lg font-semibold mb-2 text-text">Upload Documents</h3>
                <p className="text-xs text-text-muted">Add clinical documents (optional)</p>
              </div>

              {/* Upload Button */}
              <button
                ref={dropZoneRef}
                type="button"
                onClick={() => fileInputRef.current?.click()}
                // The walkthrough drops its sample here, only into an empty draft.
                data-tour={caseSectionRunning && pendingFiles.length === 0 ? 'sample-drop' : undefined}
                className={`w-full flex items-center gap-4 border-2 border-dashed rounded-lg hover:border-primary hover:bg-status-processing-bg transition-all group mb-5 ${
                  dragActive ? 'border-primary bg-status-processing-bg' : 'border-border'
                } ${isMobile ? 'flex-col text-center py-6 px-4' : 'py-6 px-8'}`}
              >
                <Upload className={`w-8 h-8 group-hover:text-primary flex-shrink-0 ${dragActive ? 'text-primary' : 'text-text-muted'}`} />
                <div className={isMobile ? '' : 'text-left'}>
                  <p className={`text-sm font-medium group-hover:text-link ${dragActive ? 'text-link' : 'text-text'}`}>
                    {dragActive ? 'Drop to upload' : isMobile ? 'Tap to upload files' : 'Click or drag files here'}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">PNG, JPG, DOC, DOCX, PPT, PPTX, PDF, TXT — max 50 pages per PDF</p>
                </div>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileUpload}
                accept=".png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.pdf,.txt,image/png,image/jpeg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain"
              />

              {/* Uploaded Files List */}
              {pendingFiles.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-3 text-text">
                    Uploaded Files ({pendingFiles.length})
                  </p>
                  <div className={`grid gap-2 max-h-96 overflow-y-auto ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
                    {pendingFiles.map((doc) => (
                      <div
                        key={doc.id}
                        className={`flex items-center justify-between bg-bg rounded-lg p-3 border border-border ${doc.id === arrivedId ? 'file-arrived' : ''}`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <FileText className="w-5 h-5 text-text-muted flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-text truncate">{doc.name}</p>
                            <p className="text-xs text-text-muted">
                              {doc.size}
                              {doc.isSample && (
                                <span className="ml-2 px-1.5 py-0.5 rounded bg-status-pending-bg text-status-pending-text font-medium">Sample</span>
                              )}
                            </p>
                          </div>
                        </div>
                        {doc.isSample && (
                          <button
                            type="button"
                            onClick={() => setShowPreview(v => !v)}
                            aria-expanded={showPreview}
                            className="flex items-center gap-1 ml-2 px-2 py-1 text-xs font-medium text-text-muted rounded-md hover:bg-surface hover:text-text flex-shrink-0"
                          >
                            {showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            {showPreview ? 'Hide' : 'Preview'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => removeFile(doc.id)}
                          aria-label={`Remove ${doc.name}`}
                          className="text-danger hover:text-danger-text ml-2 flex-shrink-0"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {pendingFiles.length === 0 && (
                <p className="text-sm text-text-muted text-center">No files uploaded yet</p>
              )}

              {hasSample && showPreview && (
                <div data-tour="sample-preview" className="mt-5">
                  <div className="flex items-baseline justify-between gap-3 mb-2">
                    <p className="text-sm font-medium text-text truncate">{SAMPLE_FILE_NAME}</p>
                    <p className="text-xs text-text-muted flex-shrink-0">Fictional patient</p>
                  </div>
                  <SamplePdf maxHeight={isMobile ? '50vh' : '420px'} />
                </div>
              )}
              <p className="sr-only" aria-live="polite">{announcement}</p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className={`flex justify-end gap-3 mt-6 ${isMobile ? 'flex-col' : ''}`}>
            <button
              type="button"
              onClick={() => {
                clearAll();
                navigate('/my-cases');
              }}
              className={`px-4 py-2 border border-border rounded-lg text-text-muted hover:bg-surface-hover transition-colors ${isMobile ? 'w-full' : ''}`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              data-tour="step1-continue"
              className={`px-4 py-2 text-on-solid bg-primary-solid rounded-lg hover:bg-primary-solid-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isMobile ? 'w-full' : ''}`}
            >
              {loading ? 'Validating...' : 'Continue'}
            </button>
          </div>
        </form>
      </div>
      {flight && (
        <SampleDropAnimation zone={flight.zone} onOver={() => setDragActive(true)} onDone={flight.done} />
      )}
    </Layout>
  );
}
