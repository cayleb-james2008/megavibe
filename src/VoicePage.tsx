import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import { inDesktopApp, invoke } from './bridge'

export type VoiceAction =
  | { kind: 'note'; title: string; content: string }
  | { kind: 'checklist'; title: string; items: string[] }
  | { kind: 'kanban'; title: string; tasks: Array<{ text: string; status: 'todo' | 'doing' | 'done' }> }

type VoicePlan = { transcript: string; reply: string; actions: VoiceAction[] }
type VoiceModel = { id: string; name: string; sizeBytes: number; installed: boolean }
type DownloadProgress = { modelId: string; downloadedBytes: number; totalBytes: number }
type VoiceStatus = { ready: boolean; microphoneAvailable: boolean; models: VoiceModel[]; isRecording: boolean; isDownloading: boolean; downloadProgress?: DownloadProgress | null }

function formatBytes(bytes: number) {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  return `${Math.round(bytes / 1_000_000)} MB`
}

export function VoicePage({ boardContext, onApply }: { boardContext: string; onApply: (actions: VoiceAction[]) => void }) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [processing, setProcessing] = useState(false)
  const [text, setText] = useState('')
  const [plan, setPlan] = useState<VoicePlan | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  const downloadingRef = useRef(downloading)
  downloadingRef.current = downloading
  const mountedRef = useRef(false)
  const recordingStartPendingRef = useRef(false)

  useEffect(() => {
    if (!inDesktopApp) return
    let active = true
    mountedRef.current = true
    const refresh = () => invoke<VoiceStatus>('voice_status').then((next) => {
      if (!active) return
      setStatus(next)
      setDownloading(next.isDownloading)
      downloadingRef.current = next.isDownloading
      setProgress(next.downloadProgress ?? null)
      if (next.isRecording) {
        recordingRef.current = true
        setRecording(true)
      }
    }).catch((reason) => {
      if (active) setError(String(reason))
    })
    void refresh()
    const unlistenProgress = listen<DownloadProgress>('voice-download-progress', ({ payload }) => setProgress(payload))
    const unlistenComplete = listen('voice-download-complete', () => {
      setDownloading(false)
      setProgress(null)
      void refresh()
    })
    return () => {
      active = false
      mountedRef.current = false
      void unlistenProgress.then((stop) => stop())
      void unlistenComplete.then((stop) => stop())
      if (recordingRef.current || recordingStartPendingRef.current) void invoke('voice_cancel_recording').catch(() => undefined)
      audioRef.current?.pause()
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    }
  }, [])

  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => setRecordingSeconds((seconds) => {
      if (seconds + 1 >= 60) window.setTimeout(() => void finishRecording(), 0)
      return Math.min(60, seconds + 1)
    }), 1000)
    return () => window.clearInterval(timer)
  }, [recording])

  async function refreshStatus() {
    const next = await invoke<VoiceStatus>('voice_status')
    setStatus(next)
    setDownloading(next.isDownloading)
    downloadingRef.current = next.isDownloading
    setProgress(next.downloadProgress ?? null)
    if (next.isRecording) {
      recordingRef.current = true
      setRecording(true)
    }
  }

  async function startRecording() {
    setError('')
    setPlan(null)
    setRecordingSeconds(0)
    recordingStartPendingRef.current = true
    try {
      await invoke('voice_start_recording')
      if (!mountedRef.current) {
        await invoke('voice_cancel_recording').catch(() => undefined)
        return
      }
      recordingRef.current = true
      setRecording(true)
    } catch (reason) {
      if (mountedRef.current) setError(String(reason))
    } finally {
      recordingStartPendingRef.current = false
    }
  }

  async function finishRecording() {
    recordingRef.current = false
    setRecording(false)
    setProcessing(true)
    setError('')
    try {
      const result = await invoke<VoicePlan>('voice_stop_recording_and_plan', { boardContext })
      setPlan(result)
      setSelected(result.actions.map((_, index) => index))
      void refreshStatus()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setProcessing(false)
    }
  }

  async function submitText(event: FormEvent) {
    event.preventDefault()
    if (!text.trim()) return
    setError('')
    setPlan(null)
    setProcessing(true)
    try {
      const result = await invoke<VoicePlan>('voice_plan_text', { text: text.trim(), boardContext })
      setPlan(result)
      setSelected(result.actions.map((_, index) => index))
    } catch (reason) {
      setError(String(reason))
    } finally {
      setProcessing(false)
    }
  }

  async function downloadModels() {
    setError('')
    downloadingRef.current = true
    setDownloading(true)
    setProgress(null)
    try {
      await invoke('voice_download_models')
    } catch (reason) {
      if (mountedRef.current) setError(String(reason))
    } finally {
      downloadingRef.current = false
      if (mountedRef.current) {
        setDownloading(false)
        setProgress(null)
        void refreshStatus().catch((reason) => setError(String(reason)))
      }
    }
  }

  async function cancelDownload() {
    try {
      await invoke('voice_cancel_download')
    } catch (reason) {
      setError(String(reason))
    }
  }

  async function speakReply() {
    if (!plan || !plan.reply) return
    setError('')
    setSpeaking(true)
    try {
      const wavBase64 = await invoke<string>('voice_synthesize', { text: plan.reply.slice(0, 1000) })
      audioRef.current?.pause()
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
      const bytes = Uint8Array.from(atob(wavBase64), (character) => character.charCodeAt(0))
      const audioUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }))
      audioUrlRef.current = audioUrl
      const audio = new Audio(audioUrl)
      audioRef.current = audio
      audio.onended = () => setSpeaking(false)
      audio.onerror = () => { setSpeaking(false); setError('The local voice reply could not be played.') }
      await audio.play()
    } catch (reason) {
      setSpeaking(false)
      setError(String(reason))
    }
  }

  function toggleSelected(index: number) {
    setSelected((current) => current.includes(index) ? current.filter((item) => item !== index) : [...current, index])
  }

  const ready = Boolean(status?.ready)
  const activeDownload = progress && status?.models.find((model) => model.id === progress.modelId)
  const percent = progress && progress.totalBytes > 0 ? Math.min(100, Math.floor(progress.downloadedBytes / progress.totalBytes * 100)) : 0

  return (
    <div className="secondary-page voice-page">
      <div className="voice-inner">
        <header className="page-intro">
          <div>
            <span className="eyebrow">LOCAL VOICE WORKSPACE</span>
            <h1>Voice planner</h1>
            <p>Talk through the next step. Megavibe transcribes and plans on this device, then waits for you to approve board changes.</p>
          </div>
          <span className={`local-only-pill ${ready ? 'ready' : ''}`}><i />{ready ? 'Models ready · offline' : 'On-device models'}</span>
        </header>

        {!inDesktopApp && <div className="voice-alert" role="status">Voice engines are available in the Linux desktop app.</div>}
        {error && <div className="voice-alert" role="alert">{error}</div>}

        <div className="voice-layout">
          <section className="voice-panel voice-capture-panel">
            <div className="voice-panel-heading"><div><span className="eyebrow">SPEAK OR TYPE</span><h2>Plan with your board</h2></div><span className="voice-panel-icon">◖</span></div>
            <p className="voice-copy">The planner sees the active workspace name and board notes, checklists, and tasks. It never receives terminal output.</p>
            <div className="voice-recording-row">
              <button className={`button voice-record-button ${recording ? 'recording' : ''}`} disabled={!ready || !status?.microphoneAvailable || processing || downloading} onClick={recording ? () => void finishRecording() : () => void startRecording()}>
                <span aria-hidden="true">{recording ? '■' : '●'}</span>{recording ? 'Stop and plan' : 'Start recording'}
              </button>
              <span className="voice-recording-status" role="status">{recording ? `Recording · ${recordingSeconds}s / 60s` : processing ? 'Transcribing and planning locally…' : status?.microphoneAvailable ? 'Microphone ready' : 'No microphone detected'}</span>
            </div>
            <p className="voice-privacy-note">Recording starts only when you press the button. Audio stays in memory and is discarded after transcription.</p>
            <form className="voice-text-form" onSubmit={(event) => void submitText(event)}>
              <label htmlFor="voice-request">Or write the request</label>
              <textarea id="voice-request" value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} placeholder="For example: make a checklist to review the new onboarding flow" disabled={!ready || processing || recording} />
              <div className="voice-form-foot"><small>{text.length}/4000 · processed on this device</small><button className="button button-outline" type="submit" disabled={!ready || processing || !text.trim()}>Plan request</button></div>
            </form>
            {recording && <button className="voice-cancel-recording" onClick={() => { recordingRef.current = false; setRecording(false); void invoke('voice_cancel_recording').catch((reason) => setError(String(reason))) }}>Discard recording</button>}
          </section>

          <section className="voice-panel voice-model-panel">
            <div className="voice-panel-heading"><div><span className="eyebrow">LOCAL ENGINES</span><h2>Voice setup</h2></div><span className="voice-panel-icon">⌘</span></div>
            <p className="voice-copy">Download the speech-recognition and planning models once. Spoken replies use Megavibe's built-in US English voice; all processing runs on this device without an account, API key, or voice service.</p>
            {status?.models.length ? <ul className="voice-model-list">{status.models.map((model) => <li key={model.id}><span className={`voice-model-check ${model.installed ? 'installed' : ''}`}>{model.installed ? '✓' : '·'}</span><span><strong>{model.name}</strong><small>{model.installed ? 'Ready on this device' : formatBytes(model.sizeBytes)}</small></span></li>)}</ul> : <p className="voice-copy">Checking available models…</p>}
            {downloading && <div className="voice-download-progress" role="status"><div><span>{activeDownload ? `Downloading ${activeDownload.name}` : 'Preparing model downloads'}</span><strong>{progress ? `${percent}%` : ''}</strong></div><progress max={100} value={percent} /><small>{progress ? `${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}` : 'Large files are stored in Megavibe app data.'}</small></div>}
            <div className="voice-model-actions"><button className="button button-primary" onClick={() => void downloadModels()} disabled={!inDesktopApp || ready || downloading}>{downloading ? 'Downloading…' : ready ? 'Voice ready' : 'Download voice models'}</button>{downloading && <button className="button button-outline" onClick={() => void cancelDownload()}>Cancel</button>}</div>
            <p className="voice-model-footnote">Model files are fetched from their public open-source repositories and verified before use. Spoken replies use a built-in 16 kHz voice, so they need no extra download. After setup, voice planning and speech work offline.</p>
          </section>
        </div>

        {plan && <section className="voice-plan-panel">
          <div className="voice-panel-heading"><div><span className="eyebrow">REVIEW BEFORE APPLYING</span><h2>Your plan</h2></div><span className="voice-action-count">{plan.actions.length} board {plan.actions.length === 1 ? 'change' : 'changes'}</span></div>
          {plan.transcript && <div className="voice-transcript"><strong>Heard</strong><p>{plan.transcript}</p></div>}
          <div className="voice-reply"><div><strong>Megavibe</strong><p>{plan.reply || 'Here is a draft based on your request.'}</p></div><button className="button button-outline" onClick={() => void speakReply()} disabled={!ready || speaking || !plan.reply}>{speaking ? 'Speaking…' : 'Speak reply'}</button></div>
          {plan.actions.length > 0 ? <>
            <div className="voice-action-list">{plan.actions.map((action, index) => {
              const details = action.kind === 'note' ? action.content : action.kind === 'checklist'
                ? action.items.map((item) => `• ${item}`).join('  ')
                : action.tasks.map((task) => `• ${task.text} (${task.status})`).join('  ')
              return <label className="voice-action-row" key={`${action.kind}-${index}`}><input type="checkbox" checked={selected.includes(index)} onChange={() => toggleSelected(index)} /><span><strong>{action.title}</strong><small title={details}>{details.slice(0, 320)}{details.length > 320 ? '…' : ''} · {action.kind}</small></span></label>
            })}</div>
            <div className="voice-plan-footer"><span>Nothing is added until you approve it.</span><button className="button button-primary" disabled={selected.length === 0} onClick={() => { onApply(plan.actions.filter((_, index) => selected.includes(index))); setPlan(null) }}>Add selected to board</button></div>
          </> : <p className="voice-copy voice-no-actions">No board changes were suggested. You can try a more specific request.</p>}
        </section>}
      </div>
    </div>
  )
}
