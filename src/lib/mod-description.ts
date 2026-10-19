export interface GeneratedModDescription { text: string; reviewWarnings: string[] }

/** Fail closed instead of copying an unstructured explanation into public notes. */
export function parseModDescription(response: string, evidence: string): GeneratedModDescription {
  const error = 'The model did not return separate release notes and review warnings. Try writing the description again.';
  if (response.length > 24000) throw new Error(error);
  let result: unknown;
  try { result = JSON.parse(response.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')); } catch { throw new Error(error); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(error);
  const { notes, reviewWarnings } = result as Record<string, unknown>;
  if (typeof notes !== 'string' || !notes.trim() || notes.length > 12000 || !Array.isArray(reviewWarnings) || reviewWarnings.length > 20 || reviewWarnings.some(w => typeof w !== 'string' || w.length > 1500)) throw new Error(error);
  const warnings: string[] = [];
  // Coverage warnings do not depend on the model remembering to mention them.
  try {
    const data = JSON.parse(evidence);
    if (data.omittedFiles > 0) warnings.push(`${data.omittedFiles} changed files were omitted from the AI evidence. Review those changes before publishing.`);
    if (Array.isArray(data.evidence)) {
      if (data.evidence.some((e: any) => e.beforeTextTruncated || e.afterTextTruncated)) warnings.push('Some before/after excerpts were shortened. The notes may not cover every change.');
      if (data.evidence.some((e: any) => e.action !== 'added' && !e.earlierTextAvailable && /\.(cs|xml|json|txt|md)$/i.test(e.path ?? ''))) warnings.push('Earlier text is missing for some changed files. Specific before/after behavior cannot be confirmed for those files.');
    }
  } catch { /* Other callers can supply plain evidence; the output contract still applies. */ }
  return { text: notes.trim(), reviewWarnings: [...new Set([...warnings, ...reviewWarnings.map(w => (w as string).trim()).filter(Boolean)])] };
}
