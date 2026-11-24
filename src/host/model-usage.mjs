const isCount = value => Number.isSafeInteger(value) && value >= 0

export function normalizeModelUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const { inputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens } = usage
  if (![inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens].every(isCount)) return undefined
  const input = inputTokens + cacheReadTokens + cacheWriteTokens
  return isCount(input) ? { input, output: outputTokens } : undefined
}

export function modelUsageTotals(totals, requests) {
  if (!totals || !isCount(requests) || ![totals.input, totals.output, totals.reported].every(isCount)
    || !totals.reported || totals.reported > requests) return undefined
  const { input, output, reported } = totals
  return { input, output, reported }
}

export function addModelUsage(totals, usage) {
  if (!usage || !isCount(usage.input) || !isCount(usage.output)) return totals
  const prior = modelUsageTotals(totals, Number.MAX_SAFE_INTEGER)
  const next = {
    input: (prior?.input ?? 0) + usage.input,
    output: (prior?.output ?? 0) + usage.output,
    reported: (prior?.reported ?? 0) + 1,
  }
  return [next.input, next.output, next.reported].every(isCount) ? next : totals
}
