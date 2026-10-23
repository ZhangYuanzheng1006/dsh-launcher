import { describe, expect, it } from 'vitest'
import {
  appendBounded,
  cpuUsagePercent,
  formatByteRate,
  formatBytes,
  networkRate
} from '../src/shared/s6s7-pure'

describe('S6/S7 pure helpers', () => {
  it('keeps sample history bounded to the newest 60 entries', () => {
    const values = Array.from({ length: 60 }, (_, index) => index)
    expect(appendBounded(values, 60, 60)).toHaveLength(60)
    expect(appendBounded(values, 60, 60)[0]).toBe(1)
    expect(appendBounded(values, 60, 60)[59]).toBe(60)
  })

  it('computes CPU usage from cumulative idle/total deltas', () => {
    expect(cpuUsagePercent({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBe(50)
    expect(cpuUsagePercent({ idle: 100, total: 200 }, { idle: 200, total: 300 })).toBe(0)
    expect(cpuUsagePercent({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBe(0)
  })

  it('computes receive/send byte rates and rejects stale counters', () => {
    expect(networkRate({ rx: 1_000, tx: 2_000, at: 10_000 }, { rx: 3_000, tx: 5_000, at: 12_000 })).toEqual({
      rxBytesPerSec: 1_000,
      txBytesPerSec: 1_500
    })
    expect(networkRate({ rx: 3_000, tx: 5_000, at: 12_000 }, { rx: 1_000, tx: 2_000, at: 12_000 })).toEqual({
      rxBytesPerSec: 0,
      txBytesPerSec: 0
    })
    expect(networkRate(null, { rx: 1, tx: 2, at: 3 })).toEqual({ rxBytesPerSec: 0, txBytesPerSec: 0 })
  })

  it('formats file sizes and network rates without NaN output', () => {
    expect(formatBytes(0)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(formatByteRate(1536)).toBe('1.5 KB/s')
    expect(formatByteRate(Number.NaN)).toBe('0 B/s')
  })
})
