import { shallowRef } from 'vue'
import { createSavedReportFile } from '../utils/savedReportFiles.js'
import { indexReportHeadings } from '../utils/savedReportHeadings.js'
import { projectReviewSource, digestReviewSource, readReviewNotesFile, createReviewNotesFile, validateReviewNote, boundReviewDraft, validReviewFilename } from '../utils/savedReportReviewNotes.js'

// One instance per tab; routed components own DOM operations, not this content.
// The optional host supports the existing synthetic Vue fixture. Production uses
// only platform APIs, never storage, a server, or a digest fallback.
export function createReviewStore(host = globalThis) {
  const state = shallowRef({ workspace: null, candidate: null, importing: null, clearChoice: null, feedback: '' })
  let capture = null, activeView = null, handoff = null, download = null, warningInstalled = false
  let navigation = Object.freeze({})
  const token = () => Object.freeze({})
  const stamp = () => {
    const w = state.value.workspace
    return { workspace: w?.id ?? null, notes: w?.notesRevision ?? null, draft: w?.draftRevision ?? null }
  }
  const owns = saved => {
    const now = stamp()
    return now.workspace === saved.workspace && now.notes === saved.notes && now.draft === saved.draft
  }
  const inView = view => view !== null && activeView === view
  const hasWork = () => !!(state.value.workspace?.notes.length || state.value.workspace?.draft?.text.length)
  const unload = event => { if (hasWork()) { event.preventDefault(); event.returnValue = '' } }
  function warning() {
    // Best effort only. A successful download never clears this protection.
    const wanted = hasWork()
    if (wanted === warningInstalled) return
    warningInstalled = wanted
    try {
      if (wanted) host.addEventListener?.('beforeunload', unload)
      else host.removeEventListener?.('beforeunload', unload)
    } catch { warningInstalled = false }
  }
  const set = changes => { state.value = { ...state.value, ...changes }; warning() }
  function release(attempt) {
    if (!attempt) return
    if (download === attempt) download = null
    const { link, url, timer, revoke, clearTimer } = attempt
    attempt.link = null; attempt.url = null; attempt.timer = null
    try { if (timer !== null) clearTimer?.(timer) } catch { /* Own timer only. */ }
    try { link?.remove() } catch { /* URL still needs release. */ }
    try { if (url) revoke?.(url) } catch { /* Never touch another attempt. */ }
  }
  function retireOperations() {
    const old = capture; capture = null; if (old) old.retired = true
    release(download)
  }
  function updateWorkspace(workspace) {
    // Commit the new identities before any host cleanup can reenter.
    set({ workspace, importing: null, clearChoice: null, feedback: '' })
    const old = capture; capture = null; if (old) old.retired = true
  }
  function enterView() { activeView = token(); return activeView }
  function leaveView(view) {
    if (!inView(view)) return
    activeView = null; handoff = null
    set({ importing: null, candidate: null, clearChoice: null, feedback: '' })
    retireOperations()
  }
  function routeChanged(path, keepView = false) {
    const keep = path === '/report-review' && handoff !== null && state.value.candidate === handoff
    handoff = null; if (!keepView) activeView = null; navigation = token()
    set({ importing: null, candidate: keep ? state.value.candidate : null, clearChoice: null, feedback: '' })
    retireOperations()
  }
  function handoffCandidate(candidate) {
    if (state.value.candidate !== candidate) return false
    handoff = candidate; return true
  }
  function beginCapture(source, isCurrent) {
    if (capture) capture.retired = true
    handoff = null
    const attempt = { id: token(), retired: false, saved: stamp() }
    capture = attempt; set({ candidate: null })
    const current = () => {
      if (attempt.retired || capture !== attempt || !owns(attempt.saved)) return false
      let accepted = false
      try { accepted = isCurrent(source) === true } catch { /* Retire permanently. */ }
      if (!accepted) attempt.retired = true
      return accepted && !attempt.retired && capture === attempt && owns(attempt.saved)
    }
    const cancel = () => { attempt.retired = true; if (capture === attempt) capture = null }
    const promise = (async () => {
      try {
        if (!current()) return null
        const snapshot = projectReviewSource(source)
        if (!current()) return null
        const binding = await digestReviewSource(snapshot, current, host)
        if (!current()) return null
        const headings = Object.freeze(indexReportHeadings(snapshot.markdown_content).headings.map(item => Object.freeze({ ...item })))
        if (!current()) return null
        const candidate = Object.freeze({ id: token(), source: snapshot, binding, headings })
        // The staged immutable snapshot is independent of its former parent.
        capture = null; set({ candidate })
        return candidate
      } catch (error) {
        if (!current()) return null
        capture = null
        throw error
      }
    })()
    return { id: attempt.id, promise, cancel }
  }
  function commitNotes(w, notes, draft = null) {
    updateWorkspace(Object.freeze({ ...w, notes: Object.freeze(notes), notesRevision: token(), draft, draftRevision: token() }))
  }
  const noteRecord = note => Object.freeze({ id: token(), heading_start: note.heading_start, text: note.text })
  function actions(view) {
    const saved = stamp(), navigationOwner = navigation, w = state.value.workspace, candidate = state.value.candidate
    const preview = state.value.importing, clearChoice = state.value.clearChoice
    const current = () => inView(view) && navigation === navigationOwner && owns(saved)
    const withWorkspace = () => current() && w !== null
    function draft(next, error = '') {
      if (!withWorkspace()) return
      updateWorkspace(Object.freeze({ ...w, draft: next && Object.freeze(next), draftRevision: token(), draftError: error }))
    }
    async function select(event) {
      if (!withWorkspace()) return
      const target = event.target, count = target.files?.length ?? 0, file = target.files?.[0]
      target.value = ''
      if (!current()) return
      const reading = Object.freeze({ id: token(), loading: count > 0, preview: null, filename: '', error: false })
      set({ importing: count ? reading : null, feedback: '' })
      const owner = () => current() && state.value.importing === reading
      if (!count) return
      try {
        if (count !== 1 || !validReviewFilename(file?.name)) throw new Error('Invalid notes file')
        const filename = file.name
        if (!owner()) return
        const result = await readReviewNotesFile(file, w.binding, w.headings)
        if (owner()) set({ importing: Object.freeze({ ...reading, loading: false, filename, preview: result }) })
      } catch { if (owner()) set({ importing: Object.freeze({ ...reading, loading: false, error: true }) }) }
    }
    function exportFile(kind = 'notes') {
      if (!withWorkspace() || w.draft) return
      const previous = download, attempt = { id: token(), link: null, url: null, timer: null, revoke: null, clearTimer: null }
      download = attempt; release(previous)
      // Payload is fixed at click time. Later edits cannot alter these bytes.
      const owner = () => inView(view) && state.value.workspace?.id === w.id && download === attempt
      const feedback = value => { if (owner() && owns(saved)) set({ feedback: value }) }
      try {
        if (!owner()) return
        const body = kind === 'source' ? createSavedReportFile(w.source) : createReviewNotesFile(w.binding, w.notes.map(({ heading_start, text }) => ({ heading_start, text })), w.headings)
        if (!owner()) return
        const BlobType = host.Blob
        if (!owner()) return
        const blob = new BlobType([body], { type: 'application/json;charset=utf-8' })
        if (!owner()) return
        const urls = host.URL
        if (!owner()) return
        const create = urls?.createObjectURL
        if (!owner()) return
        const revoke = urls?.revokeObjectURL
        if (!owner() || typeof create !== 'function' || typeof revoke !== 'function') throw new Error('Download unavailable')
        attempt.revoke = url => Reflect.apply(revoke, urls, [url])
        attempt.url = Reflect.apply(create, urls, [blob])
        if (!owner()) return
        const document = host.document
        if (!owner()) return
        const createElement = document?.createElement
        if (!owner() || typeof createElement !== 'function') throw new Error('Download unavailable')
        attempt.link = Reflect.apply(createElement, document, ['a'])
        if (!owner()) return
        attempt.link.href = attempt.url
        if (!owner()) return
        attempt.link.download = `${w.source.report_id}.${kind === 'source' ? 'observation' : 'review-notes'}.json`
        if (!owner()) return
        const parent = document.body
        if (!owner()) return
        const append = parent?.appendChild
        if (!owner() || typeof append !== 'function') throw new Error('Download unavailable')
        Reflect.apply(append, parent, [attempt.link])
        if (!owner()) return
        const click = attempt.link.click
        if (!owner() || typeof click !== 'function') throw new Error('Download unavailable')
        Reflect.apply(click, attempt.link, [])
        if (!owner()) return
        feedback('downloadRequested')
        const link = attempt.link; attempt.link = null; link.remove()
        if (!owner()) return
        const setTimer = host.setTimeout
        if (!owner()) return
        const clearTimer = host.clearTimeout
        if (!owner()) return
        attempt.clearTimer = id => Reflect.apply(clearTimer, host, [id])
        attempt.timer = Reflect.apply(setTimer, host, [() => release(attempt), 1000])
      } catch { feedback('downloadFailed'); release(attempt) }
      finally { if (!owner()) release(attempt) }
    }
    return {
      candidate, workspace: w, importing: preview, clearChoice,
      acceptCandidate() {
        if (!current() || !candidate || state.value.candidate !== candidate) return
        const workspace = Object.freeze({ id: token(), source: candidate.source, binding: candidate.binding, headings: candidate.headings,
          notes: Object.freeze([]), notesRevision: token(), draft: null, draftRevision: token(), draftError: '' })
        set({ workspace, candidate: null, importing: null, clearChoice: null, feedback: '' }); handoff = null; retireOperations()
      },
      cancelCandidate() { if (current() && state.value.candidate === candidate) { set({ candidate: null }); handoff = null } },
      askClear() { if (withWorkspace()) set({ clearChoice: { saved, view } }) },
      cancelClear() { if (current() && state.value.clearChoice === clearChoice) set({ clearChoice: null }) },
      confirmClear() {
        if (!withWorkspace() || !clearChoice || state.value.clearChoice !== clearChoice || !owns(clearChoice.saved) || clearChoice.view !== view) return
        set({ workspace: null, importing: null, clearChoice: null, feedback: '' }); retireOperations()
      },
      add() { if (withWorkspace() && !w.draft && w.notes.length < 32) draft({ noteId: null, heading_start: null, text: '', original: null }) },
      edit(id) {
        if (!withWorkspace() || w.draft) return
        const note = w.notes.find(item => item.id === id)
        if (note) draft({ noteId: id, heading_start: note.heading_start, text: note.text, original: note })
      },
      input(text) {
        if (!withWorkspace() || !w.draft) return
        try { boundReviewDraft(text); draft({ ...w.draft, text }) }
        catch { draft(w.draft, 'draftTooLong') }
        return state.value.workspace?.draft?.text
      },
      anchor(value) {
        if (!withWorkspace() || !w.draft) return
        const heading = w.headings.find(item => String(item.lineStart) === value)
        if (value !== '' && !heading) return
        draft({ ...w.draft, heading_start: heading?.lineStart ?? null })
      },
      save() {
        if (!withWorkspace() || !w.draft) return
        try {
          const value = validateReviewNote({ heading_start: w.draft.heading_start, text: w.draft.text }, w.headings)
          if (w.draft.noteId === null) {
            if (w.notes.length >= 32) return
            commitNotes(w, [...w.notes, noteRecord(value)])
          } else {
            if (!w.notes.some(note => note.id === w.draft.noteId)) return
            commitNotes(w, w.notes.map(note => note.id === w.draft.noteId ? noteRecord(value) : note))
          }
        } catch { draft(w.draft, 'invalidNote') }
      },
      discardDraft() { if (withWorkspace() && w.draft) draft(null) },
      remove(id) { if (withWorkspace() && !w.draft && w.notes.some(note => note.id === id)) commitNotes(w, w.notes.filter(note => note.id !== id)) },
      select,
      cancelImport() { if (current() && state.value.importing === preview) set({ importing: null }) },
      openImport() {
        if (!withWorkspace() || w.draft || !preview?.preview || state.value.importing !== preview) return
        commitNotes(w, preview.preview.notes.map(noteRecord))
      },
      exportNotes: () => exportFile('notes'), exportSource: () => exportFile('source'),
      showSection(id, reader) {
        if (!withWorkspace()) return
        const note = w.notes.find(item => item.id === id)
        if (!note || note.heading_start === null) return
        reader?.jumpToHeading(w.source, note.heading_start, () => current() && state.value.workspace?.notes.some(item => item.id === id))
      },
      isCurrentSource: source => inView(view) && state.value.workspace?.id === w?.id && source === w?.source,
      isCurrent: current,
    }
  }
  function dispose() {
    activeView = null; handoff = null
    set({ workspace: null, candidate: null, importing: null, clearChoice: null, feedback: '' }); retireOperations()
  }
  return { state, beginCapture, handoffCandidate, routeChanged, enterView, leaveView, actions, dispose }
}

export const reviewStore = createReviewStore()
