import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCaseCreation } from '../context/CaseCreationContext';
import { useCases } from '../context/CasesContext';
import { useAuth } from '../context/AuthContext';
import { useOnboarding } from '../context/OnboardingContext';
import { showToast } from '../utils/toast';
import { newRequestId, startInitialRun, startRun } from '../services/pipelineService';

interface Document {
  id: string;
  name: string;
  size: string;
  type: 'Clinical' | 'Text';
  storagePath: string;
  mimeType?: string;
}

const API_BASE = 'https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev';

const getUploadConfiguration = async (): Promise<{
  requestId: string;
  uploadUrl: string;
  uploadPrefix: string;
  uploadFields: Record<string, string>;
}> => {
  const response = await fetch(`${API_BASE}/get-upload-urls`, { method: 'POST' });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get upload configuration: ${errorText}`);
  }

  const data = await response.json();

  const parsedPayload = typeof data?.body === 'string'
    ? JSON.parse(data.body)
    : data?.body && typeof data.body === 'object'
      ? data.body
      : data;

  const normalizedRequestId =
    parsedPayload?.request_id ?? parsedPayload?.requestId ?? null;

  const normalizedUploadUrl =
    parsedPayload?.upload_url ?? parsedPayload?.uploadUrl ?? parsedPayload?.upload?.url ?? null;

  const normalizedUploadPrefix =
    parsedPayload?.upload_prefix ?? parsedPayload?.uploadPrefix ?? parsedPayload?.upload?.prefix ?? '';

  const normalizedUploadFields =
    parsedPayload?.fields ?? parsedPayload?.formFields ?? parsedPayload?.upload?.fields ?? {};

  if (
    !parsedPayload ||
    !normalizedRequestId ||
    !normalizedUploadUrl ||
    !normalizedUploadPrefix ||
    !normalizedUploadFields ||
    typeof normalizedUploadFields !== 'object'
  ) {
    throw new Error('Invalid upload configuration response from server');
  }

  return {
    requestId: normalizedRequestId,
    uploadUrl: normalizedUploadUrl,
    uploadPrefix: normalizedUploadPrefix,
    uploadFields: normalizedUploadFields,
  };
};

const uploadFilesToS3 = async (
  files: { name: string; file: File }[],
  uploadUrl: string,
  uploadPrefix: string,
  uploadFields: Record<string, string>
): Promise<void> => {
  for (const pendingFile of files) {
    const formData = new FormData();
    Object.entries(uploadFields).forEach(([fieldKey, value]) => {
      if (fieldKey !== 'key' && fieldKey !== 'acl') {
        formData.append(fieldKey, value);
      }
    });

    const serverProvidedKey = uploadFields.key;
    const fileKey = serverProvidedKey
      ? serverProvidedKey.replace('${filename}', pendingFile.name)
      : `${uploadPrefix}${pendingFile.name}`;

    formData.append('key', fileKey);
    formData.append('file', pendingFile.file);

    const response = await fetch(uploadUrl, { method: 'POST', body: formData });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload ${pendingFile.name}: ${errorText}`);
    }
  }
};

const triggerBackendProcessing = async (params: {
  requestId: string;
  caseId: string;
  additionalData: string;
}): Promise<void> => {
  const response = await fetch(`${API_BASE}/trigger-converter-files-to-png`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: params.requestId,
      case_id: params.caseId,
      additional_data: params.additionalData,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to trigger backend processing: ${errorText}`);
  }

  await response.json();
};

/**
 * Case creation, shared by the (now single) creation wizard step that
 * submits it. A sample-only draft (the walkthrough) skips upload, the
 * database and the pipeline entirely and just opens /sample-case; a real
 * draft uploads to S3, inserts the `cases` row, and fires the document-AI
 * pipeline trigger in the background before navigating to /my-cases.
 */
export function useCreateCase() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { step1Data, pendingFiles, caseExplanation, clearAll, setSampleDemo } = useCaseCreation();
  const { createCase } = useCases();
  const { caseSectionRunning, complete } = useOnboarding();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A double click (or the tour clicking through) must only create one case.
  const isNavigatingAway = useRef(false);

  const clinicalFiles = pendingFiles.filter(f => f.type === 'Clinical');
  // A case made only from the walkthrough's sample report. It skips upload,
  // the database and the pipeline entirely (see SampleCase.tsx).
  const isSampleCase = pendingFiles.length > 0 && pendingFiles.every(f => f.isSample);

  const handleCreateCase = async () => {
    if (isNavigatingAway.current) return;
    setError(null);

    if (isSampleCase) {
      if (!step1Data) return;
      setSampleDemo({
        caseName: step1Data.caseName,
        patientName: step1Data.patientName,
        cancerType: step1Data.cancerType,
        explanation: caseExplanation,
        questions: [],
      });
      // The sample page clears the draft once it has mounted. Clearing it
      // here would re-render this page (navigation is a transition) and its
      // "no draft" redirect would win.
      isNavigatingAway.current = true;
      navigate('/sample-case');
      return;
    }

    setLoading(true);

    try {
      if (!step1Data || !user) {
        throw new Error('Missing required data. Please restart case creation.');
      }

      if (clinicalFiles.length === 0 && !caseExplanation.trim()) {
        throw new Error('Add at least one document or describe the case before creating it.');
      }

      const filesToUpload = [...clinicalFiles];
      const additionalDataToSend = caseExplanation;

      const { requestId, uploadUrl, uploadPrefix, uploadFields } = await getUploadConfiguration();

      if (filesToUpload.length > 0) {
        await uploadFilesToS3(filesToUpload, uploadUrl, uploadPrefix, uploadFields);
      }

      const documentsMetadata: Document[] = pendingFiles.map(pf => ({
        id: pf.id,
        name: pf.name,
        size: pf.size,
        type: pf.type,
        storagePath: `${uploadPrefix}${pf.name}`,
        mimeType: pf.mimeType,
      }));

      const { caseId } = await createCase(
        {
          caseName: step1Data.caseName,
          patientName: step1Data.patientName,
          age: null,
          sex: null,
          cancerType: step1Data.cancerType,
          summary: null,
          requestId: requestId,
        },
        documentsMetadata,
        [],
      );

      // A real first case stands in for the walkthrough's sample case: the
      // case section is done, and the case's own tips take over.
      if (caseSectionRunning) complete(['case_flow']);

      isNavigatingAway.current = true;
      navigate('/my-cases');

      try {
        if (additionalDataToSend) {
          const { supabase } = await import('../Supabase/client');
          const { error: docError } = await supabase
            .from('case_additional_documents')
            .insert({
              case_id: caseId,
              document_title: 'Case Explanation',
              document_data: additionalDataToSend,
            });
          if (docError) console.error('Error saving case explanation:', docError);
        }

        // Start the case's first pipeline run, so its processing is tracked
        // (a failure shows up as failed with a Retry instead of leaving the
        // case "processing" forever). If the run can't be created, fall back
        // to the untracked trigger rather than not processing the case at all.
        let run: Awaited<ReturnType<typeof startInitialRun>> | null = null;
        try {
          run = await startInitialRun(caseId, newRequestId());
        } catch (runErr) {
          console.error('Could not start a tracked run; using the untracked trigger', runErr);
        }
        if (run) {
          await startRun(run.id);
        } else {
          await triggerBackendProcessing({ requestId, caseId, additionalData: additionalDataToSend });
        }
      } catch (postCreateErr) {
        console.error('Post-create processing failed:', postCreateErr);
      }

      showToast.success('Case created successfully!');
      clearAll();
    } catch (err: unknown) {
      console.error('Case creation failed:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to create case';
      setError(errorMessage);
      showToast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return { handleCreateCase, loading, error, setError, isSampleCase };
}
