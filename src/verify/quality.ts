/** A pixel score is evidence, not a promise of functional or responsive parity. */
export interface PageMeasurement {
  route: string;
  rendered: boolean;
  pixelMatch: number | null;
  note?: string;
}

export interface QualityReport {
  pass: boolean;
  threshold: number;
  checks: { route: string; pass: boolean; score: number | null; reason?: string }[];
  issues: string[];
}

/** Reject bad configuration rather than silently weakening the acceptance gate. */
export function pixelThreshold(value: string | number | undefined): number {
  if (typeof value === 'string' && !value.trim()) throw new Error('MOLT_MIN_PIXEL_MATCH cannot be empty');
  const number = value === undefined ? 95 : Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100) {
    throw new Error('MOLT_MIN_PIXEL_MATCH must be a finite number greater than 0 and at most 100');
  }
  return number;
}

export function assessQuality(
  routes: readonly string[],
  measurements: readonly PageMeasurement[],
  structuralPass: boolean,
  threshold = 95,
): QualityReport {
  threshold = pixelThreshold(threshold);
  const issues: string[] = [];
  if (!structuralPass) issues.push('Generated project failed structural checks');
  if (!routes.length) issues.push('No routes were requested');
  if (new Set(routes).size !== routes.length) issues.push('Duplicate requested routes');
  const expected = new Set(routes);
  if (measurements.some((m) => !expected.has(m.route))) issues.push('Unexpected render result');

  const checks = routes.map((route) => {
    const matches = measurements.filter((m) => m.route === route);
    const m = matches[0];
    let reason: string | undefined;
    const validScore = m && typeof m.pixelMatch === 'number'
      && Number.isFinite(m.pixelMatch) && m.pixelMatch >= 0 && m.pixelMatch <= 100;
    if (matches.length !== 1) reason = matches.length ? 'Duplicate render results' : 'No generated-page render';
    else if (!m.rendered) reason = m.note || 'Generated page did not render';
    else if (m.note) reason = m.note;
    else if (!validScore) reason = 'Visual match has not been measured';
    else if (m.pixelMatch! < threshold) reason = `Visual match ${m.pixelMatch}% is below ${threshold}%`;
    return { route, pass: !reason, score: validScore ? m.pixelMatch : null, ...(reason ? { reason } : {}) };
  });
  return { pass: issues.length === 0 && checks.every((c) => c.pass), threshold, checks, issues };
}
