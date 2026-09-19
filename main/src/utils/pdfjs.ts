// Single place that configures pdf.js's worker. Imported lazily so the
// library stays out of the initial bundle.
export async function loadPdfjs() {
  const pdfjsLib = await import('pdfjs-dist');
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  }
  return pdfjsLib;
}

/**
 * Fetch a document's bytes, turning an HTTP failure into a readable error.
 * S3 answers failures with an XML body; its <Message> ("Request has
 * expired", "Access Denied") is the useful part.
 */
export async function fetchDocumentBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const message = body.match(/<Message>([^<]*)<\/Message>/)?.[1];
    throw new Error(
      response.status === 403
        ? `Access to this document was refused${message ? ` (${message})` : ''}.`
        : `The document couldn't be downloaded (HTTP ${response.status}${message ? `: ${message}` : ''}).`
    );
  }
  return response.arrayBuffer();
}
