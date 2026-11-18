import { useQuery } from '@tanstack/react-query'
import { BarChart3, Brain, FileText, Film, FlaskConical, Globe, GraduationCap, Music2, Target, TrendingUp, Youtube, type LucideIcon } from 'lucide-react'
import { api } from './api'
import { useSettings } from './store'

export type Cat = 'strategy' | 'pattern' | 'skill' | 'condition' | 'source' | 'research'
export type KNode = { id: number; title: string; category: Cat; summary: string; verification: string; sources: number; origin: string | null }
export type KEdge = { id: number; src: number; dst: number; rel: string; explanation: string }
export type Graph = { nodes: KNode[]; edges: KEdge[]; layout: Record<string, { x: number; y: number }>
  stats: { knowledge: number; strategies: number; patterns: number; skills: number; conditions: number; research: number; sources: number } }
export type Source = { id: number; url: string; platform: string; title: string; author: string | null; published: string | null; status: string; complete: boolean
  note: string | null; content_chars: number; imported_at: number; concepts: number; node_id: number | null; claims: string[] | null; main_topic: string | null; analysis_id: number | null; has_audio: boolean | null; content_kind: string | null }
export type Job = { id: number; url: string; status: string; stage: string; steps: { name: string; done: boolean; skipped?: boolean; detail: string }[]; error: string | null
  result: { new_concepts: number; updated_concepts: number; new_connections: number } | null; source_id: number | null; started_at: number; completed_at: number | null }

/** One colour per category, everywhere in the Brain (graph, badges, lists). Light theme uses deeper shades for contrast. */
const COLORS: Record<'dark' | 'light', Record<Cat | 'ai', string>> = {
  dark: { ai: '#A855F7', strategy: '#8B5CF6', pattern: '#3B82F6', skill: '#22D3EE', condition: '#F97316', source: '#EAB308', research: '#6366F1' },
  light: { ai: '#9333EA', strategy: '#7C3AED', pattern: '#2563EB', skill: '#0891B2', condition: '#EA580C', source: '#CA8A04', research: '#4F46E5' },
}
export const useColors = () => COLORS[useSettings((s) => s.theme)]

export const CATS: [Cat, string, string, LucideIcon][] = [
  ['strategy', 'Strategies', 'Strategy', Target], ['pattern', 'Patterns', 'Pattern', BarChart3], ['skill', 'Skills', 'Skill', GraduationCap],
  ['condition', 'Market Conditions', 'Market Condition', TrendingUp], ['research', 'Research', 'Research', FlaskConical], ['source', 'Sources', 'Source', Globe],
]
export const catLabel = (c: string) => CATS.find((x) => x[0] === c)?.[2] ?? c
export const catIcon = (c: string): LucideIcon => CATS.find((x) => x[0] === c)?.[3] ?? Brain

export const platformIcon = (p: string): LucideIcon => (p === 'youtube' ? Youtube : p === 'tiktok' ? Music2 : p === 'article' ? FileText : p === 'video' ? Film : Globe)
export const platformColor = (p: string) => (p === 'youtube' ? '#EF4444' : p === 'tiktok' ? 'var(--text)' : 'var(--text-2)')

export const VERIFY: Record<string, [string, string]> = {
  'built-in rule': ['Built-in rule', 'How VANTAGE TRADE\'s own engine detects or runs this.'],
  tested: ['Tested', 'Evaluated on historical data in this app\'s backtester.'],
  corroborated: ['Corroborated', 'Explained the same way by two or more independent sources. Not proof of profitability.'],
  imported: ['Imported', 'What one outside source says. Not verified.'],
  disputed: ['Disputed', 'Sources disagree. Both claims are kept.'],
}

export const ago = (t: number | null | undefined) => {
  if (!t) return '—'
  const s = Date.now() / 1000 - t
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}

/** YouTube links jump to the cited moment; nothing is added when the source gave no timestamp. */
export const withTime = (url: string, ts: string | null) => {
  if (!ts || !url.includes('youtube.com/watch')) return url
  const sec = ts.split(':').reduce((a, x) => a * 60 + Number(x), 0)
  return `${url}&t=${sec}s`
}

export const useGraph = () => useQuery({ queryKey: ['brain', 'graph'], queryFn: () => api<Graph>('/api/brain/graph') })
export const useSources = () => useQuery({ queryKey: ['brain', 'sources'], queryFn: () => api<Source[]>('/api/brain/sources') })
