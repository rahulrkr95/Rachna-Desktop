import React, { useState } from 'react'
import { describeSchedule, type AutomationSchedule } from '../lib/automationScheduler'
import { runAutomationNow } from '../services/automationService'
import { useAutomationStore } from '../store/useAutomationStore'
import styles from './AutomationManager.module.css'

export default function AutomationManager({ open, onClose }: { open: boolean; onClose(): void }) {
  const { jobs, toggle, remove, update, globalSoundEnabled, setGlobalSound } = useAutomationStore()
  const [editing, setEditing] = useState<string | null>(null)
  if (!open) return null
  return <div className={styles.backdrop} onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <section className={styles.panel} aria-label="Automation Manager">
      <header><div><h2>Automation Manager</h2><p>Scheduled work reuses the normal planner and agent execution pipeline.</p></div><button onClick={onClose}>✕</button></header>
      <div className={styles.toolbar}><strong>{jobs.length} automation{jobs.length === 1 ? '' : 's'}</strong><label><input type="checkbox" checked={globalSoundEnabled} onChange={e => setGlobalSound(e.target.checked)} /> Notification sounds</label></div>
      <div className={styles.list}>{jobs.length === 0 && <div className={styles.empty}>No automations yet. Ask the agent to “remind me…”, “run this every…”, or use a cron expression.</div>}
        {jobs.map(job => <article className={styles.card} key={job.id}>
          <div className={styles.title}><div><h3>{job.name}</h3><span className={`${styles.status} ${styles[job.status]}`}>{job.status}</span><span className={styles.status} title={job.kind === 'no_ai' ? 'Runs via terminal only, no AI call' : 'Routed through the AI chat pipeline'}>{job.kind === 'no_ai' ? 'terminal only' : 'AI'}</span></div><small>{describeSchedule(job.schedule)}</small></div>
          {editing === job.id ? <EditForm job={job} onSave={(request, schedule, soundEnabled) => { update(job.id, { request, name: request.slice(0, 64), schedule, soundEnabled }); setEditing(null) }} onCancel={() => setEditing(null)} /> : <p className={styles.request}>{job.request}</p>}
          <dl><div><dt>Next run</dt><dd>{job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : '—'}</dd></div><div><dt>Last run</dt><dd>{job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : 'Never'}</dd></div></dl>
          <div className={styles.actions}><button onClick={() => toggle(job.id)}>{job.enabled ? 'Pause' : 'Resume'}</button><button onClick={() => setEditing(job.id)}>Edit</button><button onClick={() => void runAutomationNow(job.id)}>Run now</button><button className={styles.delete} onClick={() => remove(job.id)}>Delete</button></div>
          {job.history.length > 0 && <details><summary>Execution history ({job.history.length})</summary>{job.history.map(item => <div className={styles.history} key={item.id}><span>{item.status}</span><time>{new Date(item.startedAt).toLocaleString()}</time>{item.message && <em>{item.message}</em>}</div>)}</details>}
        </article>)}
      </div>
    </section>
  </div>
}

function EditForm({ job, onSave, onCancel }: { job: { request: string; schedule: AutomationSchedule; soundEnabled: boolean }; onSave(r: string, s: AutomationSchedule, sound: boolean): void; onCancel(): void }) {
  const [request, setRequest] = useState(job.request); const [schedule, setSchedule] = useState(JSON.stringify(job.schedule, null, 2)); const [sound, setSound] = useState(job.soundEnabled); const [error, setError] = useState('')
  return <div className={styles.edit}><textarea value={request} onChange={e => setRequest(e.target.value)} /><label>Schedule metadata<textarea value={schedule} onChange={e => setSchedule(e.target.value)} /></label><label><input type="checkbox" checked={sound} onChange={e => setSound(e.target.checked)} /> Sound for this automation</label>{error && <b>{error}</b>}<div><button onClick={() => { try { onSave(request, JSON.parse(schedule), sound) } catch { setError('Schedule must be valid JSON.') } }}>Save</button><button onClick={onCancel}>Cancel</button></div></div>
}
