// Minimal checker for report-schema.json (spike only; the product uses
// validate-findings.cjs + Zod). Returns a list of problems, empty when valid.
export function validateReport(value) {
  const problems = [];
  const severities = ['critical', 'high', 'medium', 'low'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['not an object'];
  }
  const allowedTop = ['run_status', 'findings'];
  for (const key of Object.keys(value)) {
    if (!allowedTop.includes(key)) {
      problems.push(`extra key ${key}`);
    }
  }
  if (!['complete', 'incomplete'].includes(value.run_status)) {
    problems.push('bad run_status');
  }
  if (!Array.isArray(value.findings)) {
    return [...problems, 'findings not an array'];
  }
  const fields = ['title', 'severity', 'class', 'file', 'line', 'evidence', 'status'];
  value.findings.forEach((finding, index) => {
    for (const key of Object.keys(finding ?? {})) {
      if (!fields.includes(key)) {
        problems.push(`findings[${index}] extra key ${key}`);
      }
    }
    for (const key of fields) {
      if (finding?.[key] === undefined) {
        problems.push(`findings[${index}] missing ${key}`);
      }
    }
    if (!severities.includes(finding?.severity)) {
      problems.push(`findings[${index}] bad severity`);
    }
    if (!Number.isInteger(finding?.line)) {
      problems.push(`findings[${index}] bad line`);
    }
    if (!['confirmed', 'needs_validation'].includes(finding?.status)) {
      problems.push(`findings[${index}] bad status`);
    }
  });
  return problems;
}
