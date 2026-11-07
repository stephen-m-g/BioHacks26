// Offline sample data for /teach/demo, so the canvas can be tried without Supabase.
import type { Asset, Block, Lecture, Session } from '../types'

const svg = (body: string, w = 800, h = 600) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`,
  )

const MITO = svg(`
  <ellipse cx="400" cy="300" rx="330" ry="170" fill="#fde68a" stroke="#92400e" stroke-width="8"/>
  <ellipse cx="400" cy="300" rx="300" ry="142" fill="#fef3c7" stroke="#b45309" stroke-width="5"/>
  <path d="M150 300 q25 -110 50 0 q25 110 50 0 q25 -110 50 0 q25 110 50 0 q25 -110 50 0 q25 110 50 0 q25 -110 50 0 q25 110 50 0 q25 -110 50 0 q25 110 50 0" fill="none" stroke="#b45309" stroke-width="6"/>
  <text x="400" y="560" font-family="sans-serif" font-size="34" text-anchor="middle" fill="#333">Mitochondrion</text>`)

const CELL = svg(`
  <circle cx="400" cy="300" r="250" fill="#dcfce7" stroke="#166534" stroke-width="8"/>
  <circle cx="380" cy="280" r="80" fill="#bbf7d0" stroke="#14532d" stroke-width="6"/>
  <ellipse cx="560" cy="380" rx="60" ry="30" fill="#fde68a" stroke="#92400e" stroke-width="4"/>
  <ellipse cx="250" cy="420" rx="55" ry="28" fill="#fde68a" stroke="#92400e" stroke-width="4"/>
  <text x="400" y="585" font-family="sans-serif" font-size="34" text-anchor="middle" fill="#333">Animal cell</text>`)

const ETC = svg(`
  <rect x="40" y="250" width="720" height="100" fill="#e0e7ff" stroke="#3730a3" stroke-width="6"/>
  <rect x="100" y="220" width="90" height="160" rx="16" fill="#a5b4fc"/>
  <rect x="260" y="220" width="90" height="160" rx="16" fill="#a5b4fc"/>
  <rect x="420" y="220" width="90" height="160" rx="16" fill="#a5b4fc"/>
  <rect x="580" y="200" width="120" height="200" rx="20" fill="#818cf8"/>
  <text x="400" y="120" font-family="sans-serif" font-size="34" text-anchor="middle" fill="#333">Electron transport chain</text>
  <text x="640" y="450" font-family="sans-serif" font-size="26" text-anchor="middle" fill="#333">ATP synthase</text>`)

export const DEMO_SESSION_ID = 'demo'

export function demoData() {
  const t = new Date().toISOString()
  const lecture: Lecture = { id: 'demo-lecture', title: 'Cellular respiration (demo)', archived_at: null, created_at: t }
  const session: Session = {
    id: DEMO_SESSION_ID,
    lecture_id: lecture.id,
    title: lecture.title,
    status: 'live',
    started_at: t,
    ended_at: null,
  }
  const mkAsset = (id: string, label: string, url: string): Asset => ({
    id,
    lecture_id: lecture.id,
    kind: 'image',
    storage_path: url,
    text_content: null,
    file_name: `${id}.svg`,
    label,
    description: null,
    key_terms: null,
    created_at: t,
  })
  const assets = [
    mkAsset('demo-mito', 'Mitochondrion', MITO),
    mkAsset('demo-cell', 'Animal cell', CELL),
    mkAsset('demo-etc', 'Electron transport chain', ETC),
  ]
  const blocks: Block[] = [
    {
      id: 'demo-b1',
      session_id: session.id,
      kind: 'text',
      position: 1,
      text: 'Today we are looking at cellular respiration, the way cells turn glucose into usable energy in the form of ATP.',
      asset_id: null,
      aspect: null,
      created_at: t,
    },
    {
      id: 'demo-b2',
      session_id: session.id,
      kind: 'image',
      position: 2,
      text: null,
      asset_id: 'demo-mito',
      aspect: 4 / 3,
      created_at: t,
    },
  ]
  return {
    session,
    lecture,
    assets: Object.fromEntries(assets.map((a) => [a.id, a])),
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
  }
}
