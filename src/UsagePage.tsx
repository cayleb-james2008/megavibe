import { useEffect, useMemo, useState } from 'react'
import type { CliProfile } from './model'
import { inDesktopApp, invoke } from './bridge'
import { Icon } from './Icons'

type UsageSeries = { cli: string; profileId: string | null; daily: number[]; total: number }
type UsageAnalytics = { days: number; dates: string[]; series: UsageSeries[]; filesScanned: number; filesSkipped: number; recordsSkipped: boolean }
type UsagePeriod = { label: string; usedPercent: number }
type UsageProbe = { cli: string; checkedAt: number; periods: UsagePeriod[]; message: string }

const CLIS = [
  { command: 'claude', label: 'Claude Code', icon: 'C' },
  { command: 'codex', label: 'Codex', icon: '◈' },
  { command: 'gemini', label: 'Gemini CLI', icon: '✦' },
]

export function UsagePage({ profiles }: { profiles: CliProfile[] }) {
  const [days, setDays] = useState(30)
  const [analytics, setAnalytics] = useState<UsageAnalytics | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [probes, setProbes] = useState<Record<string, UsageProbe>>({})
  const [probing, setProbing] = useState('')
  const [probeError, setProbeError] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!inDesktopApp) {
      setLoadError('Local session analytics are available in the Linux desktop app.')
      return () => { cancelled = true }
    }
    setLoading(true)
    setLoadError('')
    invoke<UsageAnalytics>('load_usage_analytics', { days, profileIds: profiles.map((profile) => profile.id) })
      .then((result) => { if (!cancelled) setAnalytics(result) })
      .catch((reason: unknown) => { if (!cancelled) setLoadError(String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days, profiles])

  const profileNames = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile.name])), [profiles])
  const maxDaily = Math.max(1, ...(analytics?.dates.map((_, index) => analytics.series.reduce((sum, series) => sum + (series.daily[index] ?? 0), 0)) ?? []))
  const totalTokens = analytics?.series.reduce((sum, series) => sum + series.total, 0) ?? 0

  async function check(cli: string, profileId?: string) {
    const key = `${cli}:${profileId ?? 'default'}`
    setProbing(key)
    setProbeError('')
    try {
      const result = await invoke<UsageProbe>('probe_cli_usage', { cli, profileId: profileId ?? null })
      setProbes((current) => ({ ...current, [key]: result }))
    } catch (reason) {
      setProbeError(`${cli}${profileId ? ` (${profileNames.get(profileId) ?? 'profile'})` : ''}: ${String(reason)}`)
    } finally {
      setProbing('')
    }
  }

  return <div className="secondary-page usage-page">
    <div className="page-intro"><div><h1>Usage</h1><p>Local session token totals and on-demand CLI status checks.</p></div><span className="local-only-pill"><i /> Logs stay on this device</span></div>

    <section className="usage-probes usage-section" aria-labelledby="usage-probes-title">
      <div className="usage-section-heading"><div><h2 id="usage-probes-title">CLI usage</h2><p>Run a fixed read-only status command in the selected CLI account.</p></div></div>
      <div className="usage-cli-grid">{CLIS.map((cli) => {
        const matchingProfiles = profiles.filter((profile) => profile.command.split('/').pop() === cli.command)
        const rows = [{ id: undefined as string | undefined, label: 'Default account' }, ...matchingProfiles.map((profile) => ({ id: profile.id, label: profile.name }))]
        return <article className="usage-cli-card" key={cli.command}><header><span className="usage-cli-icon">{cli.icon}</span><strong>{cli.label}</strong><span className="usage-cli-supported">SUPPORTED</span></header>
          {rows.map((row) => {
            const key = `${cli.command}:${row.id ?? 'default'}`
            const result = probes[key]
            return <div className="usage-probe-row" key={key}><div><span>{row.label}</span>{result && <small>{result.periods.length ? result.periods.map((period) => `${period.label} ${period.usedPercent}% used`).join(' · ') : result.message}</small>}</div><button className="button button-outline" onClick={() => void check(cli.command, row.id)} disabled={!inDesktopApp || Boolean(probing)}>{probing === key ? 'Checking…' : result ? 'Refresh' : 'Check usage'}</button></div>
          })}
        </article>
      })}</div>
      <p className="usage-disclosure">Each check launches the installed CLI with a fixed slash command and basic terminal settings. It can use sign-in state in that CLI profile and may contact the CLI provider to show account limits. Megavibe does not pass API-key environment variables or send session logs, prompts, project paths, or workspace data.</p>
      {probeError && <p className="usage-error" role="alert">{probeError}</p>}
    </section>

    <section className="usage-analytics usage-section" aria-labelledby="usage-analytics-title">
      <div className="usage-section-heading"><div><h2 id="usage-analytics-title">Tokens by day and CLI</h2><p>Parsed from supported local session logs. Counts are approximate and are not billing totals.</p></div><label className="usage-range">RANGE<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label></div>
      {loading && !analytics ? <div className="usage-empty">Reading local session metadata…</div> : loadError ? <div className="usage-empty usage-error">{loadError}</div> : analytics && totalTokens === 0 ? <div className="usage-empty"><strong>No supported token records in this range</strong><span>Megavibe checked local Claude Code, Codex, and Gemini CLI session folders for {analytics.days} days. {analytics.filesSkipped ? `${analytics.filesSkipped} files exceeded scan limits or could not be read.` : ''} {analytics.recordsSkipped ? 'Some records were malformed or omitted by safety limits.' : ''}</span></div> : analytics && <>
        <div className="usage-chart-summary"><strong>{formatTokens(totalTokens)}</strong><span>tokens recorded in {analytics.days} days</span><small>{analytics.filesScanned} files read · {analytics.filesSkipped} skipped</small></div>
        <div className="usage-chart" style={{ gridTemplateColumns: `repeat(${analytics.dates.length}, minmax(0, 1fr))`, gap: analytics.days === 90 ? '1px' : analytics.days === 30 ? '4px' : '9px' }} role="img" aria-label={`Daily token totals by CLI over ${analytics.days} days`}>
          {analytics.dates.map((date, index) => {
            const labelEvery = analytics.days === 7 ? 1 : analytics.days === 30 ? 5 : 15
            const visible = index === 0 || index === analytics.dates.length - 1 || index % labelEvery === 0
            const dayTotal = analytics.series.reduce((sum, series) => sum + (series.daily[index] ?? 0), 0)
            return <div className="usage-chart-day" key={date} title={`${date}: ${formatTokens(dayTotal)} tokens`}><div className="usage-bar-stack">{analytics.series.map((series) => {
              const value = series.daily[index] ?? 0
              return value > 0 ? <span key={`${series.cli}:${series.profileId ?? ''}`} className={`usage-bar-segment ${cliClass(series.cli)}`} style={{ height: `${Math.max(1, value / maxDaily * 100)}%` }} title={`${series.cli}${series.profileId ? ` · ${profileNames.get(series.profileId) ?? 'Profile'}` : ''}: ${formatTokens(value)}`} /> : null
            })}</div><small>{visible ? formatDate(date, analytics.days > 7) : ''}</small></div>
          })}
        </div>
        <div className="usage-legend">{analytics.series.map((series) => <span key={`${series.cli}:${series.profileId ?? ''}`}><i className={cliClass(series.cli)} />{series.cli}{series.profileId ? ` · ${profileNames.get(series.profileId) ?? 'Profile'}` : ''}<b>{formatTokens(series.total)}</b></span>)}</div>
        <div className="usage-agent-list">{analytics.series.map((series) => <div className="usage-agent-row" key={`${series.cli}:${series.profileId ?? ''}`}><span><i className={cliClass(series.cli)} />{series.cli}{series.profileId ? ` · ${profileNames.get(series.profileId) ?? 'Profile'}` : ''}</span><strong>{formatTokens(series.total)}</strong></div>)}</div>
        {(analytics.filesSkipped > 0 || analytics.recordsSkipped) && <p className="usage-scan-note">{analytics.filesSkipped ? `${analytics.filesSkipped} files could not be read or exceeded scan limits. ` : ''}{analytics.recordsSkipped ? 'Malformed records or the one-million-record safety limit omitted data. ' : ''}Totals may be incomplete.</p>}
      </>}
    </section>

    <div className="feature-note"><span><Icon name="check" size={11} /></span><div><strong>Private local analytics</strong><p>Log parsing reads token metadata only and ignores message text and prompt fields. Supported formats and known limits are documented in docs/USAGE.md.</p></div></div>
  </div>
}

function formatTokens(value: number) {
  return new Intl.NumberFormat(undefined, { notation: value >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function formatDate(value: string, compact: boolean) {
  const date = new Date(`${value}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: compact ? undefined : 'numeric' }).format(date)
}

function cliClass(cli: string) {
  return cli === 'Claude Code' ? 'claude' : cli === 'Codex' ? 'codex' : 'gemini'
}
