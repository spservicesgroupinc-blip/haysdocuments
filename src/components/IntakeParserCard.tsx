import React, { useRef, useState } from 'react';
import {
  Sparkles,
  ArrowRight,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Info,
  Loader2,
} from 'lucide-react';
import { RestorationJobData } from '../types/jobData';
import {
  parseRawIntakeText,
  applyAiExtractionToJob,
  IntakeParseResult,
  ProvenanceRecord,
  FieldProvenanceType,
  ExtractedSectionSummary,
} from '../services/intakeParser';
import { analyzeIntakeWithAi } from '../services/deepseekIntake';
import { extractTextFromPdfBuffer } from '../services/pdfExtractor';

interface IntakeParserCardProps {
  onApplyIntake: (job: RestorationJobData, provenance: ProvenanceRecord) => void;
  /** The record currently in the workspace - pastes merge into it instead of replacing it. */
  currentJob?: RestorationJobData;
  currentProvenance?: ProvenanceRecord;
}

/** Minimum size of a paste before it is parsed automatically. */
const AUTO_PARSE_MIN_CHARS = 20;

type ParseSource = 'manual' | 'paste' | 'file';
type ParseMode = 'ai' | 'rules';

export const IntakeParserCard: React.FC<IntakeParserCardProps> = ({
  onApplyIntake,
  currentJob,
}) => {
  const [intakeText, setIntakeText] = useState('');
  const [isExtractingPdf, setIsExtractingPdf] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [uploadedFileInfo, setUploadedFileInfo] = useState<{
    name: string;
    sizeKb: number;
    isPdf: boolean;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [lastParseResult, setLastParseResult] = useState<{
    fieldsCount: number;
    updatedCount: number;
    blockingFields: string[];
    warnings: string[];
    sections: ExtractedSectionSummary[];
    source: ParseSource;
    mode: ParseMode;
    aiNotes?: string;
    aiError?: string;
  } | null>(null);
  const lastParsedTextRef = useRef('');

  const commitResult = (
    result: IntakeParseResult,
    source: ParseSource,
    mode: ParseMode,
    aiError?: string
  ) => {
    onApplyIntake(result.jobData, result.provenance);
    setLastParseResult({
      fieldsCount: result.extractionSummary.fieldsExtractedCount,
      updatedCount: result.extractionSummary.fieldsUpdatedCount,
      blockingFields: result.blockingMissingFields,
      warnings: result.extractionSummary.warnings,
      sections: result.extractionSummary.sections,
      source,
      mode,
      aiNotes: result.extractionSummary.aiNotes,
      aiError,
    });
  };

  /** AI-first: DeepSeek reads and understands the document; rules parser is the fallback. */
  const handleParse = async (textToParse: string, source: ParseSource = 'manual') => {
    const trimmed = textToParse.trim();
    if (!trimmed || isAnalyzing) return;
    lastParsedTextRef.current = trimmed;

    setIsAnalyzing(true);
    try {
      const payload = await analyzeIntakeWithAi(trimmed);
      const result = applyAiExtractionToJob(payload, currentJob);
      commitResult(result, source, 'ai');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('DeepSeek intake analysis failed:', error);
      const result = parseRawIntakeText(trimmed, currentJob);
      result.extractionSummary.warnings.unshift(
        `AI analysis failed (${message}) - the built-in rules parser was used instead.`
      );
      commitResult(result, source, 'rules', message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Large pastes are parsed the moment they land, so "copy, paste, done" is one step.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData?.getData('text') ?? '';
    if (pasted.trim().length < AUTO_PARSE_MIN_CHARS) return;
    const target = e.currentTarget;
    window.setTimeout(() => {
      const value = target.value;
      if (value.trim() && value.trim() !== lastParsedTextRef.current) {
        void handleParse(value, 'paste');
      }
    }, 60);
  };

  const processFile = async (file: File) => {
    const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
    setUploadedFileInfo({
      name: file.name,
      sizeKb: Math.round(file.size / 1024),
      isPdf,
    });

    if (isPdf) {
      try {
        setIsExtractingPdf(true);
        const arrayBuffer = await file.arrayBuffer();
        const extracted = await extractTextFromPdfBuffer(arrayBuffer);
        if (extracted && extracted.trim()) {
          setIntakeText(extracted);
          handleParse(extracted, 'file');
        } else {
          // If no direct text, put note and attempt metadata
          const fallbackNote = `[PDF Document: ${file.name} (${Math.round(file.size / 1024)} KB)]\nNote: This PDF did not yield standard selectable text (it may be a flattened image scan). Please verify the job fields below or paste the intake text directly.`;
          setIntakeText(fallbackNote);
        }
      } catch (err) {
        console.error('Failed to extract text from PDF:', err);
        const errorNote = `[Error Reading PDF: ${file.name}]\nFailed to extract text. You can still paste the raw DASH notes directly below.`;
        setIntakeText(errorNote);
      } finally {
        setIsExtractingPdf(false);
      }
    } else {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        if (content) {
          setIntakeText(content);
          handleParse(content, 'file');
        }
      };
      reader.readAsText(file);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file);
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const provenanceBadge = (type: FieldProvenanceType) => {
    switch (type) {
      case 'EXTRACTED':
        return <span className="bg-blue-100 text-blue-700 font-bold px-1.5 py-0.5 rounded text-[10px]">EXTRACTED</span>;
      case 'CALCULATED':
        return <span className="bg-emerald-100 text-emerald-700 font-bold px-1.5 py-0.5 rounded text-[10px]">CALCULATED</span>;
      case 'FOUND':
        return <span className="bg-purple-100 text-purple-700 font-bold px-1.5 py-0.5 rounded text-[10px]">FOUND</span>;
      case 'DRAFTED':
        return <span className="bg-amber-100 text-amber-700 font-bold px-1.5 py-0.5 rounded text-[10px]">DRAFTED</span>;
      case 'UNRESOLVED':
        return <span className="bg-rose-100 text-rose-700 font-bold px-1.5 py-0.5 rounded text-[10px]">UNRESOLVED</span>;
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-5 mb-6">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 pb-4 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-slate-100 text-slate-500">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-[15px] font-semibold text-slate-900">
                Intake to Production
              </h3>
              <span className="text-[11px] font-bold bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full border border-slate-200">
                DASH / Xactimate
              </span>
              <span className="text-[11px] font-bold bg-red-50 text-red-600 px-2 py-0.5 rounded-full border border-red-200">
                DeepSeek AI
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Paste DASH job logs, carrier emails, or estimate exports - DeepSeek AI reads the
              document, understands each value, and routes it into the right section automatically
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto">
          <label className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition cursor-pointer flex items-center gap-1.5 shadow-sm border border-slate-700">
            {isExtractingPdf ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-red-400" />
            ) : (
              <Upload className="w-3.5 h-3.5 text-red-400" />
            )}
            {isExtractingPdf ? 'Extracting PDF Data...' : 'Upload PDF / Text Intake'}
            <input
              type="file"
              accept=".pdf,application/pdf,.txt,.json,.csv,.log"
              onChange={handleFileUpload}
              disabled={isExtractingPdf}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {/* Uploaded File Chip */}
      {uploadedFileInfo && (
        <div className="mt-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-1.5 bg-slate-100 border border-slate-200 rounded-lg text-xs">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span className={`font-bold px-1.5 py-0.5 rounded text-[10px] ${uploadedFileInfo.isPdf ? 'bg-red-600 text-white' : 'bg-slate-700 text-white'}`}>
              {uploadedFileInfo.isPdf ? 'PDF DOCUMENT' : 'TEXT FILE'}
            </span>
            <span className="font-semibold text-slate-800 break-all">{uploadedFileInfo.name}</span>
            <span className="text-slate-500 text-[11px]">({uploadedFileInfo.sizeKb} KB)</span>
          </div>
          <span className="text-[11px] text-emerald-700 font-medium flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            Extracted & routed into master record
          </span>
        </div>
      )}

      {/* Input Text Area with Drag & Drop */}
      <div className="mt-4">
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative rounded-xl transition ${
            isDragging
              ? 'ring-2 ring-red-500 bg-red-50/50'
              : ''
          }`}
        >
          {isExtractingPdf && (
            <div className="absolute inset-0 z-10 bg-white/80 backdrop-blur-sm rounded-xl flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-red-600" />
              <span className="text-xs font-bold text-slate-800">
                Extracting text and form fields from PDF...
              </span>
            </div>
          )}
          <textarea
            rows={4}
            value={intakeText}
            onChange={(e) => setIntakeText(e.target.value)}
            onPaste={handlePaste}
            placeholder="Paste DASH intake notes, carrier assignment email, Xactimate recap, or drop a PDF here..."
            className="w-full p-3 text-xs font-mono bg-slate-50 border border-slate-300 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 transition leading-relaxed text-slate-800 placeholder:text-slate-400"
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mt-2.5">
          <span className="text-[11px] text-slate-400">
            Pastes are analyzed by DeepSeek AI automatically - existing entries are only replaced
            when the document provides a new value.
          </span>
          <button
            type="button"
            onClick={() => handleParse(intakeText)}
            disabled={!intakeText.trim() || isExtractingPdf || isAnalyzing}
            className="inline-flex items-center px-4 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-700 text-white transition shadow-sm disabled:opacity-50"
          >
            {isAnalyzing ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
            )}
            {isAnalyzing ? 'DeepSeek AI Analyzing...' : 'AI Analyze & Populate Master Record'}
            {!isAnalyzing && <ArrowRight className="w-3.5 h-3.5 ml-1.5" />}
          </button>
        </div>
      </div>

      {/* Extraction Results: where each pasted value landed */}
      {lastParseResult && (
        <div className="mt-4 pt-4 border-t border-slate-100 text-xs animate-in fade-in">
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="font-bold text-slate-800 flex items-center gap-1.5 flex-wrap">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                Master Job Record Updated — {lastParseResult.fieldsCount} field
                {lastParseResult.fieldsCount === 1 ? '' : 's'} extracted
                {lastParseResult.updatedCount > 0 && (
                  <span className="font-semibold text-emerald-700">
                    · {lastParseResult.updatedCount} new value{lastParseResult.updatedCount === 1 ? '' : 's'} merged
                  </span>
                )}
                <span
                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                    lastParseResult.mode === 'ai'
                      ? 'bg-red-50 text-red-600 border-red-200'
                      : 'bg-slate-100 text-slate-500 border-slate-200'
                  }`}
                >
                  {lastParseResult.mode === 'ai' ? 'AI · DeepSeek' : 'BUILT-IN PARSER'}
                </span>
              </span>
              <span className="text-[10px] text-slate-400">
                {lastParseResult.source === 'paste'
                  ? 'Auto-analyzed from paste'
                  : lastParseResult.source === 'file'
                  ? 'Analyzed from uploaded file'
                  : 'Routed into the master record'}
              </span>
            </div>

            {/* AI analysis notes and failure notice */}
            {lastParseResult.mode === 'ai' && lastParseResult.aiNotes && (
              <div className="mt-2 p-2.5 bg-blue-50 border border-blue-200 rounded-lg text-blue-900 text-[11px] flex items-start gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                <span>
                  <span className="font-semibold">AI analysis:</span> {lastParseResult.aiNotes}
                </span>
              </div>
            )}
            {lastParseResult.aiError && (
              <div className="mt-2 p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-[11px] flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                <span>
                  AI analysis failed: {lastParseResult.aiError} — values were extracted with the
                  built-in rules parser instead.
                </span>
              </div>
            )}

            {/* Section-by-section breakdown of what was routed where */}
            {lastParseResult.sections.length > 0 && (
              <div className="space-y-2 mt-2">
                {lastParseResult.sections.map((section) => (
                  <div key={section.section} className="rounded-lg border border-slate-200 bg-white p-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-600">
                        {section.label}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {section.fields.length} field{section.fields.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {section.fields.map((field) => (
                        <span
                          key={field.key}
                          title={`${field.label}: ${field.value}`}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] max-w-full ${
                            field.changed ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'
                          }`}
                        >
                          <span className="font-semibold text-slate-700 shrink-0">{field.label}:</span>
                          <span className="text-slate-600 truncate max-w-[190px]">{field.value}</span>
                          {provenanceBadge(field.source)}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Anything the parser could not map cleanly */}
            {lastParseResult.warnings.length > 0 && (
              <div className="mt-2.5 p-2.5 bg-orange-50 border border-orange-200 rounded-lg text-orange-900 space-y-1">
                {lastParseResult.warnings.map((warning, index) => (
                  <p key={index} className="text-[11px] flex items-start gap-1.5">
                    <Info className="w-3.5 h-3.5 text-orange-500 shrink-0 mt-0.5" />
                    {warning}
                  </p>
                ))}
              </div>
            )}

            {/* If there are blocking missing fields, present ONE consolidated prompt */}
            {lastParseResult.blockingFields.length > 0 ? (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 mt-2.5">
                <div className="font-bold flex items-center gap-1.5 mb-1 text-xs">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  Consolidated Missing Information (Required before production):
                </div>
                <p className="text-[11px] text-amber-800 mb-1.5">
                  The following core fields could not be extracted from the intake text. Please confirm them in the sections below:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {lastParseResult.blockingFields.map((f, i) => (
                    <span
                      key={i}
                      className="bg-white px-2 py-0.5 rounded border border-amber-300 font-semibold text-[10px] text-amber-900"
                    >
                      • {f}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-emerald-700 text-[11px] mt-2.5">
                ✓ All blocking fields resolved! Production packet is ready for generation.
              </p>
            )}

            {/* Provenance legend */}
            <div className="mt-2.5 pt-2 border-t border-slate-200/80 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
              <span className="font-medium">Legend:</span>
              <span className="flex items-center gap-1">{provenanceBadge('EXTRACTED')} found in the pasted text</span>
              <span className="flex items-center gap-1">{provenanceBadge('CALCULATED')} computed from parsed numbers</span>
              <span className="flex items-center gap-1">{provenanceBadge('FOUND')} branch default</span>
              <span className="flex items-center gap-1">{provenanceBadge('DRAFTED')} written by the parser</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
