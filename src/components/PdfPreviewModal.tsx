import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url';
import {
  X,
  FileDown,
  Printer,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  AlertTriangle,
  RotateCw,
} from 'lucide-react';

// Configure worker safely
if (typeof window !== 'undefined') {
  try {
    (pdfjsLib as any).GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  } catch {
    (pdfjsLib as any).GlobalWorkerOptions.workerSrc = '';
  }
}

interface PdfPreviewModalProps {
  isOpen: boolean;
  title: string;
  pdfBytes: Uint8Array | null;
  isLoading: boolean;
  onClose: () => void;
  onDownload: () => void;
}

export const PdfPreviewModal: React.FC<PdfPreviewModalProps> = ({
  isOpen,
  title,
  pdfBytes,
  isLoading,
  onClose,
  onDownload,
}) => {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.25);
  const [renderingError, setRenderingError] = useState<string | null>(null);
  const [isPageRendering, setIsPageRendering] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<'canvas' | 'native'>('canvas');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfDocRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);

  // Reset state when modal opens or closes or new bytes arrive
  useEffect(() => {
    if (!isOpen) {
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {}
      }
      pdfDocRef.current = null;
      setNumPages(0);
      setCurrentPage(1);
      setRenderingError(null);
      return;
    }
  }, [isOpen]);

  // Load PDF Document via PDF.js with fallback
  useEffect(() => {
    if (!isOpen || !pdfBytes || isLoading) return;

    let isMounted = true;
    setRenderingError(null);
    setCurrentPage(1);

    const loadDoc = async () => {
      try {
        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch {}
        }

        const uint8Data = new Uint8Array(pdfBytes);
        
        let doc: any = null;
        try {
          const loadingTask = (pdfjsLib as any).getDocument({
            data: uint8Data,
            useSystemFonts: true,
            isEvalSupported: false,
          });
          doc = await loadingTask.promise;
        } catch (workerErr) {
          console.warn('Primary worker load failed, retrying with fake worker on main thread:', workerErr);
          if (typeof window !== 'undefined') {
            (pdfjsLib as any).GlobalWorkerOptions.workerSrc = '';
          }
          const fallbackTask = (pdfjsLib as any).getDocument({
            data: uint8Data,
            useSystemFonts: true,
            isEvalSupported: false,
          });
          doc = await fallbackTask.promise;
        }

        if (!isMounted) return;

        pdfDocRef.current = doc;
        setNumPages(doc.numPages);
      } catch (err: any) {
        console.error('PDF.js failed to load document for preview:', err);
        if (isMounted) {
          setRenderingError(err.message || 'Failed to initialize PDF renderer');
          // If canvas fails, switch to native fallback
          setViewMode('native');
        }
      }
    };

    loadDoc();

    return () => {
      isMounted = false;
    };
  }, [isOpen, pdfBytes, isLoading]);

  // Render individual page onto canvas
  useEffect(() => {
    if (!isOpen || !pdfDocRef.current || viewMode !== 'canvas') return;

    let isMounted = true;

    const renderPage = async (pageNumber: number) => {
      try {
        setIsPageRendering(true);
        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch {}
        }

        const page = await pdfDocRef.current.getPage(pageNumber);
        if (!isMounted || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        const viewport = page.getViewport({ scale });
        
        // Handle high DPI screens for crisp typography
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const transform = outputScale !== 1
          ? [outputScale, 0, 0, outputScale, 0, 0]
          : undefined;

        const renderContext = {
          canvasContext: context,
          viewport: viewport,
          transform: transform,
        };

        const renderTask = page.render(renderContext);
        renderTaskRef.current = renderTask;

        await renderTask.promise;
        if (isMounted) {
          setIsPageRendering(false);
        }
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('Error rendering page to canvas:', err);
          if (isMounted) {
            setIsPageRendering(false);
          }
        }
      }
    };

    renderPage(currentPage);

    return () => {
      isMounted = false;
    };
  }, [isOpen, currentPage, scale, numPages, viewMode]);

  // Object URL for native object/iframe fallback
  const blobUrl = React.useMemo(() => {
    if (!pdfBytes) return null;
    const blob = new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' });
    return URL.createObjectURL(blob);
  }, [pdfBytes]);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  if (!isOpen) return null;

  const handlePrint = () => {
    if (!blobUrl) return;
    const printWindow = window.open(blobUrl, '_blank');
    if (printWindow) {
      printWindow.focus();
    } else {
      // In case popups blocked, print through hidden iframe
      let iframe = document.getElementById('pdf-print-hidden-iframe') as HTMLIFrameElement;
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'pdf-print-hidden-iframe';
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        document.body.appendChild(iframe);
      }
      iframe.src = blobUrl;
      iframe.onload = () => {
        try {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
        } catch {}
      };
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-slate-900 rounded-2xl w-full max-w-5xl h-[92vh] flex flex-col shadow-2xl border border-slate-700 overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-slate-800 border-b border-slate-700 text-white select-none">
          <div className="flex items-center space-x-2.5 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 shrink-0"></span>
            <h3 className="font-bold text-sm sm:text-base truncate max-w-md sm:max-w-xl">
              {title}
            </h3>
            {numPages > 0 && (
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-700 text-slate-300 hidden md:inline">
                {numPages} {numPages === 1 ? 'Page' : 'Pages'}
              </span>
            )}
          </div>

          <div className="flex items-center space-x-2 shrink-0">
            {/* View Mode Switcher */}
            <div className="hidden sm:flex items-center bg-slate-900/60 p-0.5 rounded-lg border border-slate-700 text-xs mr-1">
              <button
                type="button"
                onClick={() => setViewMode('canvas')}
                className={`px-2 py-1 rounded font-medium transition ${
                  viewMode === 'canvas'
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Canvas
              </button>
              <button
                type="button"
                onClick={() => setViewMode('native')}
                className={`px-2 py-1 rounded font-medium transition ${
                  viewMode === 'native'
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Browser PDF
              </button>
            </div>

            <button
              onClick={handlePrint}
              type="button"
              className="inline-flex items-center px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 transition"
              title="Print document"
            >
              <Printer className="w-3.5 h-3.5 mr-1" />
              <span className="hidden sm:inline">Print</span>
            </button>

            <button
              onClick={onDownload}
              type="button"
              className="inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg bg-red-600 hover:bg-red-500 text-white transition shadow-sm"
              title="Download PDF"
            >
              <FileDown className="w-3.5 h-3.5 mr-1.5" />
              Download
            </button>

            <button
              onClick={onClose}
              type="button"
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700 transition"
              title="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Canvas Toolbar Controls (Page nav, Zoom) */}
        {viewMode === 'canvas' && !isLoading && !renderingError && numPages > 0 && (
          <div className="flex items-center justify-between px-4 py-2 bg-slate-850/90 border-b border-slate-800 text-xs text-slate-300 select-none">
            {/* Page Navigation */}
            <div className="flex items-center space-x-1.5">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1 || isPageRendering}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 transition"
                title="Previous Page"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              <span className="font-mono text-xs px-2">
                Page <span className="text-white font-bold">{currentPage}</span> of{' '}
                <span className="text-white font-bold">{numPages}</span>
              </span>

              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
                disabled={currentPage >= numPages || isPageRendering}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 transition"
                title="Next Page"
              >
                <ChevronRight className="w-4 h-4" />
              </button>

              {isPageRendering && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-red-500 ml-2" />
              )}
            </div>

            {/* Zoom Controls */}
            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={() => setScale((s) => Math.max(0.75, Number((s - 0.2).toFixed(2))))}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
                title="Zoom Out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>

              <span className="font-mono text-xs w-12 text-center text-slate-300">
                {Math.round(scale * 100)}%
              </span>

              <button
                type="button"
                onClick={() => setScale((s) => Math.min(2.5, Number((s + 0.2).toFixed(2))))}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
                title="Zoom In"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={() => setScale(1.25)}
                className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-300 transition"
                title="Reset Zoom"
              >
                Reset
              </button>
            </div>
          </div>
        )}

        {/* Modal Body / Viewer */}
        <div className="flex-1 bg-slate-950 relative flex items-center justify-center overflow-auto p-4">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center text-slate-400 space-y-3">
              <Loader2 className="w-9 h-9 animate-spin text-red-500" />
              <p className="text-sm font-medium">Generating high-resolution PDF document...</p>
              <p className="text-xs text-slate-500">Compiling vectors, branding, and legal clauses</p>
            </div>
          ) : viewMode === 'canvas' && !renderingError ? (
            <div className="flex flex-col items-center justify-start min-h-full py-2">
              <div className="shadow-2xl rounded-sm overflow-hidden bg-white border border-slate-700/80 transition-all">
                <canvas ref={canvasRef} className="block mx-auto" />
              </div>

              {/* Bottom Quick Page Jump for multi-page docs */}
              {numPages > 1 && (
                <div className="mt-4 flex items-center gap-1.5 bg-slate-900/90 border border-slate-800 px-3 py-1.5 rounded-full text-xs shadow-md">
                  {Array.from({ length: numPages }).map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setCurrentPage(idx + 1)}
                      className={`w-7 h-7 rounded-full text-xs font-mono font-bold transition ${
                        currentPage === idx + 1
                          ? 'bg-red-600 text-white shadow-sm'
                          : 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'
                      }`}
                    >
                      {idx + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : blobUrl ? (
            /* Native iframe / object fallback */
            <div className="w-full h-full flex flex-col items-center justify-center">
              <object
                data={`${blobUrl}#toolbar=1&navpanes=0`}
                type="application/pdf"
                className="w-full h-full border-0 bg-white rounded-lg shadow-inner"
              >
                <iframe
                  src={blobUrl}
                  className="w-full h-full border-0 bg-white rounded-lg"
                  title="PDF Preview"
                >
                  <div className="p-8 text-center text-slate-400">
                    <p className="text-sm">Your browser does not support embedded PDF frames.</p>
                    <button
                      onClick={onDownload}
                      className="mt-3 px-4 py-2 rounded-xl bg-red-600 text-white font-bold text-xs"
                    >
                      Download PDF Document
                    </button>
                  </div>
                </iframe>
              </object>
            </div>
          ) : (
            <div className="text-slate-400 text-sm flex flex-col items-center gap-2">
              <AlertTriangle className="w-6 h-6 text-amber-500" />
              <span>No document bytes available for preview.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
