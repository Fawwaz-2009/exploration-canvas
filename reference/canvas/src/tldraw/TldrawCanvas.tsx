import {
  Tldraw,
  createShapeId,
  AssetRecordType,
  type Editor,
  type TLAsset,
  type TLCreateShapePartial,
  type TLShape,
} from 'tldraw'
import { ArtifactShapeUtil } from './ArtifactShape'
import { fetchCanvas, saveFrame, saveCanvasMeta } from '../lib/api'
import type { CanvasDoc, Tile } from '../types'

const shapeUtils = [ArtifactShapeUtil]

// the file-backed shapes (everything else — sticky notes, arrows — is canvas-only)
type FileShape = Extract<TLShape, { type: 'artifact' | 'image' }>

function tileIdOf(s: TLShape): string | null {
  return typeof s.meta.tileId === 'string' ? s.meta.tileId : null
}

function artifactToShape(a: Tile): { shape: TLCreateShapePartial; asset?: TLAsset } {
  const id = createShapeId(a.id)
  const meta = { tileId: a.id, path: a.path || '' }
  if (a.kind === 'image') {
    const asset = AssetRecordType.create({
      type: 'image',
      props: {
        name: a.entry || a.id,
        src: `/_artifact/${a.id}/${a.entry}`,
        w: a.frame.w,
        h: a.frame.h,
        mimeType: (a.entry || '').endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        isAnimated: false,
      },
      meta: {},
    })
    return {
      asset,
      shape: { id, type: 'image', x: a.frame.x, y: a.frame.y, props: { w: a.frame.w, h: a.frame.h, assetId: asset.id }, meta },
    }
  }
  return {
    shape: {
      id,
      type: 'artifact',
      x: a.frame.x,
      y: a.frame.y,
      props: { w: a.frame.w, h: a.frame.h, tileId: a.id, kind: a.kind, title: a.title, entry: a.entry || '' },
      meta,
    },
  }
}

// Make the store's file-backed shapes match the files exactly: add new artifacts,
// update changed ones, remove deleted ones. Non-artifact shapes are left alone.
// Idempotent — safe to call on every file change.
function reconcile(editor: Editor, doc: CanvasDoc, initial: boolean) {
  const existing = new Map<string, FileShape>()
  for (const sid of editor.getCurrentPageShapeIds()) {
    const s = editor.getShape(sid)
    if (!s || (s.type !== 'artifact' && s.type !== 'image')) continue
    const tileId = tileIdOf(s)
    if (tileId) existing.set(tileId, s)
  }

  const newShapes: TLCreateShapePartial[] = []
  const newAssets: TLAsset[] = []
  const seen = new Set<string>()

  for (const a of doc.artifacts) {
    seen.add(a.id)
    const cur = existing.get(a.id)
    if (!cur) {
      const { shape, asset } = artifactToShape(a)
      if (asset) newAssets.push(asset)
      newShapes.push(shape)
      continue
    }
    if (editor.getEditingShapeId() === cur.id) continue // don't disturb an active edit
    const f = a.frame
    const moved =
      Math.round(cur.x) !== f.x || Math.round(cur.y) !== f.y || Math.round(cur.props.w) !== f.w || Math.round(cur.props.h) !== f.h
    if (cur.type === 'image') {
      if (moved) editor.updateShape({ id: cur.id, type: 'image', x: f.x, y: f.y, props: { w: f.w, h: f.h } })
    } else {
      const propsChanged = cur.props.kind !== a.kind || cur.props.title !== a.title || cur.props.entry !== (a.entry || '')
      if (moved || propsChanged) {
        editor.updateShape({
          id: cur.id,
          type: 'artifact',
          x: f.x,
          y: f.y,
          props: { w: f.w, h: f.h, kind: a.kind, title: a.title, entry: a.entry || '' },
        })
      }
    }
  }

  if (newAssets.length) editor.createAssets(newAssets)
  if (newShapes.length) editor.createShapes(newShapes)
  for (const [tileId, s] of existing) {
    if (!seen.has(tileId)) editor.deleteShapes([s.id])
  }

  if (initial) {
    for (const g of doc.groups || []) {
      const ids = g.members.map((m) => createShapeId(m)).filter((id) => editor.getShape(id))
      if (ids.length > 1) {
        try {
          editor.groupShapes(ids)
        } catch {}
      }
    }
    if (doc.viewport && doc.viewport.zoom) editor.setCamera({ x: doc.viewport.x, y: doc.viewport.y, z: doc.viewport.zoom })
    else editor.zoomToFit()
  }
}

const wired = new WeakSet<Editor>()

function onMount(editor: Editor) {
  ;(window as any).__tldrawEditor = editor // dev hook
  void (async () => {
    const doc = await fetchCanvas()
    reconcile(editor, doc, true)
    if (wired.has(editor)) return
    wired.add(editor)

    // canvas -> files: a tile moved/resized -> write its frame.json (debounced)
    const frameTimers = new Map<string, ReturnType<typeof setTimeout>>()
    editor.sideEffects.registerAfterChangeHandler('shape', (_prev, next) => {
      if (next.type !== 'artifact' && next.type !== 'image') return
      const tileId = tileIdOf(next)
      if (!tileId) return
      const frame = { x: Math.round(next.x), y: Math.round(next.y), w: Math.round(next.props.w), h: Math.round(next.props.h) }
      clearTimeout(frameTimers.get(tileId))
      frameTimers.set(
        tileId,
        setTimeout(() => saveFrame(tileId, frame), 250),
      )
    })

    // canvas -> files: persist the viewport so the view survives a refresh
    let camTimer: ReturnType<typeof setTimeout> | null = null
    editor.sideEffects.registerAfterChangeHandler('camera', (_prev, next) => {
      if (camTimer) clearTimeout(camTimer)
      camTimer = setTimeout(() => saveCanvasMeta({ viewport: { x: Math.round(next.x), y: Math.round(next.y), zoom: next.z } }), 500)
    })

    // files -> canvas: when files change (agent scaffolds a tile, edits a frame), sync
    try {
      const es = new EventSource('/api/watch')
      es.onmessage = async () => {
        const fresh = await fetchCanvas()
        reconcile(editor, fresh, false)
      }
    } catch {}
  })()
}

export default function TldrawCanvas() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw shapeUtils={shapeUtils} onMount={onMount} />
    </div>
  )
}
