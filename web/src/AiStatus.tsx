import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from './api'
import { Badge, Btn } from './ui'

type Status = { installed: boolean; signed_in: boolean; detail: string | null }

export function useAiStatus() {
  return useQuery({ queryKey: ['llm'], queryFn: () => api<Status>('/api/llm/status'), refetchInterval: (q) => (q.state.data?.signed_in ? false : 20_000) })
}

/** Where AI text comes from, and a way to sign in when it can't be produced. */
export function AiStatus() {
  const s = useAiStatus()
  const signin = useMutation({ mutationFn: () => api('/api/llm/signin', {}) })
  const recheck = useMutation({ mutationFn: () => api<Status>('/api/llm/status?force=true'), onSuccess: () => s.refetch() })
  if (!s.data) return <Badge>Checking Claude…</Badge>
  if (s.data.signed_in) return <Badge tone="bull">Claude connected</Badge>
  return <span className="flex items-center gap-2">
    <Badge tone="warn">{s.data.detail}</Badge>
    {s.data.installed && <Btn kind="ghost" onClick={() => signin.mutate()}>Sign in</Btn>}
    <Btn kind="ghost" onClick={() => recheck.mutate()} disabled={recheck.isPending}>Recheck</Btn>
  </span>
}
