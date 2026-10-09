// Only rejected terminal prose is compacted. Verified answers and tool results
// retain their original content; a compacted reply is never completion evidence.
export function rejectedCompletionRecovery(content, finishReason = '') {
  const text = String(content || '');
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const counts = new Map();
  const repeated = paragraphs.some(p => {
    if (p.length < 80) return false;
    const n = (counts.get(p) || 0) + 1;
    counts.set(p, n);
    return n >= 3;
  });
  if (!repeated && !['length', 'max_tokens', 'max_output_tokens'].includes(finishReason)) {
    return { content: text, abbreviated: false, nudge: '' };
  }
  const excerpt = [...new Set(paragraphs)].join('\n\n').slice(0, 2000);
  return {
    content: '[Rejected incomplete or repetitive response; this is not evidence of completion.]\n' + excerpt,
    abbreviated: true,
    nudge: 'Your previous reply was repetitive or hit the output limit. Do not repeat it. Use the latest tool evidence and the offered verification/completion tools; give a concise, honest result. If the action is unverified, use a partial or failed outcome.',
  };
}
